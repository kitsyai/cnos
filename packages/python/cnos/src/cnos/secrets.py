"""Local vault decryption + session key decryption — mirrors Go's secrets.go."""
from __future__ import annotations

import base64
import getpass
import hashlib
import json
import os
import struct
import sys
from typing import Any, Dict, Optional, Tuple

from cnos.errors import CnosError
from cnos.env import Environment
from cnos.types import VaultDefinition

KEY_LENGTH = 32
KEYSTORE_VERSION = 1
IV_LENGTH = 12
AUTH_TAG_LENGTH = 16
DEFAULT_SECRET_DIR = "~/.cnos/secrets"


# ---------------------------------------------------------------------------
# Secret home resolution
# ---------------------------------------------------------------------------

def resolve_secret_home(env: Environment, override: str = "") -> str:
    if override:
        return _expand_home_path(override)
    value, found = env.get("CNOS_SECRET_HOME")
    if found and value:
        return _expand_home_path(value)
    return _expand_home_path(DEFAULT_SECRET_DIR)


def _expand_home_path(value: str) -> str:
    if value == "~":
        return os.path.expanduser("~")
    if value.startswith("~/"):
        return os.path.join(os.path.expanduser("~"), value[2:])
    return os.path.abspath(value)


# ---------------------------------------------------------------------------
# Session-encrypted payload
# ---------------------------------------------------------------------------

def decrypt_secret_payload_from_env(env: Environment) -> Optional[Dict[str, Any]]:
    """Decrypt __CNOS_SECRET_PAYLOAD__ using __CNOS_SESSION_KEY__."""
    serialized, ok = env.get("__CNOS_SECRET_PAYLOAD__")
    if not ok or not serialized:
        return None
    session_key_hex, ok = env.get("__CNOS_SESSION_KEY__")
    if not ok or not session_key_hex:
        return None

    try:
        key = bytes.fromhex(session_key_hex)
    except ValueError:
        raise CnosError("cnos: invalid session key for encrypted secret payload")
    if len(key) != KEY_LENGTH:
        raise CnosError("cnos: invalid session key for encrypted secret payload")

    try:
        payload = json.loads(serialized)
    except (json.JSONDecodeError, ValueError) as exc:
        raise CnosError(f"cnos: parse encrypted secret payload: {exc}") from exc

    plaintext = _decrypt_json_payload(payload, key)
    try:
        result = json.loads(plaintext)
    except (json.JSONDecodeError, ValueError) as exc:
        raise CnosError(f"cnos: decode encrypted secret payload: {exc}") from exc

    if not isinstance(result, dict):
        raise CnosError("cnos: decode encrypted secret payload: expected object")
    return result


def _decrypt_json_payload(payload: Dict[str, Any], key: bytes) -> bytes:
    """AES-256-GCM decrypt. payload has iv, tag, ciphertext (base64)."""
    try:
        iv = base64.b64decode(payload["iv"])
        tag = base64.b64decode(payload["tag"])
        ciphertext = base64.b64decode(payload["ciphertext"])
    except (KeyError, Exception) as exc:
        raise CnosError(f"cnos: decode AES payload: {exc}") from exc

    combined = ciphertext + tag
    try:
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
        aesgcm = AESGCM(key)
        return aesgcm.decrypt(iv, combined, None)
    except Exception as exc:
        raise CnosError(f"cnos: AES-GCM decryption failed: {exc}") from exc


# ---------------------------------------------------------------------------
# Local vault
# ---------------------------------------------------------------------------

def read_local_vault_secrets(
    secret_home: str,
    vault: str,
    definition: Optional[VaultDefinition],
    env: Environment,
) -> Dict[str, str]:
    meta_path = os.path.join(secret_home, "vaults", vault, "meta.yml")
    try:
        with open(meta_path, "rb") as f:
            meta_bytes = f.read()
    except OSError:
        raise CnosError(f'cnos: missing CNOS vault metadata for "{vault}"')

    meta = _parse_local_vault_metadata(meta_bytes)
    key = _resolve_local_vault_key(secret_home, vault, meta, definition, env)

    keystore_path = os.path.join(secret_home, "vaults", vault, "keystore.enc")
    try:
        with open(keystore_path, "rb") as f:
            buffer = f.read()
    except OSError as exc:
        raise CnosError(f'cnos: read local vault keystore for "{vault}": {exc}') from exc

    payload = _decrypt_local_vault_payload(buffer, key, vault)
    return payload.get("secrets") or {}


def _parse_local_vault_metadata(data: bytes) -> Dict[str, Any]:
    values: Dict[str, str] = {}
    for raw in data.decode("utf-8", errors="replace").split("\n"):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if ":" not in line:
            continue
        k, _, v = line.partition(":")
        values[k.strip()] = v.strip().strip("\"'")

    try:
        version = int(values.get("version", "0"))
        iterations = int(values.get("iterations", "0"))
    except ValueError:
        raise CnosError("cnos: invalid CNOS vault metadata")

    algorithm = values.get("algorithm", "")
    kdf = values.get("kdf", "")
    salt = values.get("salt", "")

    if version != 1 or algorithm != "aes-256-gcm" or kdf != "pbkdf2-sha512" or not salt:
        raise CnosError("cnos: invalid CNOS vault metadata")

    return {
        "version": version,
        "algorithm": algorithm,
        "kdf": kdf,
        "iterations": iterations,
        "salt": salt,
    }


def _resolve_local_vault_key(
    secret_home: str,
    vault: str,
    meta: Dict[str, Any],
    definition: Optional[VaultDefinition],
    env: Environment,
) -> bytes:
    # 1. Pre-derived key from env
    key, ok = _decode_derived_key(env, _get_vault_session_key_env_var(vault))
    if ok:
        return key  # type: ignore[return-value]

    # 2. Session key file
    session_path = os.path.join(secret_home, "sessions", vault + ".json")
    key, ok = _read_session_key_file(session_path)
    if ok:
        return key  # type: ignore[return-value]

    # 3. Auth sources from definition
    for source in _resolve_local_vault_auth_sources(vault, definition):
        if source.startswith("env:"):
            env_var = source[4:]
            passphrase, found = env.get(env_var)
            if found and passphrase:
                return _derive_local_vault_key(passphrase, vault, meta)
        elif source.startswith("keychain:"):
            service = source[9:]
            encoded, found = _read_keychain(service)
            if found and encoded:
                try:
                    k = bytes.fromhex(encoded)
                    if len(k) == KEY_LENGTH:
                        return k
                except ValueError:
                    pass
        elif source == "prompt":
            if sys.stdin.isatty():
                try:
                    passphrase = getpass.getpass(f'Enter passphrase for vault "{vault}": ')
                    if passphrase:
                        return _derive_local_vault_key(passphrase, vault, meta)
                except (EOFError, KeyboardInterrupt):
                    pass

    # 4. Fallback env vars
    passphrase, found = _resolve_vault_passphrase(vault, env)
    if found and passphrase:
        return _derive_local_vault_key(passphrase, vault, meta)

    sources = [_get_vault_session_key_env_var(vault)] + _resolve_local_vault_auth_sources(vault, definition)
    raise CnosError(
        f'cnos: cannot authenticate to vault "{vault}". '
        f'Tried: {", ".join(sources)}. '
        f'Set {_get_vault_passphrase_env_var(vault)} or run cnos vault auth {vault}'
    )


def _decode_derived_key(env: Environment, variable: str) -> Tuple[Optional[bytes], bool]:
    value, ok = env.get(variable)
    if not ok or not value:
        return None, False
    try:
        key = bytes.fromhex(value)
        if len(key) == KEY_LENGTH:
            return key, True
    except ValueError:
        pass
    return None, False


def _read_session_key_file(path: str) -> Tuple[Optional[bytes], bool]:
    try:
        with open(path, "rb") as f:
            data = f.read()
    except OSError:
        return None, False
    try:
        doc = json.loads(data)
    except (json.JSONDecodeError, ValueError):
        return None, False
    if doc.get("version") != 1 or not doc.get("derivedKey"):
        return None, False
    try:
        key = bytes.fromhex(doc["derivedKey"])
        if len(key) == KEY_LENGTH:
            return key, True
    except ValueError:
        pass
    return None, False


def _resolve_vault_passphrase(vault: str, env: Environment) -> Tuple[Optional[str], bool]:
    specific, found = env.get(_get_vault_passphrase_env_var(vault))
    if found and specific:
        return specific, True
    fallback, found = env.get("CNOS_SECRET_PASSPHRASE")
    if found and fallback:
        return fallback, True
    return None, False


def _get_vault_passphrase_env_var(vault: str) -> str:
    token = normalize_vault_token(vault)
    if token and token != "DEFAULT":
        return f"CNOS_SECRET_PASSPHRASE_{token}"
    return "CNOS_SECRET_PASSPHRASE"


def _get_vault_session_key_env_var(vault: str) -> str:
    token = normalize_vault_token(vault) or "DEFAULT"
    return f"__CNOS_VAULT_KEY_{token}__"


def normalize_vault_token(vault: str) -> str:
    vault = vault.strip()
    parts: list = []
    last_underscore = False
    for ch in vault:
        if "a" <= ch <= "z":
            parts.append(ch.upper())
            last_underscore = False
        elif ("A" <= ch <= "Z") or ("0" <= ch <= "9"):
            parts.append(ch)
            last_underscore = False
        else:
            if not last_underscore:
                parts.append("_")
                last_underscore = True
    result = "".join(parts).strip("_")
    return result


def _resolve_local_vault_auth_sources(
    vault: str, definition: Optional[VaultDefinition]
) -> list:
    if (
        definition is not None
        and definition.auth.passphrase is not None
        and definition.auth.passphrase.from_
    ):
        return list(definition.auth.passphrase.from_)

    token = normalize_vault_token(vault)
    sources = []
    if token:
        sources.append(f"env:CNOS_SECRET_PASSPHRASE_{token}")
    sources.append("env:CNOS_SECRET_PASSPHRASE")
    sources.append(f"keychain:cnos/{vault}")
    sources.append("prompt")
    return sources


def _derive_local_vault_key(passphrase: str, vault: str, meta: Dict[str, Any]) -> bytes:
    try:
        salt = base64.b64decode(meta["salt"])
    except Exception as exc:
        raise CnosError(f'cnos: invalid salt for local vault "{vault}"') from exc
    return pbkdf2_sha512(passphrase.encode("utf-8"), salt, meta["iterations"], KEY_LENGTH)


def pbkdf2_sha512(password: bytes, salt: bytes, iterations: int, key_len: int) -> bytes:
    """Pure-Python PBKDF2-HMAC-SHA512 (mirrors Go's pbkdf2SHA512)."""
    return hashlib.pbkdf2_hmac("sha512", password, salt, iterations, dklen=key_len)


def _decrypt_local_vault_payload(buffer: bytes, key: bytes, vault: str) -> Dict[str, Any]:
    min_len = 4 + IV_LENGTH + AUTH_TAG_LENGTH
    if len(buffer) < min_len:
        raise CnosError("cnos: invalid CNOS local vault keystore")

    version = struct.unpack_from("<I", buffer, 0)[0]
    if version != KEYSTORE_VERSION:
        raise CnosError(f"cnos: unsupported CNOS local vault keystore version: {version}")

    iv_start = 4
    tag_start = iv_start + IV_LENGTH
    ct_start = tag_start + AUTH_TAG_LENGTH

    payload = {
        "iv": base64.b64encode(buffer[iv_start:tag_start]).decode(),
        "tag": base64.b64encode(buffer[tag_start:ct_start]).decode(),
        "ciphertext": base64.b64encode(buffer[ct_start:]).decode(),
    }

    try:
        plaintext = _decrypt_json_payload(payload, key)
    except CnosError:
        raise CnosError(
            "cnos: failed to decrypt CNOS local vault. Check vault authentication"
        )

    try:
        decoded = json.loads(plaintext)
    except (json.JSONDecodeError, ValueError):
        raise CnosError(
            "cnos: failed to decrypt CNOS local vault. Check vault authentication"
        )

    if not isinstance(decoded, dict) or "secrets" not in decoded:
        raise CnosError(
            "cnos: failed to decrypt CNOS local vault. Check vault authentication"
        )
    return decoded


def _is_secret_reference_value(value: Any) -> bool:
    """Mirror Go's isSecretReferenceValue()."""
    if not isinstance(value, dict):
        return False
    provider = value.get("provider", "")
    ref = value.get("ref", "")
    if not isinstance(ref, str) or not ref.strip():
        return False
    if isinstance(provider, str) and not provider.strip() and "provider" in value:
        return False
    for key in value:
        if key not in ("provider", "ref", "vault"):
            return False
    return True


def _to_secret_reference(value: Any) -> "SecretReference":
    """Mirror Go's toSecretReference()."""
    from cnos.types import SecretReference
    if not isinstance(value, dict):
        raise CnosError("cnos: invalid secret reference")
    provider = (value.get("provider") or "").strip()
    ref = (value.get("ref") or "").strip()
    vault = (value.get("vault") or "").strip()
    if not ref:
        raise CnosError("cnos: invalid secret reference")
    return SecretReference(ref=ref, provider=provider, vault=vault)


def _read_keychain(service: str) -> Tuple[Optional[str], bool]:
    """Try to read from the system keychain using the `keyring` library."""
    try:
        import keyring  # type: ignore[import]
        parts = service.split("/", 1)
        if len(parts) == 2:
            namespace, username = parts
        else:
            namespace, username = "cnos", service
        value = keyring.get_password(namespace, username)
        if value:
            return value, True
    except (ImportError, Exception):
        pass
    return None, False


# ---------------------------------------------------------------------------
# Vault auth resolution
# ---------------------------------------------------------------------------

def resolve_vault_auth(
    vault_id: str,
    definition: VaultDefinition,
    env: Environment,
) -> Any:
    """Resolve in-memory auth material for a vault. Returns VaultAuthConfig."""
    from cnos.types import VaultAuthConfig

    method = (definition.auth.method or "").strip()
    if not method:
        method = _default_vault_method(definition.provider)

    config = dict(definition.auth.config or {})

    if method in ("iam", "environment"):
        return VaultAuthConfig(method=method, config=config)

    if method == "token":
        token, ok = _resolve_first_vault_source(definition.auth.token, env)
        if not ok:
            raise CnosError(_vault_auth_error_msg(vault_id, definition.auth.token))
        return VaultAuthConfig(method="token", token=token, config=config)

    # Try token sources
    if definition.auth.token and definition.auth.token.from_:
        token, ok = _resolve_first_vault_source(definition.auth.token, env)
        if ok:
            return VaultAuthConfig(method="token", token=token, config=config)

    # Try passphrase sources
    if definition.auth.passphrase and definition.auth.passphrase.from_:
        passphrase, ok = _resolve_first_vault_source(definition.auth.passphrase, env)
        if ok:
            return VaultAuthConfig(method="passphrase", passphrase=passphrase, config=config)
        raise CnosError(_vault_auth_error_msg(vault_id, definition.auth.passphrase))

    # Generic env passphrase fallback
    passphrase, found = _resolve_vault_passphrase(vault_id, env)
    if found and passphrase:
        return VaultAuthConfig(method="passphrase", passphrase=passphrase, config=config)

    return VaultAuthConfig(method=method, config=config)


def _default_vault_method(provider: str) -> str:
    if provider == "local":
        return "passphrase"
    if provider in ("github-secrets", "environment"):
        return "environment"
    return ""


def _resolve_first_vault_source(
    source: Optional[Any], env: Environment
) -> Tuple[str, bool]:
    if source is None:
        return "", False
    from_list = getattr(source, "from_", None) or []
    for candidate in from_list:
        value, ok = _resolve_vault_source(candidate.strip(), env)
        if ok:
            return value, True
    return "", False


def _resolve_vault_source(source: str, env: Environment) -> Tuple[str, bool]:
    if source.startswith("env:"):
        value, ok = env.get(source[4:])
        if ok and value and value.strip():
            return value.strip(), True
        return "", False
    if source.startswith("file:"):
        path = _expand_home_path(source[5:])
        try:
            with open(path) as f:
                content = f.read().strip()
            if content:
                return content, True
        except OSError:
            pass
        return "", False
    if source.startswith("keychain:"):
        service = source[9:]
        value, ok = _read_keychain(service)
        if ok and value:
            return value, True
        return "", False
    return "", False


def _vault_auth_error_msg(vault_id: str, source: Optional[Any]) -> str:
    sources = []
    if source is not None:
        sources = list(getattr(source, "from_", None) or [])
    return f'cnos: cannot authenticate to vault "{vault_id}". Tried: {", ".join(sources)}'

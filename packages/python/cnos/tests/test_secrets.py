"""Tests for PBKDF2 key derivation, AES-256-GCM decryption, and session decrypt."""
from __future__ import annotations

import base64
import hashlib
import json
import os
import struct

import pytest

from cnos.errors import CnosError
from cnos.secrets import (
    KEY_LENGTH,
    IV_LENGTH,
    AUTH_TAG_LENGTH,
    KEYSTORE_VERSION,
    decrypt_secret_payload_from_env,
    normalize_vault_token,
    pbkdf2_sha512,
    _decrypt_json_payload,
    _decrypt_local_vault_payload,
    _get_vault_passphrase_env_var,
    _get_vault_session_key_env_var,
)
from cnos.env import Environment


# ---------------------------------------------------------------------------
# PBKDF2-SHA512 key derivation
# ---------------------------------------------------------------------------

class TestPbkdf2:
    def test_known_vector(self):
        """Verify against stdlib hashlib which is the canonical PBKDF2 reference."""
        password = b"passphrase"
        salt = b"salt1234"
        iterations = 100_000
        key_len = 32

        expected = hashlib.pbkdf2_hmac("sha512", password, salt, iterations, dklen=key_len)
        result = pbkdf2_sha512(password, salt, iterations, key_len)
        assert result == expected

    def test_output_length(self):
        key = pbkdf2_sha512(b"pass", b"salt", 1000, 32)
        assert len(key) == 32

    def test_different_passwords_produce_different_keys(self):
        k1 = pbkdf2_sha512(b"pass1", b"salt", 1000, 32)
        k2 = pbkdf2_sha512(b"pass2", b"salt", 1000, 32)
        assert k1 != k2

    def test_different_salts_produce_different_keys(self):
        k1 = pbkdf2_sha512(b"pass", b"salt1", 1000, 32)
        k2 = pbkdf2_sha512(b"pass", b"salt2", 1000, 32)
        assert k1 != k2


# ---------------------------------------------------------------------------
# AES-256-GCM decryption helpers
# ---------------------------------------------------------------------------

def _encrypt_aes_gcm(key: bytes, iv: bytes, plaintext: bytes):
    """Helper: encrypt bytes with AES-256-GCM, return (ciphertext, tag)."""
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    aesgcm = AESGCM(key)
    combined = aesgcm.encrypt(iv, plaintext, None)
    ciphertext = combined[:-16]
    tag = combined[-16:]
    return ciphertext, tag


class TestAesGcmDecrypt:
    def test_roundtrip(self):
        key = os.urandom(32)
        iv = os.urandom(12)
        plaintext = b'{"secrets": {"db_password": "hunter2"}}'
        ciphertext, tag = _encrypt_aes_gcm(key, iv, plaintext)

        payload = {
            "iv": base64.b64encode(iv).decode(),
            "tag": base64.b64encode(tag).decode(),
            "ciphertext": base64.b64encode(ciphertext).decode(),
        }
        result = _decrypt_json_payload(payload, key)
        assert result == plaintext

    def test_wrong_key_raises(self):
        key = os.urandom(32)
        wrong_key = os.urandom(32)
        iv = os.urandom(12)
        ciphertext, tag = _encrypt_aes_gcm(key, iv, b"secret data")

        payload = {
            "iv": base64.b64encode(iv).decode(),
            "tag": base64.b64encode(tag).decode(),
            "ciphertext": base64.b64encode(ciphertext).decode(),
        }
        with pytest.raises(CnosError):
            _decrypt_json_payload(payload, wrong_key)

    def test_tampered_ciphertext_raises(self):
        key = os.urandom(32)
        iv = os.urandom(12)
        ciphertext, tag = _encrypt_aes_gcm(key, iv, b"original")
        tampered = bytes([ciphertext[0] ^ 0xFF]) + ciphertext[1:]

        payload = {
            "iv": base64.b64encode(iv).decode(),
            "tag": base64.b64encode(tag).decode(),
            "ciphertext": base64.b64encode(tampered).decode(),
        }
        with pytest.raises(CnosError):
            _decrypt_json_payload(payload, key)


# ---------------------------------------------------------------------------
# Keystore binary format
# ---------------------------------------------------------------------------

def _make_keystore(key: bytes, plaintext: bytes) -> bytes:
    """Build a valid keystore.enc binary buffer."""
    iv = os.urandom(IV_LENGTH)
    ciphertext, tag = _encrypt_aes_gcm(key, iv, plaintext)
    version_bytes = struct.pack("<I", KEYSTORE_VERSION)
    return version_bytes + iv + tag + ciphertext


class TestKeystoreFormat:
    def test_roundtrip(self):
        key = os.urandom(32)
        secrets = {"api_key": "secret123", "db_pass": "pass456"}
        plaintext = json.dumps({"secrets": secrets}).encode()
        buffer = _make_keystore(key, plaintext)

        result = _decrypt_local_vault_payload(buffer, key, "testvault")
        assert result["secrets"] == secrets

    def test_too_short_raises(self):
        with pytest.raises(CnosError, match="invalid CNOS local vault keystore"):
            _decrypt_local_vault_payload(b"\x00" * 10, b"\x00" * 32, "v")

    def test_wrong_version_raises(self):
        key = os.urandom(32)
        iv = os.urandom(IV_LENGTH)
        ciphertext, tag = _encrypt_aes_gcm(key, iv, b"{}")
        # Write version=99
        buffer = struct.pack("<I", 99) + iv + tag + ciphertext
        with pytest.raises(CnosError, match="unsupported CNOS local vault keystore version"):
            _decrypt_local_vault_payload(buffer, key, "v")

    def test_wrong_key_raises(self):
        key = os.urandom(32)
        wrong_key = os.urandom(32)
        plaintext = json.dumps({"secrets": {}}).encode()
        buffer = _make_keystore(key, plaintext)
        with pytest.raises(CnosError, match="failed to decrypt"):
            _decrypt_local_vault_payload(buffer, wrong_key, "v")


# ---------------------------------------------------------------------------
# Session decrypt from env
# ---------------------------------------------------------------------------

class TestSessionDecrypt:
    def test_decrypt_secret_payload(self):
        key = os.urandom(32)
        iv = os.urandom(12)
        secrets = {"secret.db.password": "supersecret"}
        plaintext = json.dumps(secrets).encode()
        ciphertext, tag = _encrypt_aes_gcm(key, iv, plaintext)

        env = Environment({
            "__CNOS_SESSION_KEY__": key.hex(),
            "__CNOS_SECRET_PAYLOAD__": json.dumps({
                "iv": base64.b64encode(iv).decode(),
                "tag": base64.b64encode(tag).decode(),
                "ciphertext": base64.b64encode(ciphertext).decode(),
            }),
        })
        result = decrypt_secret_payload_from_env(env)
        assert result == secrets

    def test_missing_session_key_returns_none(self):
        env = Environment({"__CNOS_SECRET_PAYLOAD__": '{"iv":"x","tag":"y","ciphertext":"z"}'})
        result = decrypt_secret_payload_from_env(env)
        assert result is None

    def test_missing_payload_returns_none(self):
        env = Environment({"__CNOS_SESSION_KEY__": "aa" * 32})
        result = decrypt_secret_payload_from_env(env)
        assert result is None

    def test_invalid_key_hex_raises(self):
        env = Environment({
            "__CNOS_SESSION_KEY__": "not-hex",
            "__CNOS_SECRET_PAYLOAD__": '{"iv":"x","tag":"y","ciphertext":"z"}',
        })
        with pytest.raises(CnosError, match="invalid session key"):
            decrypt_secret_payload_from_env(env)


# ---------------------------------------------------------------------------
# normalize_vault_token and env var naming
# ---------------------------------------------------------------------------

class TestNormalizeVaultToken:
    def test_simple(self):
        assert normalize_vault_token("default") == "DEFAULT"

    def test_hyphen_becomes_underscore(self):
        assert normalize_vault_token("my-vault") == "MY_VAULT"

    def test_space_becomes_underscore(self):
        assert normalize_vault_token("my vault") == "MY_VAULT"

    def test_already_upper(self):
        assert normalize_vault_token("PROD") == "PROD"

    def test_collapses_multiple_separators(self):
        assert normalize_vault_token("a--b") == "A_B"

    def test_passphrase_env_var_default(self):
        assert _get_vault_passphrase_env_var("default") == "CNOS_SECRET_PASSPHRASE"

    def test_passphrase_env_var_named(self):
        assert _get_vault_passphrase_env_var("prod") == "CNOS_SECRET_PASSPHRASE_PROD"

    def test_session_key_env_var(self):
        assert _get_vault_session_key_env_var("prod") == "__CNOS_VAULT_KEY_PROD__"

    def test_session_key_env_var_default(self):
        assert _get_vault_session_key_env_var("default") == "__CNOS_VAULT_KEY_DEFAULT__"

package cnos

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/sha512"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

const (
	keyLength        = 32
	keystoreVersion  = 1
	ivLength         = 12
	authTagLength    = 16
	defaultSecretDir = "~/.cnos/secrets"
)

type localVaultMetadata struct {
	Version    int
	Algorithm  string
	KDF        string
	Iterations int
	Salt       string
}

type localVaultPayload struct {
	Secrets map[string]string `json:"secrets"`
}

type encryptedSecretPayload struct {
	IV         string `json:"iv"`
	Tag        string `json:"tag"`
	Ciphertext string `json:"ciphertext"`
}

type sessionDocument struct {
	Version    int    `json:"version"`
	DerivedKey string `json:"derivedKey"`
}

func resolveSecretHome(env environment, override string) (string, error) {
	if override != "" {
		return expandHomePath(override)
	}
	if value, ok := env.Get("CNOS_SECRET_HOME"); ok && value != "" {
		return expandHomePath(value)
	}
	return expandHomePath(defaultSecretDir)
}

func expandHomePath(value string) (string, error) {
	if !strings.HasPrefix(value, "~/") && value != "~" {
		return filepath.Abs(value)
	}

	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	if value == "~" {
		return home, nil
	}
	return filepath.Join(home, strings.TrimPrefix(value, "~/")), nil
}

func decryptSecretPayloadFromEnv(env environment) (map[string]any, error) {
	serialized, ok := env.Get(SecretPayloadEnvVar)
	if !ok || serialized == "" {
		return nil, nil
	}

	sessionKeyHex, ok := env.Get(SessionKeyEnvVar)
	if !ok || sessionKeyHex == "" {
		return nil, nil
	}

	key, err := hex.DecodeString(sessionKeyHex)
	if err != nil || len(key) != keyLength {
		return nil, fmt.Errorf("cnos: invalid session key for encrypted secret payload")
	}

	var payload encryptedSecretPayload
	if err := json.Unmarshal([]byte(serialized), &payload); err != nil {
		return nil, fmt.Errorf("cnos: parse encrypted secret payload: %w", err)
	}

	values, err := decryptJSONPayload(payload, key)
	if err != nil {
		return nil, err
	}

	result := map[string]any{}
	if err := json.Unmarshal(values, &result); err != nil {
		return nil, fmt.Errorf("cnos: decode encrypted secret payload: %w", err)
	}
	return result, nil
}

func readLocalVaultSecrets(secretHome, vault string, definition *vaultDefinition, env environment) (map[string]string, error) {
	metaPath := filepath.Join(secretHome, "vaults", vault, "meta.yml")
	metaBytes, err := os.ReadFile(metaPath)
	if err != nil {
		return nil, fmt.Errorf("cnos: missing CNOS vault metadata for %q", vault)
	}

	meta, err := parseLocalVaultMetadata(metaBytes)
	if err != nil {
		return nil, err
	}

	key, err := resolveLocalVaultKey(secretHome, vault, meta, definition, env)
	if err != nil {
		return nil, err
	}

	keystorePath := filepath.Join(secretHome, "vaults", vault, "keystore.enc")
	buffer, err := os.ReadFile(keystorePath)
	if err != nil {
		return nil, fmt.Errorf("cnos: read local vault keystore for %q: %w", vault, err)
	}

	payload, err := decryptLocalVaultPayload(buffer, key, meta)
	if err != nil {
		return nil, err
	}

	return payload.Secrets, nil
}

func resolveLocalVaultKey(secretHome, vault string, meta localVaultMetadata, definition *vaultDefinition, env environment) ([]byte, error) {
	if key, ok := decodeDerivedKey(env, getVaultSessionKeyEnvVar(vault)); ok {
		return key, nil
	}

	sessionPath := filepath.Join(secretHome, "sessions", vault+".json")
	if key, ok := readSessionKeyFile(sessionPath); ok {
		return key, nil
	}

	for _, source := range resolveLocalVaultAuthSources(vault, definition) {
		switch {
		case strings.HasPrefix(source, "env:"):
			if passphrase, ok := env.Get(strings.TrimPrefix(source, "env:")); ok && passphrase != "" {
				return deriveLocalVaultKey(passphrase, vault, meta)
			}
		case strings.HasPrefix(source, "keychain:"):
			if encoded, ok := readKeychain(strings.TrimPrefix(source, "keychain:"), env); ok {
				key, err := hex.DecodeString(encoded)
				if err == nil && len(key) == keyLength {
					return key, nil
				}
			}
		case source == "prompt":
			if passphrase, ok := promptHidden(fmt.Sprintf("Enter passphrase for vault %q: ", vault), env); ok && passphrase != "" {
				return deriveLocalVaultKey(passphrase, vault, meta)
			}
		}
	}

	if passphrase, ok := resolveVaultPassphrase(vault, env); ok {
		return deriveLocalVaultKey(passphrase, vault, meta)
	}

	sources := append([]string{getVaultSessionKeyEnvVar(vault)}, resolveLocalVaultAuthSources(vault, definition)...)
	return nil, fmt.Errorf("cnos: cannot authenticate to vault %q. Tried: %s. Set %s or run cnos vault auth %s", vault, strings.Join(sources, ", "), getVaultPassphraseEnvVar(vault), vault)
}

func decodeDerivedKey(env environment, variable string) ([]byte, bool) {
	value, ok := env.Get(variable)
	if !ok || value == "" {
		return nil, false
	}

	key, err := hex.DecodeString(value)
	if err != nil || len(key) != keyLength {
		return nil, false
	}
	return key, true
}

func readSessionKeyFile(path string) ([]byte, bool) {
	bytes, err := os.ReadFile(path)
	if err != nil {
		return nil, false
	}

	var document sessionDocument
	if err := json.Unmarshal(bytes, &document); err != nil || document.Version != 1 || document.DerivedKey == "" {
		return nil, false
	}

	key, err := hex.DecodeString(document.DerivedKey)
	if err != nil || len(key) != keyLength {
		return nil, false
	}
	return key, true
}

func resolveVaultPassphrase(vault string, env environment) (string, bool) {
	if specific, ok := env.Get(getVaultPassphraseEnvVar(vault)); ok && specific != "" {
		return specific, true
	}
	if fallback, ok := env.Get("CNOS_SECRET_PASSPHRASE"); ok && fallback != "" {
		return fallback, true
	}
	return "", false
}

func getVaultPassphraseEnvVar(vault string) string {
	token := normalizeVaultToken(vault)
	if token != "" && token != "DEFAULT" {
		return "CNOS_SECRET_PASSPHRASE_" + token
	}
	return "CNOS_SECRET_PASSPHRASE"
}

func getVaultSessionKeyEnvVar(vault string) string {
	token := normalizeVaultToken(vault)
	if token == "" {
		token = "DEFAULT"
	}
	return "__CNOS_VAULT_KEY_" + token + "__"
}

func resolveLocalVaultAuthSources(vault string, definition *vaultDefinition) []string {
	if definition != nil && definition.Auth.Passphrase != nil && len(definition.Auth.Passphrase.From) > 0 {
		return append([]string(nil), definition.Auth.Passphrase.From...)
	}

	token := normalizeVaultToken(vault)
	sources := make([]string, 0, 4)
	if token != "" {
		sources = append(sources, "env:CNOS_SECRET_PASSPHRASE_"+token)
	}
	sources = append(sources, "env:CNOS_SECRET_PASSPHRASE")
	sources = append(sources, "keychain:cnos/"+vault, "prompt")
	return sources
}

func deriveLocalVaultKey(passphrase, vault string, meta localVaultMetadata) ([]byte, error) {
	salt, err := base64.StdEncoding.DecodeString(meta.Salt)
	if err != nil {
		return nil, fmt.Errorf("cnos: invalid salt for local vault %q", vault)
	}

	return pbkdf2SHA512([]byte(passphrase), salt, meta.Iterations, keyLength), nil
}

func normalizeVaultToken(vault string) string {
	vault = strings.TrimSpace(vault)
	var builder strings.Builder
	lastUnderscore := false
	for _, char := range vault {
		switch {
		case char >= 'a' && char <= 'z':
			builder.WriteRune(char - 32)
			lastUnderscore = false
		case (char >= 'A' && char <= 'Z') || (char >= '0' && char <= '9'):
			builder.WriteRune(char)
			lastUnderscore = false
		default:
			if !lastUnderscore {
				builder.WriteByte('_')
				lastUnderscore = true
			}
		}
	}
	return strings.Trim(builder.String(), "_")
}

func parseLocalVaultMetadata(data []byte) (localVaultMetadata, error) {
	values := map[string]string{}
	for _, raw := range strings.Split(string(data), "\n") {
		line := strings.TrimSpace(raw)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, value, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		values[strings.TrimSpace(key)] = strings.Trim(strings.TrimSpace(value), "\"'")
	}

	version, err := strconv.Atoi(values["version"])
	if err != nil {
		return localVaultMetadata{}, fmt.Errorf("cnos: invalid CNOS vault metadata")
	}
	iterations, err := strconv.Atoi(values["iterations"])
	if err != nil {
		return localVaultMetadata{}, fmt.Errorf("cnos: invalid CNOS vault metadata")
	}

	meta := localVaultMetadata{
		Version:    version,
		Algorithm:  values["algorithm"],
		KDF:        values["kdf"],
		Iterations: iterations,
		Salt:       values["salt"],
	}
	if meta.Version != 1 || meta.Algorithm != "aes-256-gcm" || meta.KDF != "pbkdf2-sha512" || meta.Salt == "" {
		return localVaultMetadata{}, fmt.Errorf("cnos: invalid CNOS vault metadata")
	}

	return meta, nil
}

func decryptLocalVaultPayload(buffer, key []byte, meta localVaultMetadata) (localVaultPayload, error) {
	if len(buffer) < 4+ivLength+authTagLength {
		return localVaultPayload{}, fmt.Errorf("cnos: invalid CNOS local vault keystore")
	}

	version := int(binary.LittleEndian.Uint32(buffer[:4]))
	if version != keystoreVersion {
		return localVaultPayload{}, fmt.Errorf("cnos: unsupported CNOS local vault keystore version: %d", version)
	}

	payload := encryptedSecretPayload{
		IV:         base64.StdEncoding.EncodeToString(buffer[4 : 4+ivLength]),
		Tag:        base64.StdEncoding.EncodeToString(buffer[4+ivLength : 4+ivLength+authTagLength]),
		Ciphertext: base64.StdEncoding.EncodeToString(buffer[4+ivLength+authTagLength:]),
	}

	plaintext, err := decryptJSONPayload(payload, key)
	if err != nil {
		return localVaultPayload{}, fmt.Errorf("cnos: failed to decrypt CNOS local vault. Check vault authentication")
	}

	var decoded localVaultPayload
	if err := json.Unmarshal(plaintext, &decoded); err != nil || decoded.Secrets == nil {
		return localVaultPayload{}, fmt.Errorf("cnos: failed to decrypt CNOS local vault. Check vault authentication")
	}

	return decoded, nil
}

func decryptJSONPayload(payload encryptedSecretPayload, key []byte) ([]byte, error) {
	iv, err := base64.StdEncoding.DecodeString(payload.IV)
	if err != nil {
		return nil, err
	}
	tag, err := base64.StdEncoding.DecodeString(payload.Tag)
	if err != nil {
		return nil, err
	}
	ciphertext, err := base64.StdEncoding.DecodeString(payload.Ciphertext)
	if err != nil {
		return nil, err
	}

	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}

	combined := append(append([]byte{}, ciphertext...), tag...)
	plaintext, err := gcm.Open(nil, iv, combined, nil)
	if err != nil {
		return nil, err
	}
	return plaintext, nil
}

func pbkdf2SHA512(password, salt []byte, iterations, keyLen int) []byte {
	hLen := sha512.Size
	blockCount := (keyLen + hLen - 1) / hLen
	result := make([]byte, 0, blockCount*hLen)

	for block := 1; block <= blockCount; block += 1 {
		u := pbkdf2Block(password, salt, iterations, block)
		result = append(result, u...)
	}

	return result[:keyLen]
}

func pbkdf2Block(password, salt []byte, iterations, block int) []byte {
	mac := hmac.New(sha512.New, password)
	mac.Write(salt)
	var index [4]byte
	binary.BigEndian.PutUint32(index[:], uint32(block))
	mac.Write(index[:])
	u := mac.Sum(nil)
	out := append([]byte(nil), u...)

	for step := 1; step < iterations; step += 1 {
		mac = hmac.New(sha512.New, password)
		mac.Write(u)
		u = mac.Sum(nil)
		for index := range out {
			out[index] ^= u[index]
		}
	}

	return out
}

func joinErrors(base error, next error) error {
	if base == nil {
		return next
	}
	if next == nil {
		return base
	}
	return errors.Join(base, next)
}

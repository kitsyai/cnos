package cnos

import (
	"crypto/aes"
	"crypto/cipher"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	goruntime "runtime"
	"testing"
)

func TestLoadProjectionHydratesEnvironmentSecrets(t *testing.T) {
	t.Parallel()

	runtime := mustLoadProjectionRuntime(t, ServerProjection{
		Version:    1,
		Workspace:  "api",
		Profile:    "stage",
		ResolvedAt: "2026-05-29T00:00:00Z",
		ConfigHash: "hash",
		Values:     map[string]any{},
		Derived:    map[string]DerivedFormula{},
		SecretRefs: map[string]SecretReference{
			"subscriptions.razorpay.key_id": {
				Provider: "environment",
				Vault:    "firebase-stage",
				Ref:      "subscriptions.razorpay.key_id",
				EnvVar:   "RAZORPAY_KEY_ID",
			},
		},
		PublicKeys:        []string{},
		RuntimeNamespaces: []string{},
		Meta:              ProjectionMeta{Workspace: "api", Profile: "stage", CnosVersion: "1.10.0"},
	}, Options{
		Environment: map[string]string{
			"RAZORPAY_KEY_ID": "rzp_stage_live_key",
		},
		SecretHome: t.TempDir(),
	})

	value, ok, err := runtime.Secret("subscriptions.razorpay.key_id")
	if err != nil {
		t.Fatalf("read environment secret: %v", err)
	}
	if !ok || value != "rzp_stage_live_key" {
		t.Fatalf("expected env secret, got ok=%v value=%v", ok, value)
	}
}

func TestLoadProjectionHydratesLocalVaultFromSessionFileAndRefreshes(t *testing.T) {
	t.Parallel()

	secretHome := t.TempDir()
	derivedKey := writeLocalVaultFixture(t, secretHome, "local-dev", map[string]string{
		"app.token": "first-value",
	})
	writeVaultSessionFixture(t, secretHome, "local-dev", derivedKey)

	runtime := mustLoadProjectionRuntime(t, ServerProjection{
		Version:    1,
		Workspace:  "api",
		Profile:    "local",
		ResolvedAt: "2026-05-29T00:00:00Z",
		ConfigHash: "hash",
		Values:     map[string]any{},
		Derived:    map[string]DerivedFormula{},
		SecretRefs: map[string]SecretReference{
			"app.token": {
				Provider: "local",
				Vault:    "local-dev",
				Ref:      "app.token",
			},
		},
		PublicKeys:        []string{},
		RuntimeNamespaces: []string{},
		Meta:              ProjectionMeta{Workspace: "api", Profile: "local", CnosVersion: "1.10.0"},
	}, Options{
		Environment: map[string]string{},
		SecretHome:  secretHome,
	})

	value, ok, err := runtime.Secret("app.token")
	if err != nil {
		t.Fatalf("read local secret: %v", err)
	}
	if !ok || value != "first-value" {
		t.Fatalf("expected first local secret, got ok=%v value=%v", ok, value)
	}

	writeLocalVaultFixture(t, secretHome, "local-dev", map[string]string{
		"app.token": "second-value",
	})
	if err := runtime.RefreshSecrets(); err != nil {
		t.Fatalf("refresh secrets: %v", err)
	}

	value, ok, err = runtime.Secret("app.token")
	if err != nil {
		t.Fatalf("read refreshed local secret: %v", err)
	}
	if !ok || value != "second-value" {
		t.Fatalf("expected refreshed local secret, got ok=%v value=%v", ok, value)
	}
}

func TestLoadProjectionHydratesLocalVaultFromKeychain(t *testing.T) {
	secretHome := t.TempDir()
	derivedKey := writeLocalVaultFixture(t, secretHome, "local-dev", map[string]string{
		"app.token": "keychain-value",
	})

	binDir := t.TempDir()
	installKeychainReadStub(t, binDir, "cnos/local-dev", hex.EncodeToString(derivedKey))
	t.Setenv("PATH", binDir+string(os.PathListSeparator)+os.Getenv("PATH"))

	runtime := mustLoadProjectionRuntime(t, ServerProjection{
		Version:    1,
		Workspace:  "api",
		Profile:    "local",
		ResolvedAt: "2026-05-29T00:00:00Z",
		ConfigHash: "hash",
		Values:     map[string]any{},
		Derived:    map[string]DerivedFormula{},
		SecretRefs: map[string]SecretReference{
			"app.token": {
				Provider: "local",
				Vault:    "local-dev",
				Ref:      "app.token",
			},
		},
		PublicKeys:        []string{},
		RuntimeNamespaces: []string{},
		Meta:              ProjectionMeta{Workspace: "api", Profile: "local", CnosVersion: "1.10.0"},
	}, Options{
		Environment: map[string]string{},
		SecretHome:  secretHome,
	})

	value, ok, err := runtime.Secret("app.token")
	if err != nil {
		t.Fatalf("read keychain-backed local secret: %v", err)
	}
	if !ok || value != "keychain-value" {
		t.Fatalf("expected keychain-backed local secret, got ok=%v value=%v", ok, value)
	}
}

func TestLoadProjectionUsesEncryptedSecretPayload(t *testing.T) {
	t.Parallel()

	payload, sessionKey := encryptSecretPayloadFixture(t, map[string]any{
		"secret.app.token": "from-run-auth",
	})

	runtime := mustLoadProjectionRuntime(t, ServerProjection{
		Version:    1,
		Workspace:  "api",
		Profile:    "local",
		ResolvedAt: "2026-05-29T00:00:00Z",
		ConfigHash: "hash",
		Values:     map[string]any{},
		Derived:    map[string]DerivedFormula{},
		SecretRefs: map[string]SecretReference{
			"app.token": {
				Provider: "local",
				Vault:    "local-dev",
				Ref:      "app.token",
			},
		},
		PublicKeys:        []string{},
		RuntimeNamespaces: []string{},
		Meta:              ProjectionMeta{Workspace: "api", Profile: "local", CnosVersion: "1.10.0"},
	}, Options{
		Environment: map[string]string{
			SecretPayloadEnvVar: payload,
			SessionKeyEnvVar:    sessionKey,
		},
		SecretHome: t.TempDir(),
	})

	value, ok, err := runtime.Secret("app.token")
	if err != nil {
		t.Fatalf("read payload-backed secret: %v", err)
	}
	if !ok || value != "from-run-auth" {
		t.Fatalf("expected encrypted payload secret, got ok=%v value=%v", ok, value)
	}
}

func writeLocalVaultFixture(t *testing.T, secretHome, vault string, secrets map[string]string) []byte {
	t.Helper()

	salt := make([]byte, 32)
	for index := range salt {
		salt[index] = byte(index + 1)
	}
	derivedKey := pbkdf2SHA512([]byte("local-dev-passphrase"), salt, 2, keyLength)
	plaintext, err := json.Marshal(localVaultPayload{Secrets: secrets})
	if err != nil {
		t.Fatalf("marshal local vault payload: %v", err)
	}

	block, err := aes.NewCipher(derivedKey)
	if err != nil {
		t.Fatalf("cipher: %v", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		t.Fatalf("gcm: %v", err)
	}
	iv := make([]byte, gcm.NonceSize())
	for index := range iv {
		iv[index] = byte(31 - index)
	}
	sealed := gcm.Seal(nil, iv, plaintext, nil)
	tag := sealed[len(sealed)-gcm.Overhead():]
	ciphertext := sealed[:len(sealed)-gcm.Overhead()]

	buffer := make([]byte, 4+len(iv)+len(tag)+len(ciphertext))
	binary.LittleEndian.PutUint32(buffer[:4], uint32(keystoreVersion))
	copy(buffer[4:], iv)
	copy(buffer[4+len(iv):], tag)
	copy(buffer[4+len(iv)+len(tag):], ciphertext)

	vaultRoot := filepath.Join(secretHome, "vaults", vault)
	if err := os.MkdirAll(vaultRoot, 0o755); err != nil {
		t.Fatalf("mkdir vault root: %v", err)
	}
	meta := "version: 1\nalgorithm: aes-256-gcm\nkdf: pbkdf2-sha512\niterations: 2\nsalt: " + base64.StdEncoding.EncodeToString(salt) + "\ncreatedAt: 2026-05-29T00:00:00Z\nsecretCount: 1\n"
	if err := os.WriteFile(filepath.Join(vaultRoot, "meta.yml"), []byte(meta), 0o644); err != nil {
		t.Fatalf("write meta.yml: %v", err)
	}
	if err := os.WriteFile(filepath.Join(vaultRoot, "keystore.enc"), buffer, 0o600); err != nil {
		t.Fatalf("write keystore.enc: %v", err)
	}

	return derivedKey
}

func writeVaultSessionFixture(t *testing.T, secretHome, vault string, derivedKey []byte) {
	t.Helper()

	sessionsRoot := filepath.Join(secretHome, "sessions")
	if err := os.MkdirAll(sessionsRoot, 0o755); err != nil {
		t.Fatalf("mkdir sessions root: %v", err)
	}
	document := map[string]any{
		"version":    1,
		"vault":      vault,
		"derivedKey": hex.EncodeToString(derivedKey),
		"createdAt":  "2026-05-29T00:00:00Z",
	}
	payload, err := json.Marshal(document)
	if err != nil {
		t.Fatalf("marshal session document: %v", err)
	}
	if err := os.WriteFile(filepath.Join(sessionsRoot, vault+".json"), payload, 0o644); err != nil {
		t.Fatalf("write session file: %v", err)
	}
}

func encryptSecretPayloadFixture(t *testing.T, values map[string]any) (string, string) {
	t.Helper()

	plaintext, err := json.Marshal(values)
	if err != nil {
		t.Fatalf("marshal secret payload: %v", err)
	}

	key := make([]byte, keyLength)
	for index := range key {
		key[index] = byte(index + 11)
	}

	block, err := aes.NewCipher(key)
	if err != nil {
		t.Fatalf("cipher: %v", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		t.Fatalf("gcm: %v", err)
	}
	iv := make([]byte, gcm.NonceSize())
	for index := range iv {
		iv[index] = byte(index + 21)
	}
	sealed := gcm.Seal(nil, iv, plaintext, nil)
	tag := sealed[len(sealed)-gcm.Overhead():]
	ciphertext := sealed[:len(sealed)-gcm.Overhead()]

	payload, err := json.Marshal(map[string]string{
		"iv":         base64.StdEncoding.EncodeToString(iv),
		"tag":        base64.StdEncoding.EncodeToString(tag),
		"ciphertext": base64.StdEncoding.EncodeToString(ciphertext),
	})
	if err != nil {
		t.Fatalf("marshal encrypted payload: %v", err)
	}

	return string(payload), hex.EncodeToString(key)
}

func installKeychainReadStub(t *testing.T, binDir, entry, encodedKey string) {
	t.Helper()

	switch goruntime.GOOS {
	case "linux":
		writeExecutable(t, filepath.Join(binDir, "secret-tool"), "#!/bin/sh\nif [ \"$1\" = \"lookup\" ] && [ \"$2\" = \"service\" ] && [ \"$3\" = \"cnos\" ] && [ \"$4\" = \"account\" ] && [ \"$5\" = \""+entry+"\" ]; then\n  printf '%s\\n' '"+encodedKey+"'\nfi\n")
	case "darwin":
		writeExecutable(t, filepath.Join(binDir, "security"), "#!/bin/sh\nif [ \"$1\" = \"find-generic-password\" ] && [ \"$2\" = \"-a\" ] && [ \"$3\" = \"cnos\" ] && [ \"$4\" = \"-s\" ] && [ \"$5\" = \""+entry+"\" ] && [ \"$6\" = \"-w\" ]; then\n  printf '%s\\n' '"+encodedKey+"'\nfi\n")
	case "windows":
		writeExecutable(t, filepath.Join(binDir, "powershell.bat"), "@echo off\r\necho "+encodedKey+"\r\n")
	default:
		t.Skipf("keychain stub not implemented for %s", goruntime.GOOS)
	}
}

func writeExecutable(t *testing.T, path, content string) {
	t.Helper()

	if err := os.WriteFile(path, []byte(content), 0o755); err != nil {
		t.Fatalf("write executable %s: %v", path, err)
	}
}

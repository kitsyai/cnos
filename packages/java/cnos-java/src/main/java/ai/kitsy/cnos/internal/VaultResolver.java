package ai.kitsy.cnos.internal;

import ai.kitsy.cnos.CnosError;
import ai.kitsy.cnos.VaultAuthConfig;
import ai.kitsy.cnos.VaultDefinition;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * Resolves vault authentication credentials and local vault secrets.
 * Mirrors Go's vault_provider.go resolveVaultAuth and secrets.go resolveLocalVaultKey logic.
 */
public final class VaultResolver {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final int KEY_LENGTH = 32;

    private VaultResolver() {}

    /**
     * Resolves the auth config for a vault, using the auth resolution chain.
     */
    public static VaultAuthConfig resolveVaultAuth(String vaultId, VaultDefinition definition,
            Environment env) throws CnosError {
        VaultDefinition.Auth auth = definition.getAuth();
        String method = auth != null && auth.getMethod() != null ? auth.getMethod().trim() : "";
        if (method.isEmpty()) {
            method = defaultVaultMethod(definition.getProvider());
        }

        Map<String, Object> config = auth != null ? auth.getConfig() : Collections.emptyMap();

        switch (method) {
            case "iam":
            case "environment":
                return VaultAuthConfig.ofMethod(method, config);
            case "token": {
                Optional<String> token = resolveFirstSource(auth != null ? auth.getToken() : null, env);
                if (!token.isPresent()) {
                    throw vaultAuthError(vaultId, auth != null ? auth.getToken() : null);
                }
                return VaultAuthConfig.ofToken(token.get(), config);
            }
        }

        // Fallback: try token sources, then passphrase sources
        if (auth != null && auth.getToken() != null && !auth.getToken().getFrom().isEmpty()) {
            Optional<String> token = resolveFirstSource(auth.getToken(), env);
            if (token.isPresent()) {
                return VaultAuthConfig.ofToken(token.get(), config);
            }
        }

        if (auth != null && auth.getPassphrase() != null && !auth.getPassphrase().getFrom().isEmpty()) {
            Optional<String> passphrase = resolveFirstSource(auth.getPassphrase(), env);
            if (passphrase.isPresent()) {
                return VaultAuthConfig.ofPassphrase(passphrase.get(), config);
            }
            throw vaultAuthError(vaultId, auth.getPassphrase());
        }

        Optional<String> passphrase = resolveVaultPassphrase(vaultId, env);
        if (passphrase.isPresent()) {
            return VaultAuthConfig.ofPassphrase(passphrase.get(), config);
        }

        return VaultAuthConfig.ofMethod(method, config);
    }

    /**
     * Resolves the AES key for a local vault, using the auth chain.
     */
    public static byte[] resolveLocalVaultKey(String secretHome, String vaultId,
            LocalVault.Metadata meta, VaultDefinition definition, Environment env) throws CnosError {

        // 1. Check __CNOS_VAULT_KEY_{VAULT_UPPER}__ env var
        Optional<String> preKey = env.get(getVaultSessionKeyEnvVar(vaultId));
        if (preKey.isPresent() && !preKey.get().isEmpty()) {
            try {
                byte[] key = LocalVault.hexDecode(preKey.get());
                if (key.length == KEY_LENGTH) return key;
            } catch (Exception ignored) {}
        }

        // 2. Check session file
        File sessionFile = new File(secretHome, "sessions/" + vaultId + ".json");
        if (sessionFile.exists()) {
            Optional<byte[]> sessionKey = readSessionKey(sessionFile);
            if (sessionKey.isPresent()) return sessionKey.get();
        }

        // 3. Walk auth sources
        for (String source : resolveLocalVaultAuthSources(vaultId, definition)) {
            if (source.startsWith("env:")) {
                String varName = source.substring(4);
                Optional<String> passphrase = env.get(varName);
                if (passphrase.isPresent() && !passphrase.get().isEmpty()) {
                    return LocalVault.deriveKey(passphrase.get(), meta.salt, meta.iterations);
                }
            } else if (source.startsWith("keychain:")) {
                // OS keychain is not reliably available cross-platform in Java — skip
            } else if ("prompt".equals(source)) {
                // Interactive prompt: try console if available
                java.io.Console console = System.console();
                if (console != null) {
                    char[] pw = console.readPassword("Enter passphrase for vault \"%s\": ", vaultId);
                    if (pw != null && pw.length > 0) {
                        String passphrase = new String(pw);
                        java.util.Arrays.fill(pw, '\0');
                        return LocalVault.deriveKey(passphrase, meta.salt, meta.iterations);
                    }
                }
            }
        }

        // 4. Fallback env var resolution
        Optional<String> passphrase = resolveVaultPassphrase(vaultId, env);
        if (passphrase.isPresent()) {
            return LocalVault.deriveKey(passphrase.get(), meta.salt, meta.iterations);
        }

        String keyVar = getVaultSessionKeyEnvVar(vaultId);
        List<String> tried = new ArrayList<>();
        tried.add(keyVar);
        tried.addAll(resolveLocalVaultAuthSources(vaultId, definition));
        throw new CnosError("cnos: cannot authenticate to vault \"" + vaultId
                + "\". Tried: " + String.join(", ", tried)
                + ". Set " + getVaultPassphraseEnvVar(vaultId)
                + " or run cnos vault auth " + vaultId);
    }

    static List<String> resolveLocalVaultAuthSources(String vaultId, VaultDefinition definition) {
        if (definition != null && definition.getAuth() != null
                && definition.getAuth().getPassphrase() != null
                && !definition.getAuth().getPassphrase().getFrom().isEmpty()) {
            return new ArrayList<>(definition.getAuth().getPassphrase().getFrom());
        }

        String token = normalizeVaultToken(vaultId);
        List<String> sources = new ArrayList<>();
        if (!token.isEmpty()) {
            sources.add("env:CNOS_SECRET_PASSPHRASE_" + token);
        }
        sources.add("env:CNOS_SECRET_PASSPHRASE");
        sources.add("keychain:cnos/" + vaultId);
        sources.add("prompt");
        return sources;
    }

    static Optional<String> resolveVaultPassphrase(String vaultId, Environment env) {
        Optional<String> specific = env.get(getVaultPassphraseEnvVar(vaultId));
        if (specific.isPresent() && !specific.get().isEmpty()) return specific;
        Optional<String> fallback = env.get("CNOS_SECRET_PASSPHRASE");
        if (fallback.isPresent() && !fallback.get().isEmpty()) return fallback;
        return Optional.empty();
    }

    static String getVaultPassphraseEnvVar(String vaultId) {
        String token = normalizeVaultToken(vaultId);
        if (!token.isEmpty() && !"DEFAULT".equals(token)) {
            return "CNOS_SECRET_PASSPHRASE_" + token;
        }
        return "CNOS_SECRET_PASSPHRASE";
    }

    static String getVaultSessionKeyEnvVar(String vaultId) {
        String token = normalizeVaultToken(vaultId);
        if (token.isEmpty()) token = "DEFAULT";
        return "__CNOS_VAULT_KEY_" + token + "__";
    }

    /**
     * Normalizes a vault ID for use in environment variable names.
     * Upper-cases letters, replaces non-alphanumeric chars with {@code _}, collapses repeats, trims.
     */
    public static String normalizeVaultToken(String vaultId) {
        if (vaultId == null) return "";
        vaultId = vaultId.trim();
        StringBuilder sb = new StringBuilder();
        boolean lastUnderscore = false;
        for (char c : vaultId.toCharArray()) {
            if (c >= 'a' && c <= 'z') {
                sb.append((char) (c - 32));
                lastUnderscore = false;
            } else if ((c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')) {
                sb.append(c);
                lastUnderscore = false;
            } else {
                if (!lastUnderscore) {
                    sb.append('_');
                    lastUnderscore = true;
                }
            }
        }
        // Trim leading and trailing underscores
        String result = sb.toString();
        int start = 0, end = result.length();
        while (start < end && result.charAt(start) == '_') start++;
        while (end > start && result.charAt(end - 1) == '_') end--;
        return result.substring(start, end);
    }

    public static String defaultVaultMethod(String provider) {
        if ("local".equals(provider)) return "passphrase";
        if ("github-secrets".equals(provider) || "environment".equals(provider)) return "environment";
        return "";
    }

    private static Optional<byte[]> readSessionKey(File sessionFile) {
        try {
            @SuppressWarnings("unchecked")
            Map<String, Object> doc = MAPPER.readValue(sessionFile, Map.class);
            Object versionObj = doc.get("version");
            Object keyObj = doc.get("derivedKey");
            if (!(versionObj instanceof Integer) || (Integer) versionObj != 1) return Optional.empty();
            if (!(keyObj instanceof String) || ((String) keyObj).isEmpty()) return Optional.empty();
            byte[] key = LocalVault.hexDecode((String) keyObj);
            if (key.length == KEY_LENGTH) return Optional.of(key);
        } catch (Exception ignored) {}
        return Optional.empty();
    }

    private static Optional<String> resolveFirstSource(VaultDefinition.AuthSource source, Environment env) {
        if (source == null) return Optional.empty();
        for (String candidate : source.getFrom()) {
            Optional<String> value = resolveVaultSource(candidate.trim(), env);
            if (value.isPresent()) return value;
        }
        return Optional.empty();
    }

    private static Optional<String> resolveVaultSource(String source, Environment env) {
        if (source.startsWith("env:")) {
            Optional<String> v = env.get(source.substring(4));
            if (v.isPresent() && !v.get().trim().isEmpty()) return Optional.of(v.get().trim());
        } else if (source.startsWith("file:")) {
            try {
                File f = new File(expandHome(source.substring(5)));
                String v = new String(Files.readAllBytes(f.toPath())).trim();
                if (!v.isEmpty()) return Optional.of(v);
            } catch (IOException ignored) {}
        }
        // keychain: skip on Java
        return Optional.empty();
    }

    private static CnosError vaultAuthError(String vaultId, VaultDefinition.AuthSource source) {
        List<String> sources = source != null ? source.getFrom() : Collections.emptyList();
        return new CnosError("cnos: cannot authenticate to vault \"" + vaultId
                + "\". Tried: " + String.join(", ", sources));
    }

    static String expandHome(String path) {
        if (path.startsWith("~/") || path.equals("~")) {
            String home = System.getProperty("user.home", "");
            if (path.equals("~")) return home;
            return home + "/" + path.substring(2);
        }
        return path;
    }
}

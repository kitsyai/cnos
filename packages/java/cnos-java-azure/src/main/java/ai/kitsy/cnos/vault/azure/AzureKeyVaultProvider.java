package ai.kitsy.cnos.vault.azure;

import ai.kitsy.cnos.CnosError;
import ai.kitsy.cnos.SecretVaultProvider;
import ai.kitsy.cnos.VaultAuthConfig;
import ai.kitsy.cnos.VaultDefinition;

import java.net.URI;
import java.net.URISyntaxException;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.*;

/**
 * CNOS provider for Azure Key Vault.
 * Provider name: {@code azure-key-vault}.
 * Auth: {@code iam} or {@code environment} (DefaultAzureCredential).
 */
public final class AzureKeyVaultProvider implements SecretVaultProvider {

    /** Narrow Azure Key Vault client interface, injectable for testing. */
    public interface Client {
        /**
         * Returns the secret value, or null if not found (HTTP 404).
         */
        String getSecret(String name, String version) throws Exception;
    }

    private final String vaultId;
    private final VaultDefinition definition;
    private final String configVaultUrl;
    private final String configOrigin;
    private final String configVersion;
    private final Client client;
    private boolean authenticated;

    AzureKeyVaultProvider(String vaultId, VaultDefinition definition,
            String configVaultUrl, String configOrigin, String configVersion,
            Client client) {
        this.vaultId = vaultId;
        this.definition = definition;
        this.configVaultUrl = configVaultUrl;
        this.configOrigin = configOrigin;
        this.configVersion = configVersion;
        this.client = client;
    }

    @Override
    public void authenticate(VaultAuthConfig auth) throws CnosError {
        if (!"iam".equals(auth.getMethod()) && !"environment".equals(auth.getMethod())) {
            throw new CnosError("vault \"" + vaultId
                    + "\" uses azure-key-vault and requires iam authentication");
        }
        authenticated = true;
    }

    @Override
    public Map<String, Object> batchGet(List<String> refs) throws CnosError {
        Map<String, Object> result = new LinkedHashMap<>();
        for (String ref : uniqueSorted(refs)) {
            Object v = get(ref);
            if (v != null) result.put(ref, v);
        }
        return result;
    }

    @Override
    public Object get(String ref) throws CnosError {
        String external = externalIdForRef(ref);
        ParsedRef parsed = parseSecretRef(external, vaultId);
        // Cross-vault URL guard
        if (parsed.fullUrl && configOrigin != null && !configOrigin.isEmpty()
                && parsed.origin != null && !configOrigin.equalsIgnoreCase(parsed.origin)) {
            throw new CnosError("vault \"" + vaultId + "\" Azure Key Vault ref \"" + external
                    + "\" belongs to " + parsed.origin + ", but vaultUrl is " + configVaultUrl);
        }
        String version = (parsed.version != null && !parsed.version.isEmpty())
                ? parsed.version : (configVersion != null ? configVersion : "");
        try {
            return client.getSecret(parsed.name, version);
        } catch (CnosError e) {
            throw e;
        } catch (Exception e) {
            throw new CnosError("Azure Key Vault get failed for ref \"" + ref + "\": " + e.getMessage(), e);
        }
    }

    private String externalIdForRef(String ref) {
        for (Map.Entry<String, String> e : definition.getMapping().entrySet()) {
            if (ref.equals(e.getValue())) return e.getKey();
        }
        return ref;
    }

    // ── ref parsing ───────────────────────────────────────────────────────────

    static ParsedRef parseSecretRef(String ref, String vaultId) throws CnosError {
        String trimmed = ref == null ? "" : ref.trim();
        if (trimmed.isEmpty()) throw new CnosError("vault \"" + vaultId + "\" has empty secret name");

        if (!trimmed.startsWith("https://") && !trimmed.startsWith("http://")) {
            return new ParsedRef(trimmed, null, null, false);
        }

        URI uri;
        try {
            uri = new URI(trimmed);
        } catch (URISyntaxException e) {
            throw new CnosError("vault \"" + vaultId + "\" has invalid Azure Key Vault ref \"" + ref + "\": " + e.getMessage());
        }

        String[] segments = pathSegments(uri.getPath());
        if (segments.length < 2 || segments.length > 3 || !"secrets".equals(segments[0])) {
            throw new CnosError("vault \"" + vaultId + "\" has invalid Azure Key Vault ref \""
                    + ref + "\": full URL must use /secrets/<name>[/<version>]");
        }

        String name = urlDecode(vaultId, ref, segments[1]);
        if (name.isEmpty()) throw new CnosError("vault \"" + vaultId + "\" has empty secret name in ref \"" + ref + "\"");

        String origin = originForUri(uri);
        String version = segments.length == 3 ? urlDecode(vaultId, ref, segments[2]) : null;
        return new ParsedRef(name, version, origin, true);
    }

    private static String urlDecode(String vaultId, String ref, String segment) throws CnosError {
        try {
            // Escape literal '+' before decoding so URLDecoder (form-encoding) treats it as '+',
            // not as a space. Path segments use percent-encoding, not form-encoding.
            return URLDecoder.decode(segment.replace("+", "%2B"), StandardCharsets.UTF_8.name());
        } catch (Exception e) {
            throw new CnosError("vault \"" + vaultId + "\" has invalid percent-encoding in ref \""
                    + ref + "\": " + e.getMessage());
        }
    }

    private static String[] pathSegments(String path) {
        if (path == null || path.isEmpty()) return new String[0];
        List<String> segs = new ArrayList<>();
        for (String s : path.split("/")) {
            if (!s.isEmpty()) segs.add(s);
        }
        return segs.toArray(new String[0]);
    }

    static String originForUri(URI uri) {
        if (uri == null || uri.getScheme() == null || uri.getHost() == null) return null;
        return (uri.getScheme() + "://" + uri.getHost()).toLowerCase(Locale.ROOT);
    }

    static String originForUrl(String url) {
        if (url == null || url.isEmpty()) return null;
        try {
            return originForUri(new URI(url.trim()));
        } catch (Exception ignored) {
            return null;
        }
    }

    private static List<String> uniqueSorted(List<String> refs) {
        Set<String> seen = new LinkedHashSet<>();
        for (String r : refs) if (r != null) seen.add(r);
        List<String> result = new ArrayList<>(seen);
        Collections.sort(result);
        return result;
    }

    static final class ParsedRef {
        private final String name;
        private final String version;
        private final String origin;
        private final boolean fullUrl;
        ParsedRef(String name, String version, String origin, boolean fullUrl) {
            this.name = name; this.version = version; this.origin = origin; this.fullUrl = fullUrl;
        }
        public String name() { return name; }
        public String version() { return version; }
        public String origin() { return origin; }
        public boolean fullUrl() { return fullUrl; }
    }
}

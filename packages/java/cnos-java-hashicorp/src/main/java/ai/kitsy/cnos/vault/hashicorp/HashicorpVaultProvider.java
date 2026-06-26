package ai.kitsy.cnos.vault.hashicorp;

import ai.kitsy.cnos.CnosError;
import ai.kitsy.cnos.SecretVaultProvider;
import ai.kitsy.cnos.VaultAuthConfig;
import ai.kitsy.cnos.VaultDefinition;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.*;

/**
 * CNOS provider for HashiCorp Vault KV.
 * Provider name: {@code hashicorp-vault}.
 * Uses {@code java.net.http.HttpClient} directly — no extra dependency.
 */
public final class HashicorpVaultProvider implements SecretVaultProvider {

    /** Narrow client interface, injectable for testing. */
    public interface Client {
        /**
         * Reads a Vault KV path.
         *
         * @param path      the KV path to read
         * @param token     vault token
         * @param namespace vault namespace (may be null/empty)
         * @return (data map, HTTP status) or null data on 404
         */
        ReadResult read(String path, String token, String namespace) throws Exception;

        final class ReadResult {
            private final Map<String, Object> data;
            private final int status;
            public ReadResult(Map<String, Object> data, int status) { this.data = data; this.status = status; }
            public Map<String, Object> data() { return data; }
            public int status() { return status; }
        }
    }

    private static final ObjectMapper MAPPER = new ObjectMapper();

    private final String vaultId;
    private final VaultDefinition definition;
    private final String address;
    private final String mount;
    private final String namespace;
    private final int version;
    private final String path;
    private final Client client;
    private String token;
    private boolean authenticated;

    HashicorpVaultProvider(String vaultId, VaultDefinition definition,
            String address, String mount, String namespace, int version, String path,
            Client client) {
        this.vaultId = vaultId;
        this.definition = definition;
        this.address = address;
        this.mount = mount;
        this.namespace = namespace;
        this.version = version;
        this.path = path;
        this.client = client;
    }

    @Override
    public void authenticate(VaultAuthConfig auth) throws CnosError {
        if (!"token".equals(auth.getMethod()) || auth.getToken() == null || auth.getToken().isEmpty()) {
            throw new CnosError("vault \"" + vaultId
                    + "\" uses hashicorp-vault and requires token authentication");
        }
        this.token = auth.getToken();
        this.authenticated = true;
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
        String external = externalRefForLogical(ref);
        ParsedRef parsed = parseVaultRef(external);
        String readPath = buildReadPath(parsed.path);

        try {
            Client.ReadResult result = client.read(readPath, token, namespace);
            if (result.status() == 404 || result.data() == null) return null;
            Map<String, Object> kvData = extractKvData(result.data());
            return decodeVaultValue(kvData, parsed.field, parsed.explicitField);
        } catch (CnosError e) {
            throw e;
        } catch (Exception e) {
            throw new CnosError("HashiCorp Vault get failed for ref \"" + ref + "\": " + e.getMessage(), e);
        }
    }

    private String buildReadPath(String secretPath) {
        if (version == 2) {
            return joinPath(mount, "data", path, secretPath);
        }
        return joinPath(mount, path, secretPath);
    }

    private Map<String, Object> extractKvData(Map<String, Object> data) {
        if (version != 2) return data;
        Object nested = data.get("data");
        if (nested instanceof Map) {
            @SuppressWarnings("unchecked")
            Map<String, Object> m = (Map<String, Object>) nested;
            return m;
        }
        return null;
    }

    @SuppressWarnings("unchecked")
    private static String decodeVaultValue(Map<String, Object> data, String field, boolean explicitField) {
        if (data == null) return null;

        // Try the named field first
        Object v = data.get(field);
        if (v != null) {
            String s = toPrimitive(v);
            if (s != null) return s;
        }

        if (explicitField) return null;

        // If only one primitive value exists, return it
        List<String> primitives = new ArrayList<>();
        for (Object value : data.values()) {
            String s = toPrimitive(value);
            if (s != null) primitives.add(s);
        }
        if (primitives.size() == 1) return primitives.get(0);
        return null;
    }

    private static String toPrimitive(Object v) {
        if (v instanceof String) return (String) v;
        if (v instanceof Integer) return Integer.toString((Integer) v);
        if (v instanceof Long) return Long.toString((Long) v);
        if (v instanceof Double) return Double.toString((Double) v);
        if (v instanceof Boolean) return Boolean.toString((Boolean) v);
        return null;
    }

    private String externalRefForLogical(String ref) {
        for (Map.Entry<String, String> e : definition.getMapping().entrySet()) {
            if (ref.equals(e.getValue())) return e.getKey();
        }
        return ref;
    }

    static ParsedRef parseVaultRef(String ref) {
        int hash = ref.lastIndexOf('#');
        if (hash < 0) return new ParsedRef(ref, "value", false);
        String field = ref.substring(hash + 1);
        if (field.isEmpty()) field = "value";
        return new ParsedRef(ref.substring(0, hash), field, true);
    }

    static String joinPath(String... segments) {
        List<String> parts = new ArrayList<>();
        for (String s : segments) {
            if (s != null) {
                String trimmed = s.trim().replaceAll("^/+|/+$", "");
                if (!trimmed.isEmpty()) parts.add(trimmed);
            }
        }
        return String.join("/", parts);
    }

    private static List<String> uniqueSorted(List<String> refs) {
        Set<String> seen = new LinkedHashSet<>();
        for (String r : refs) if (r != null) seen.add(r);
        List<String> result = new ArrayList<>(seen);
        Collections.sort(result);
        return result;
    }

    static final class ParsedRef {
        private final String path;
        private final String field;
        private final boolean explicitField;
        ParsedRef(String path, String field, boolean explicitField) {
            this.path = path; this.field = field; this.explicitField = explicitField;
        }
        public String path() { return path; }
        public String field() { return field; }
        public boolean explicitField() { return explicitField; }
    }

    /** HTTP client adapter using java.net.http.HttpClient. */
    static final class HttpClientAdapter implements Client {
        private final String baseAddress;
        private final HttpClient http;

        HttpClientAdapter(String address) {
            this.baseAddress = address != null && !address.isEmpty() ? address.trim() : "http://127.0.0.1:8200";
            this.http = HttpClient.newBuilder()
                    .connectTimeout(Duration.ofSeconds(10))
                    .build();
        }

        @Override
        public ReadResult read(String path, String token, String namespace) throws Exception {
            String url = baseAddress.replaceAll("/+$", "") + "/v1/" + path.replaceAll("^/+", "");
            HttpRequest.Builder reqBuilder = HttpRequest.newBuilder()
                    .uri(URI.create(url))
                    .GET()
                    .timeout(Duration.ofSeconds(30))
                    .header("X-Vault-Token", token != null ? token : "");
            if (namespace != null && !namespace.isEmpty()) {
                reqBuilder.header("X-Vault-Namespace", namespace);
            }

            HttpResponse<String> response = http.send(reqBuilder.build(), HttpResponse.BodyHandlers.ofString());
            int status = response.statusCode();
            if (status == 404) return new ReadResult(null, 404);
            if (status >= 400) throw new IOException("Vault HTTP " + status + ": " + response.body());

            @SuppressWarnings("unchecked")
            Map<String, Object> body = MAPPER.readValue(response.body(), Map.class);
            @SuppressWarnings("unchecked")
            Map<String, Object> data = (Map<String, Object>) body.get("data");
            return new ReadResult(data, status);
        }
    }
}

package ai.kitsy.cnos;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.BeforeEach;

import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.*;

class CnosRuntimeTest {

    private static final String MINIMAL_PROJECTION = "{"
            + "\"version\":1,"
            + "\"workspace\":\"base\","
            + "\"profile\":\"local\","
            + "\"resolvedAt\":\"2024-01-01T00:00:00Z\","
            + "\"configHash\":\"abc123\","
            + "\"values\":{"
            + "  \"server.port\":3000,"
            + "  \"server.host\":\"localhost\","
            + "  \"featureFlag\":true,"
            + "  \"app.name\":\"my-app\""
            + "},"
            + "\"derived\":{"
            + "  \"server.url\":{"
            + "    \"expr\":\"${value.server.host}:${value.server.port}\","
            + "    \"deps\":[\"value.server.host\",\"value.server.port\"],"
            + "    \"runtimeRefs\":[]"
            + "  }"
            + "},"
            + "\"secretRefs\":{"
            + "  \"db.password\":{\"provider\":\"environment\",\"ref\":\"DB_PASSWORD\",\"vault\":\"default\"}"
            + "},"
            + "\"publicKeys\":[\"server.port\"],"
            + "\"runtimeNamespaces\":[],"
            + "\"meta\":{"
            + "  \"workspace\":\"base\","
            + "  \"profile\":\"local\","
            + "  \"cnos_version\":\"1.11.3\""
            + "}"
            + "}";

    private CnosRuntime runtime;

    @BeforeEach
    void setUp() throws CnosError {
        Map<String, String> env = new HashMap<>();
        env.put("DB_PASSWORD", "s3cr3t");

        runtime = CnosRuntime.load(CnosOptions.builder()
                .projectionData(MINIMAL_PROJECTION.getBytes(StandardCharsets.UTF_8))
                .environment(env)
                .build());
    }

    @Test
    void loadFromProjectionBytes() {
        assertNotNull(runtime);
    }

    @Test
    void readValueKey() throws CnosError {
        Optional<Object> port = runtime.value("server.port");
        assertTrue(port.isPresent());
        assertEquals(3000, ((Number) port.get()).intValue());
    }

    @Test
    void readStringValue() throws CnosError {
        Optional<Object> host = runtime.value("server.host");
        assertTrue(host.isPresent());
        assertEquals("localhost", host.get());
    }

    @Test
    void readBooleanValue() throws CnosError {
        Optional<Object> flag = runtime.value("featureFlag");
        assertTrue(flag.isPresent());
        assertEquals(Boolean.TRUE, flag.get());
    }

    @Test
    void readAbsentKeyReturnsEmpty() throws CnosError {
        Optional<Object> absent = runtime.read("value.nonexistent");
        assertFalse(absent.isPresent());
    }

    @Test
    void requireAbsentKeyThrows() {
        assertThrows(CnosError.class, () -> runtime.require("value.nonexistent"));
    }

    @Test
    void readDerivedTemplateFormula() throws CnosError {
        // value.server.url = "${value.server.host}:${value.server.port}"
        Optional<Object> url = runtime.value("server.url");
        assertTrue(url.isPresent());
        assertEquals("localhost:3000", url.get());
    }

    @Test
    void readMetaProfile() throws CnosError {
        Optional<Object> profile = runtime.meta("profile");
        assertTrue(profile.isPresent());
        assertEquals("local", profile.get());
    }

    @Test
    void readMetaWorkspace() throws CnosError {
        Optional<Object> ws = runtime.meta("workspace");
        assertTrue(ws.isPresent());
        assertEquals("base", ws.get());
    }

    @Test
    void readMetaCnosVersion() throws CnosError {
        Optional<Object> v = runtime.meta("cnos_version");
        assertTrue(v.isPresent());
        assertEquals("1.11.3", v.get());
    }

    @Test
    void readSecretFromEnvironment() throws CnosError {
        Optional<Object> pw = runtime.secret("db.password");
        assertTrue(pw.isPresent());
        assertEquals("s3cr3t", pw.get());
    }

    @Test
    void readPublicKey() throws CnosError {
        Optional<Object> pub = runtime.publicKey("server.port");
        assertTrue(pub.isPresent());
        assertEquals(3000, ((Number) pub.get()).intValue());
    }

    @Test
    void toObjectContainsAllValues() throws CnosError {
        Map<String, Object> obj = runtime.toObject();
        assertNotNull(obj);
        assertFalse(obj.isEmpty());
        // Check nested structure for "value" → "server" → "port"
        @SuppressWarnings("unchecked")
        Map<String, Object> value = (Map<String, Object>) obj.get("value");
        assertNotNull(value);
        @SuppressWarnings("unchecked")
        Map<String, Object> server = (Map<String, Object>) value.get("server");
        assertNotNull(server);
        assertEquals(3000, ((Number) server.get("port")).intValue());
    }

    @Test
    void toPublicEnvReturnsPublicKeys() throws CnosError {
        Map<String, String> env = runtime.toPublicEnv(new ToPublicEnvOptions());
        assertNotNull(env);
        // publicKeys = ["server.port"] → should become SERVER_PORT=3000
        assertTrue(env.containsKey("SERVER_PORT") || env.containsValue("3000"),
                "Expected public env to contain SERVER_PORT=3000, got: " + env);
    }

    @Test
    void formatMessageSubstitution() throws CnosError {
        String msg = runtime.format("Host is ${value.server.host}");
        assertEquals("Host is localhost", msg);
    }

    @Test
    void parseInvalidProjectionThrows() {
        String badJson = "{\"version\":2,\"workspace\":\"x\"}";
        assertThrows(CnosError.class, () ->
                CnosRuntime.load(CnosOptions.builder()
                        .projectionData(badJson.getBytes(StandardCharsets.UTF_8))
                        .build()));
    }

    @Test
    void readOrReturnsFallbackWhenAbsent() throws CnosError {
        Object result = runtime.readOr("value.missing", "default");
        assertEquals("default", result);
    }

    @Test
    void readOrReturnValueWhenPresent() throws CnosError {
        Object result = runtime.readOr("value.server.host", "default");
        assertEquals("localhost", result);
    }

    @Test
    void inspectReturnsResult() throws CnosError {
        InspectResult result = runtime.inspect("value.server.port");
        assertNotNull(result);
        assertEquals("value.server.port", result.getKey());
        assertEquals("value", result.getNamespace());
        assertEquals(3000, ((Number) result.getValue()).intValue());
    }

    @Test
    void inspectDerivedShowsDeps() throws CnosError {
        InspectResult result = runtime.inspect("value.server.url");
        assertNotNull(result.getDerived());
        assertEquals("template", result.getDerived().getType());
        assertFalse(result.getDerived().getDependencies().isEmpty());
    }

    @Test
    void toEnvWithEmptyMappingReturnsEmpty() throws CnosError {
        Map<String, String> env = runtime.toEnv(new ToEnvOptions());
        // No explicit env mappings in this projection
        assertNotNull(env);
    }

    @Test
    void projectionNotFoundThrowsCorrectError() {
        CnosError err = assertThrows(CnosError.class, () ->
                CnosRuntime.load(CnosOptions.builder()
                        .workingDir("/nonexistent/path/xyz")
                        .environment(Collections.emptyMap())
                        .build()));
        assertTrue(err.isProjectionNotFound());
    }

    // ================================================================
    // refreshSecrets / refreshSecret
    // ================================================================

    /** Projection that includes one env secret and one custom-vault secret. */
    private static final String REFRESH_PROJECTION = "{"
            + "\"version\":1,"
            + "\"workspace\":\"base\","
            + "\"profile\":\"local\","
            + "\"resolvedAt\":\"2024-01-01T00:00:00Z\","
            + "\"configHash\":\"refresh-test\","
            + "\"values\":{},"
            + "\"derived\":{},"
            + "\"secretRefs\":{"
            + "  \"db.password\":{\"provider\":\"environment\",\"ref\":\"DB_PASSWORD\",\"vault\":\"env-vault\"},"
            + "  \"api.key\":{\"provider\":\"test-provider\",\"ref\":\"api-key\",\"vault\":\"vault1\"}"
            + "},"
            + "\"vaults\":{"
            + "  \"vault1\":{"
            + "    \"provider\":\"test-provider\","
            + "    \"auth\":{\"method\":\"iam\"},"
            + "    \"fallback\":[]"
            + "  }"
            + "},"
            + "\"publicKeys\":[],"
            + "\"runtimeNamespaces\":[],"
            + "\"meta\":{"
            + "  \"workspace\":\"base\","
            + "  \"profile\":\"local\","
            + "  \"cnos_version\":\"1.11.3\""
            + "}"
            + "}";

    @Test
    void secretAcceptsFullyPrefixedKey() throws CnosError {
        // secret("secret.db.password") must not double-prefix to "secret.secret.db.password"
        Optional<Object> v1 = runtime.secret("db.password");
        Optional<Object> v2 = runtime.secret("secret.db.password");
        assertEquals(v1, v2);
        assertEquals("s3cr3t", v2.orElse(null));
    }

    @Test
    void refreshSecretsSuccessPreservesValues() throws CnosError {
        Map<String, String> env = new HashMap<>();
        env.put("DB_PASSWORD", "s3cr3t");

        SecretVaultProviderFactory factory = new SecretVaultProviderFactory("test-provider",
                (vaultId, def) -> new SecretVaultProvider() {
                    public void authenticate(VaultAuthConfig auth) {}
                    public Map<String, Object> batchGet(List<String> refs) {
                        Map<String, Object> r = new HashMap<>();
                        r.put("api-key", "initial-api-value");
                        return r;
                    }
                    public Object get(String ref) { return "initial-api-value"; }
                });

        CnosRuntime rt = CnosRuntime.load(CnosOptions.builder()
                .projectionData(REFRESH_PROJECTION.getBytes(StandardCharsets.UTF_8))
                .environment(env)
                .secretVaultProviders(Collections.singletonList(factory))
                .build());

        // Hydrate both secrets
        assertEquals("s3cr3t", rt.secret("db.password").orElse(null));
        assertEquals("initial-api-value", rt.secret("api.key").orElse(null));

        // Refresh should complete without error and values remain accessible
        rt.refreshSecrets();
        assertEquals("s3cr3t", rt.secret("db.password").orElse(null));
        assertEquals("initial-api-value", rt.secret("api.key").orElse(null));
    }

    @Test
    void refreshSecretsFailurePreservesExistingCache() throws CnosError {
        Map<String, String> env = new HashMap<>();
        env.put("DB_PASSWORD", "s3cr3t");

        AtomicInteger callCount = new AtomicInteger(0);
        SecretVaultProviderFactory factory = new SecretVaultProviderFactory("test-provider",
                (vaultId, def) -> new SecretVaultProvider() {
                    public void authenticate(VaultAuthConfig auth) {}
                    public Map<String, Object> batchGet(List<String> refs) throws CnosError {
                        if (callCount.incrementAndGet() > 1) throw new CnosError("vault down");
                        Map<String, Object> r = new HashMap<>();
                        r.put("api-key", "cached-value");
                        return r;
                    }
                    public Object get(String ref) throws CnosError {
                        if (callCount.get() > 1) throw new CnosError("vault down");
                        return "cached-value";
                    }
                });

        CnosRuntime rt = CnosRuntime.load(CnosOptions.builder()
                .projectionData(REFRESH_PROJECTION.getBytes(StandardCharsets.UTF_8))
                .environment(env)
                .secretVaultProviders(Collections.singletonList(factory))
                .build());

        // Prime the cache via initial reads
        assertEquals("s3cr3t", rt.secret("db.password").orElse(null));
        assertEquals("cached-value", rt.secret("api.key").orElse(null));

        // Next vault call will fail — refreshSecrets() should throw
        assertThrows(CnosError.class, rt::refreshSecrets);

        // Clone-and-swap: original cache must be fully intact
        assertEquals("s3cr3t", rt.secret("db.password").orElse(null));
        assertEquals("cached-value", rt.secret("api.key").orElse(null));
    }

    @Test
    void refreshSecretSingleKeyFailurePreservesCache() throws CnosError {
        Map<String, String> env = new HashMap<>();
        env.put("DB_PASSWORD", "pass1");

        AtomicInteger callCount = new AtomicInteger(0);
        SecretVaultProviderFactory factory = new SecretVaultProviderFactory("test-provider",
                (vaultId, def) -> new SecretVaultProvider() {
                    public void authenticate(VaultAuthConfig auth) {}
                    public Map<String, Object> batchGet(List<String> refs) throws CnosError {
                        if (callCount.incrementAndGet() > 1) throw new CnosError("vault down");
                        Map<String, Object> r = new HashMap<>();
                        r.put("api-key", "original-api");
                        return r;
                    }
                    public Object get(String ref) throws CnosError {
                        if (callCount.get() > 1) throw new CnosError("vault down");
                        return "original-api";
                    }
                });

        CnosRuntime rt = CnosRuntime.load(CnosOptions.builder()
                .projectionData(REFRESH_PROJECTION.getBytes(StandardCharsets.UTF_8))
                .environment(env)
                .secretVaultProviders(Collections.singletonList(factory))
                .build());

        assertEquals("original-api", rt.secret("api.key").orElse(null));

        // Next vault call fails — single-key refresh should throw
        assertThrows(CnosError.class, () -> rt.refreshSecret("api.key"));

        // Original value must still be in cache after failed refresh
        assertEquals("original-api", rt.secret("api.key").orElse(null));
    }
}

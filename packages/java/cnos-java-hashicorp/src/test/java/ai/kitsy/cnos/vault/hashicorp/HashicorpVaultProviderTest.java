package ai.kitsy.cnos.vault.hashicorp;

import ai.kitsy.cnos.*;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.util.*;

import static org.junit.jupiter.api.Assertions.*;

class HashicorpVaultProviderTest {

    private FakeClient fakeClient;
    private VaultDefinition definition;
    private HashicorpVaultProvider provider;

    @BeforeEach
    void setUp() {
        fakeClient = new FakeClient();
        definition = new VaultDefinition("hashicorp-vault",
                new VaultDefinition.Auth(null, null, null, null),
                Collections.emptyMap(),
                Collections.emptyList());
        // KV v2, mount=secret, path=null
        provider = new HashicorpVaultProvider("test-vault", definition,
                "http://vault:8200", "secret", null, 2, null, fakeClient);
    }

    @Test
    void authenticateWithTokenSucceeds() {
        assertDoesNotThrow(() ->
                provider.authenticate(VaultAuthConfig.ofToken("my-token", Collections.emptyMap())));
    }

    @Test
    void authenticateWithIamFails() {
        assertThrows(CnosError.class, () ->
                provider.authenticate(VaultAuthConfig.ofMethod("iam", Collections.emptyMap())));
    }

    @Test
    void authenticateRequiresNonEmptyToken() {
        assertThrows(CnosError.class, () ->
                provider.authenticate(VaultAuthConfig.ofToken("", Collections.emptyMap())));
    }

    @Test
    void getSingleSecretV2() throws CnosError {
        provider.authenticate(VaultAuthConfig.ofToken("tok", Collections.emptyMap()));
        // KV v2: the HTTP client returns body.get("data") = {"data": {...}, "metadata": {...}}
        fakeClient.data.put("secret/data/my-secret", v2Data("value", "secret-val"));

        Object result = provider.get("my-secret");
        assertEquals("secret-val", result);
    }

    @Test
    void getSingleSecretV1() throws CnosError {
        HashicorpVaultProvider v1Provider = new HashicorpVaultProvider("test-vault", definition,
                "http://vault:8200", "secret", null, 1, null, fakeClient);
        v1Provider.authenticate(VaultAuthConfig.ofToken("tok", Collections.emptyMap()));
        // KV v1: data is returned flat
        fakeClient.data.put("secret/my-secret", mapOf("value", "v1-val"));

        Object result = v1Provider.get("my-secret");
        assertEquals("v1-val", result);
    }

    @Test
    void getReturnsNullOnNotFound() throws CnosError {
        provider.authenticate(VaultAuthConfig.ofToken("tok", Collections.emptyMap()));
        Object result = provider.get("missing-key");
        assertNull(result);
    }

    @Test
    void getWithFieldSuffix() throws CnosError {
        provider.authenticate(VaultAuthConfig.ofToken("tok", Collections.emptyMap()));
        fakeClient.data.put("secret/data/my-secret", v2Data("username", "admin", "password", "pass123"));

        Object result = provider.get("my-secret#password");
        assertEquals("pass123", result);
    }

    @Test
    void getWithFieldSuffixNotFoundReturnsNull() throws CnosError {
        provider.authenticate(VaultAuthConfig.ofToken("tok", Collections.emptyMap()));
        fakeClient.data.put("secret/data/my-secret", v2Data("username", "admin"));

        Object result = provider.get("my-secret#nonexistent");
        assertNull(result);
    }

    @Test
    void getWithSinglePrimitiveNoExplicitField() throws CnosError {
        provider.authenticate(VaultAuthConfig.ofToken("tok", Collections.emptyMap()));
        // Single value with key "key" — should still return it as the only primitive
        fakeClient.data.put("secret/data/one-val", v2Data("key", "thevalue"));

        Object result = provider.get("one-val");
        assertEquals("thevalue", result);
    }

    @Test
    void getWithMultiplePrimitivesNoFieldReturnsNull() throws CnosError {
        provider.authenticate(VaultAuthConfig.ofToken("tok", Collections.emptyMap()));
        fakeClient.data.put("secret/data/multi", v2Data("a", "1", "b", "2"));

        // Multiple values, no explicit field, no "value" field — ambiguous → null
        Object result = provider.get("multi");
        assertNull(result);
    }

    @Test
    void getUsesMapping() throws CnosError {
        Map<String, String> mapping = new HashMap<>();
        mapping.put("external/path", "logical-ref");
        VaultDefinition mapped = new VaultDefinition("hashicorp-vault",
                new VaultDefinition.Auth(null, null, null, null),
                mapping, Collections.emptyList());
        HashicorpVaultProvider mappedProvider = new HashicorpVaultProvider(
                "test-vault", mapped, "http://vault:8200", "secret", null, 2, null, fakeClient);
        mappedProvider.authenticate(VaultAuthConfig.ofToken("tok", Collections.emptyMap()));

        fakeClient.data.put("secret/data/external/path", v2Data("value", "mapped-val"));

        Object result = mappedProvider.get("logical-ref");
        assertEquals("mapped-val", result);
    }

    @Test
    void getWithCustomMount() throws CnosError {
        HashicorpVaultProvider customMount = new HashicorpVaultProvider("test-vault", definition,
                "http://vault:8200", "kv", null, 2, null, fakeClient);
        customMount.authenticate(VaultAuthConfig.ofToken("tok", Collections.emptyMap()));
        fakeClient.data.put("kv/data/my-secret", v2Data("value", "kv-val"));

        Object result = customMount.get("my-secret");
        assertEquals("kv-val", result);
    }

    @Test
    void getWithCustomPath() throws CnosError {
        HashicorpVaultProvider withPath = new HashicorpVaultProvider("test-vault", definition,
                "http://vault:8200", "secret", null, 2, "app/prod", fakeClient);
        withPath.authenticate(VaultAuthConfig.ofToken("tok", Collections.emptyMap()));
        fakeClient.data.put("secret/data/app/prod/db-pass", v2Data("value", "prod-pass"));

        Object result = withPath.get("db-pass");
        assertEquals("prod-pass", result);
    }

    @Test
    void batchGetReturnsMultipleValues() throws CnosError {
        provider.authenticate(VaultAuthConfig.ofToken("tok", Collections.emptyMap()));
        fakeClient.data.put("secret/data/a", v2Data("value", "va"));
        fakeClient.data.put("secret/data/b", v2Data("value", "vb"));

        Map<String, Object> result = provider.batchGet(Arrays.asList("a", "b"));
        assertEquals("va", result.get("a"));
        assertEquals("vb", result.get("b"));
    }

    @Test
    void parseVaultRefNoHash() {
        HashicorpVaultProvider.ParsedRef ref = HashicorpVaultProvider.parseVaultRef("my-secret");
        assertEquals("my-secret", ref.path());
        assertEquals("value", ref.field());
        assertFalse(ref.explicitField());
    }

    @Test
    void parseVaultRefWithHash() {
        HashicorpVaultProvider.ParsedRef ref = HashicorpVaultProvider.parseVaultRef("my-secret#password");
        assertEquals("my-secret", ref.path());
        assertEquals("password", ref.field());
        assertTrue(ref.explicitField());
    }

    @Test
    void parseVaultRefEmptyHash() {
        HashicorpVaultProvider.ParsedRef ref = HashicorpVaultProvider.parseVaultRef("my-secret#");
        assertEquals("my-secret", ref.path());
        assertEquals("value", ref.field());
        assertTrue(ref.explicitField());
    }

    @Test
    void joinPath() {
        assertEquals("a/b/c", HashicorpVaultProvider.joinPath("a", "b", "c"));
        assertEquals("a/b", HashicorpVaultProvider.joinPath("/a/", "/b/"));
        assertEquals("a/b/c", HashicorpVaultProvider.joinPath("a", null, "b", "", "c"));
    }

    @Test
    void factoryReadConfig() {
        Map<String, Object> config = new HashMap<>();
        config.put("address", "http://myvault:8200");
        config.put("mount", "kv");
        config.put("version", 1);
        config.put("namespace", "ns1");
        config.put("path", "app");
        VaultDefinition def = new VaultDefinition("hashicorp-vault",
                new VaultDefinition.Auth(null, null, null, config),
                Collections.emptyMap(), Collections.emptyList());
        HashicorpVaultFactory.VaultConfig vc = HashicorpVaultFactory.readConfig(def);
        assertEquals("http://myvault:8200", vc.address);
        assertEquals("kv", vc.mount);
        assertEquals(1, vc.version);
        assertEquals("ns1", vc.namespace);
        assertEquals("app", vc.path);
    }

    @Test
    void factoryDefaultConfig() {
        VaultDefinition def = new VaultDefinition("hashicorp-vault",
                new VaultDefinition.Auth(null, null, null, null),
                Collections.emptyMap(), Collections.emptyList());
        HashicorpVaultFactory.VaultConfig vc = HashicorpVaultFactory.readConfig(def);
        assertEquals("secret", vc.mount);
        assertEquals(2, vc.version);
        assertNull(vc.address);
        assertNull(vc.namespace);
    }

    @Test
    void factoryWithClientCreatesProvider() throws CnosError {
        SecretVaultProviderFactory factory = HashicorpVaultFactory.factoryWithClient(fakeClient);
        assertEquals("hashicorp-vault", factory.getProvider());
        ai.kitsy.cnos.SecretVaultProvider p = factory.create("test-vault", definition);
        assertNotNull(p);
    }

    // ── helpers ──────────────────────────────────────────────────────────────

    static Map<String, Object> mapOf(String... kvs) {
        Map<String, Object> map = new LinkedHashMap<>();
        for (int i = 0; i < kvs.length - 1; i += 2) map.put(kvs[i], kvs[i + 1]);
        return map;
    }

    /**
     * Wraps KV data in the structure returned by the HashiCorp v2 HTTP API.
     * The real v2 response is {data: {data: {...}, metadata: {...}}}.
     * The HTTP adapter returns body.get("data"), so the FakeClient must return
     * {"data": {...}} to simulate the outer data envelope.
     */
    static Map<String, Object> v2Data(String... kvs) {
        Map<String, Object> inner = mapOf(kvs);
        Map<String, Object> outer = new LinkedHashMap<>();
        outer.put("data", inner);
        return outer;
    }

    /** In-memory Vault KV2 fake. Stores flat path → raw data map. */
    static final class FakeClient implements HashicorpVaultProvider.Client {
        final Map<String, Map<String, Object>> data = new HashMap<>();

        @Override
        public ReadResult read(String path, String token, String namespace) {
            Map<String, Object> raw = data.get(path);
            if (raw == null) return new ReadResult(null, 404);
            return new ReadResult(raw, 200);
        }
    }
}

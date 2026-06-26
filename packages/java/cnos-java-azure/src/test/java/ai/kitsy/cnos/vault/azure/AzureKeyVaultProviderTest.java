package ai.kitsy.cnos.vault.azure;

import ai.kitsy.cnos.*;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.net.URI;
import java.util.*;

import static org.junit.jupiter.api.Assertions.*;

class AzureKeyVaultProviderTest {

    private static final String VAULT_URL = "https://myvault.vault.azure.net";
    private static final String VAULT_ORIGIN = "https://myvault.vault.azure.net";

    private FakeClient fakeClient;
    private VaultDefinition definition;
    private AzureKeyVaultProvider provider;

    @BeforeEach
    void setUp() {
        fakeClient = new FakeClient();
        definition = new VaultDefinition("azure-key-vault",
                new VaultDefinition.Auth(null, null, null, null),
                Collections.emptyMap(),
                Collections.emptyList());
        provider = new AzureKeyVaultProvider("test-vault", definition,
                VAULT_URL, VAULT_ORIGIN, null, fakeClient);
    }

    @Test
    void authenticateWithIamSucceeds() {
        assertDoesNotThrow(() ->
                provider.authenticate(VaultAuthConfig.ofMethod("iam", Collections.emptyMap())));
    }

    @Test
    void authenticateWithEnvironmentSucceeds() {
        assertDoesNotThrow(() ->
                provider.authenticate(VaultAuthConfig.ofMethod("environment", Collections.emptyMap())));
    }

    @Test
    void authenticateWithTokenFails() {
        assertThrows(CnosError.class, () ->
                provider.authenticate(VaultAuthConfig.ofToken("tok", Collections.emptyMap())));
    }

    @Test
    void getSimpleNameSecret() throws CnosError {
        fakeClient.secrets.put("my-secret:", "secret-value");
        Object result = provider.get("my-secret");
        assertEquals("secret-value", result);
    }

    @Test
    void getReturnsNullWhenNotFound() throws CnosError {
        Object result = provider.get("missing-secret");
        assertNull(result);
    }

    @Test
    void getFullUrl() throws CnosError {
        fakeClient.secrets.put("my-secret:", "url-value");
        String fullUrl = VAULT_URL + "/secrets/my-secret";
        Object result = provider.get(fullUrl);
        assertEquals("url-value", result);
    }

    @Test
    void getFullUrlWithVersion() throws CnosError {
        fakeClient.secrets.put("my-secret:v1", "versioned-value");
        String fullUrl = VAULT_URL + "/secrets/my-secret/v1";
        Object result = provider.get(fullUrl);
        assertEquals("versioned-value", result);
    }

    @Test
    void getWithConfigVersion() throws CnosError {
        AzureKeyVaultProvider versioned = new AzureKeyVaultProvider("test-vault", definition,
                VAULT_URL, VAULT_ORIGIN, "v2", fakeClient);
        fakeClient.secrets.put("my-secret:v2", "v2-value");
        Object result = versioned.get("my-secret");
        assertEquals("v2-value", result);
    }

    @Test
    void getWithMapping() throws CnosError {
        Map<String, String> mapping = new HashMap<>();
        mapping.put("external-secret", "logical-ref");
        VaultDefinition mapped = new VaultDefinition("azure-key-vault",
                new VaultDefinition.Auth(null, null, null, null),
                mapping, Collections.emptyList());
        AzureKeyVaultProvider mappedProvider = new AzureKeyVaultProvider(
                "test-vault", mapped, VAULT_URL, VAULT_ORIGIN, null, fakeClient);
        fakeClient.secrets.put("external-secret:", "mapped-value");
        Object result = mappedProvider.get("logical-ref");
        assertEquals("mapped-value", result);
    }

    @Test
    void getCrossVaultUrlThrows() {
        String wrongVaultUrl = "https://otherwault.vault.azure.net/secrets/secret";
        assertThrows(CnosError.class, () -> provider.get(wrongVaultUrl));
    }

    @Test
    void batchGetReturnsMultipleValues() throws CnosError {
        fakeClient.secrets.put("a:", "va");
        fakeClient.secrets.put("b:", "vb");
        Map<String, Object> result = provider.batchGet(Arrays.asList("a", "b"));
        assertEquals("va", result.get("a"));
        assertEquals("vb", result.get("b"));
    }

    @Test
    void parseSecretRefSimpleName() throws CnosError {
        AzureKeyVaultProvider.ParsedRef ref = AzureKeyVaultProvider.parseSecretRef("my-secret", "v");
        assertEquals("my-secret", ref.name());
        assertNull(ref.version());
        assertFalse(ref.fullUrl());
    }

    @Test
    void parseSecretRefFullUrl() throws CnosError {
        String url = "https://myvault.vault.azure.net/secrets/my-secret";
        AzureKeyVaultProvider.ParsedRef ref = AzureKeyVaultProvider.parseSecretRef(url, "v");
        assertEquals("my-secret", ref.name());
        assertNull(ref.version());
        assertTrue(ref.fullUrl());
        assertEquals("https://myvault.vault.azure.net", ref.origin());
    }

    @Test
    void parseSecretRefFullUrlWithVersion() throws CnosError {
        String url = "https://myvault.vault.azure.net/secrets/my-secret/abc123";
        AzureKeyVaultProvider.ParsedRef ref = AzureKeyVaultProvider.parseSecretRef(url, "v");
        assertEquals("my-secret", ref.name());
        assertEquals("abc123", ref.version());
        assertTrue(ref.fullUrl());
    }

    @Test
    void parseSecretRefPercentEncodedName() throws CnosError {
        // %2D is '-'; full URL with encoded name must decode correctly
        String url = "https://myvault.vault.azure.net/secrets/my%2Dname";
        AzureKeyVaultProvider.ParsedRef ref = AzureKeyVaultProvider.parseSecretRef(url, "v");
        assertEquals("my-name", ref.name());
        assertNull(ref.version());
    }

    @Test
    void parseSecretRefPercentEncodedVersion() throws CnosError {
        // %2D in version segment
        String url = "https://myvault.vault.azure.net/secrets/my-secret/v1%2D0";
        AzureKeyVaultProvider.ParsedRef ref = AzureKeyVaultProvider.parseSecretRef(url, "v");
        assertEquals("my-secret", ref.name());
        assertEquals("v1-0", ref.version());
    }

    @Test
    void parseSecretRefLiteralPlusPreserved() throws CnosError {
        // literal '+' in a secret name must NOT be decoded to a space
        String url = "https://myvault.vault.azure.net/secrets/my+secret";
        AzureKeyVaultProvider.ParsedRef ref = AzureKeyVaultProvider.parseSecretRef(url, "v");
        assertEquals("my+secret", ref.name());
    }

    @Test
    void parseSecretRefPercentEncodedPlus() throws CnosError {
        // %2B should decode to '+'
        String url = "https://myvault.vault.azure.net/secrets/my%2Bsecret";
        AzureKeyVaultProvider.ParsedRef ref = AzureKeyVaultProvider.parseSecretRef(url, "v");
        assertEquals("my+secret", ref.name());
    }

    @Test
    void parseSecretRefInvalidUrlThrows() {
        assertThrows(CnosError.class, () ->
                AzureKeyVaultProvider.parseSecretRef("https://vault/wrong-path", "v"));
    }

    @Test
    void parseSecretRefEmptyNameThrows() {
        assertThrows(CnosError.class, () ->
                AzureKeyVaultProvider.parseSecretRef("", "v"));
    }

    @Test
    void originForUrl() {
        assertEquals("https://myvault.vault.azure.net",
                AzureKeyVaultProvider.originForUrl("https://myvault.vault.azure.net"));
        assertEquals("https://myvault.vault.azure.net",
                AzureKeyVaultProvider.originForUrl("https://myvault.vault.azure.net/secrets/foo"));
        assertNull(AzureKeyVaultProvider.originForUrl(null));
        assertNull(AzureKeyVaultProvider.originForUrl(""));
    }

    @Test
    void factoryReadConfig() {
        Map<String, Object> config = new HashMap<>();
        config.put("vaultUrl", "https://testvault.vault.azure.net");
        config.put("version", "v3");
        config.put("tenantId", "tenant-123");
        config.put("clientId", "client-abc");
        VaultDefinition def = new VaultDefinition("azure-key-vault",
                new VaultDefinition.Auth(null, null, null, config),
                Collections.emptyMap(), Collections.emptyList());
        AzureVaultFactory.VaultConfig vc = AzureVaultFactory.readConfig(def);
        assertEquals("https://testvault.vault.azure.net", vc.vaultUrl);
        assertEquals("https://testvault.vault.azure.net", vc.origin);
        assertEquals("v3", vc.version);
        assertEquals("tenant-123", vc.tenantId);
        assertEquals("client-abc", vc.clientId);
    }

    @Test
    void factoryWithClientCreatesProvider() throws CnosError {
        SecretVaultProviderFactory factory = AzureVaultFactory.factoryWithClient(fakeClient);
        assertEquals("azure-key-vault", factory.getProvider());
        SecretVaultProvider p = factory.create("test-vault", definition);
        assertNotNull(p);
    }

    // ── fake client ──────────────────────────────────────────────────────────

    /** In-memory Azure KV fake. Key format: "{name}:{version}" (empty version string if none). */
    static final class FakeClient implements AzureKeyVaultProvider.Client {
        final Map<String, String> secrets = new HashMap<>();

        @Override
        public String getSecret(String name, String version) {
            String key = name + ":" + (version != null ? version : "");
            return secrets.get(key);
        }
    }
}

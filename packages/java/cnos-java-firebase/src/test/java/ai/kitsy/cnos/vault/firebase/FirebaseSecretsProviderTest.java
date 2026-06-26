package ai.kitsy.cnos.vault.firebase;

import ai.kitsy.cnos.*;
import ai.kitsy.cnos.vault.gcp.GcpSecretManagerProvider;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.util.*;

import static org.junit.jupiter.api.Assertions.*;

class FirebaseSecretsProviderTest {

    private static final String PROJECT_ID = "my-firebase-project";

    private FakeGcpClient fakeClient;
    private VaultDefinition definition;
    private FirebaseSecretsProvider provider;

    @BeforeEach
    void setUp() {
        fakeClient = new FakeGcpClient(PROJECT_ID);
        definition = new VaultDefinition("firebase-secrets",
                new VaultDefinition.Auth(null, null, null, null),
                Collections.emptyMap(),
                Collections.emptyList());
        SecretVaultProviderFactory factory = FirebaseVaultFactory.factoryWithClient(fakeClient);
        try {
            provider = (FirebaseSecretsProvider) factory.create("test-vault", definition);
        } catch (CnosError e) {
            throw new RuntimeException(e);
        }
    }

    @Test
    void authenticateWithIamSucceeds() {
        assertDoesNotThrow(() ->
                provider.authenticate(VaultAuthConfig.ofMethod("iam", Collections.emptyMap())));
    }

    @Test
    void authenticateWithTokenFails() {
        assertThrows(CnosError.class, () ->
                provider.authenticate(VaultAuthConfig.ofToken("tok", Collections.emptyMap())));
    }

    @Test
    void getSingleSecret() throws CnosError {
        fakeClient.secrets.put("projects/my-firebase-project/secrets/my-secret/versions/latest",
                "firebase-value".getBytes(StandardCharsets.UTF_8));

        Object result = provider.get("my-secret");
        assertEquals("firebase-value", result);
    }

    @Test
    void getReturnsNullWhenNotFound() throws CnosError {
        Object result = provider.get("missing-secret");
        assertNull(result);
    }

    @Test
    void batchGetReturnsMultipleValues() throws CnosError {
        fakeClient.secrets.put("projects/my-firebase-project/secrets/a/versions/latest", "va".getBytes(StandardCharsets.UTF_8));
        fakeClient.secrets.put("projects/my-firebase-project/secrets/b/versions/latest", "vb".getBytes(StandardCharsets.UTF_8));

        Map<String, Object> result = provider.batchGet(Arrays.asList("a", "b"));
        assertEquals("va", result.get("a"));
        assertEquals("vb", result.get("b"));
    }

    @Test
    void getUsesMapping() throws CnosError {
        Map<String, String> mapping = new HashMap<>();
        mapping.put("firebase-external-name", "logical-ref");
        VaultDefinition mapped = new VaultDefinition("firebase-secrets",
                new VaultDefinition.Auth(null, null, null, null),
                mapping, Collections.emptyList());
        SecretVaultProviderFactory factory = FirebaseVaultFactory.factoryWithClient(fakeClient);
        SecretVaultProvider mappedProvider = factory.create("test-vault", mapped);

        fakeClient.secrets.put("projects/my-firebase-project/secrets/firebase-external-name/versions/latest",
                "mapped-value".getBytes(StandardCharsets.UTF_8));

        Object result = mappedProvider.get("logical-ref");
        assertEquals("mapped-value", result);
    }

    @Test
    void factoryProviderName() {
        SecretVaultProviderFactory factory = FirebaseVaultFactory.factoryWithClient(fakeClient);
        assertEquals("firebase-secrets", factory.getProvider());
    }

    @Test
    void toGcpDefinitionSetsGcpProvider() throws CnosError {
        // Verify the delegate uses GCP Secret Manager's URL format (projects/...)
        fakeClient.secrets.put("projects/my-firebase-project/secrets/my-secret/versions/latest",
                "value".getBytes(StandardCharsets.UTF_8));
        assertNotNull(provider.get("my-secret"));
    }

    // ── fake GCP client ───────────────────────────────────────────────────────

    static final class FakeGcpClient implements GcpSecretManagerProvider.Client {
        final Map<String, byte[]> secrets = new HashMap<>();
        private final String defaultProjectId;

        FakeGcpClient(String defaultProjectId) { this.defaultProjectId = defaultProjectId; }

        @Override
        public byte[] accessSecretVersion(String name) throws Exception {
            byte[] data = secrets.get(name);
            if (data == null) throw new Exception("NOT_FOUND: " + name);
            return data;
        }

        @Override
        public String projectId() { return defaultProjectId; }
    }
}

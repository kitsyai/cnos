package ai.kitsy.cnos.vault.gcp;

import ai.kitsy.cnos.*;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.util.*;

import static org.junit.jupiter.api.Assertions.*;

class GcpSecretManagerProviderTest {

    private static final String PROJECT_ID = "my-project";

    private FakeClient fakeClient;
    private VaultDefinition definition;
    private GcpSecretManagerProvider provider;

    @BeforeEach
    void setUp() {
        fakeClient = new FakeClient(PROJECT_ID);
        definition = new VaultDefinition("gcp-secret-manager",
                new VaultDefinition.Auth(null, null, null, null),
                Collections.emptyMap(),
                Collections.emptyList());
        provider = new GcpSecretManagerProvider("test-vault", definition,
                PROJECT_ID, null, "latest", fakeClient);
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
        fakeClient.secrets.put("projects/my-project/secrets/my-secret/versions/latest",
                "secret-value".getBytes(StandardCharsets.UTF_8));

        Object result = provider.get("my-secret");
        assertEquals("secret-value", result);
    }

    @Test
    void getReturnsNullWhenNotFound() throws CnosError {
        Object result = provider.get("missing-secret");
        assertNull(result);
    }

    @Test
    void batchGetReturnsMultipleValues() throws CnosError {
        fakeClient.secrets.put("projects/my-project/secrets/a/versions/latest", "va".getBytes(StandardCharsets.UTF_8));
        fakeClient.secrets.put("projects/my-project/secrets/b/versions/latest", "vb".getBytes(StandardCharsets.UTF_8));

        Map<String, Object> result = provider.batchGet(Arrays.asList("a", "b"));
        assertEquals("va", result.get("a"));
        assertEquals("vb", result.get("b"));
    }

    @Test
    void getUsesMapping() throws CnosError {
        Map<String, String> mapping = new HashMap<>();
        mapping.put("external-secret-name", "logical-ref");
        VaultDefinition mapped = new VaultDefinition("gcp-secret-manager",
                new VaultDefinition.Auth(null, null, null, null),
                mapping, Collections.emptyList());
        GcpSecretManagerProvider mappedProvider = new GcpSecretManagerProvider(
                "test-vault", mapped, PROJECT_ID, null, "latest", fakeClient);

        fakeClient.secrets.put("projects/my-project/secrets/external-secret-name/versions/latest",
                "mapped-value".getBytes(StandardCharsets.UTF_8));

        Object result = mappedProvider.get("logical-ref");
        assertEquals("mapped-value", result);
    }

    @Test
    void getWithCustomVersion() throws CnosError {
        GcpSecretManagerProvider versionedProvider = new GcpSecretManagerProvider(
                "test-vault", definition, PROJECT_ID, null, "3", fakeClient);

        fakeClient.secrets.put("projects/my-project/secrets/my-secret/versions/3",
                "v3-value".getBytes(StandardCharsets.UTF_8));

        Object result = versionedProvider.get("my-secret");
        assertEquals("v3-value", result);
    }

    @Test
    void getWithLocation() throws CnosError {
        GcpSecretManagerProvider regional = new GcpSecretManagerProvider(
                "test-vault", definition, PROJECT_ID, "us-central1", "latest", fakeClient);

        fakeClient.secrets.put("projects/my-project/locations/us-central1/secrets/regional-secret/versions/latest",
                "regional-value".getBytes(StandardCharsets.UTF_8));

        Object result = regional.get("regional-secret");
        assertEquals("regional-value", result);
    }

    @Test
    void getFullVersionName() throws CnosError {
        String fullName = "projects/my-project/secrets/full-secret/versions/2";
        fakeClient.secrets.put(fullName, "full-value".getBytes(StandardCharsets.UTF_8));

        Object result = provider.get(fullName);
        assertEquals("full-value", result);
    }

    static final class FakeClient implements GcpSecretManagerProvider.Client {
        final Map<String, byte[]> secrets = new HashMap<>();
        private final String defaultProjectId;

        FakeClient(String defaultProjectId) { this.defaultProjectId = defaultProjectId; }

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

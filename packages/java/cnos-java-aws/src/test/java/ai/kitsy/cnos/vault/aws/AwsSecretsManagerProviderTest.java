package ai.kitsy.cnos.vault.aws;

import ai.kitsy.cnos.*;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import software.amazon.awssdk.core.SdkBytes;
import software.amazon.awssdk.services.secretsmanager.model.*;

import java.util.*;

import static org.junit.jupiter.api.Assertions.*;

class AwsSecretsManagerProviderTest {

    private FakeClient fakeClient;
    private VaultDefinition definition;
    private AwsSecretsManagerProvider provider;

    @BeforeEach
    void setUp() {
        fakeClient = new FakeClient();
        definition = new VaultDefinition("aws-secrets-manager",
                new VaultDefinition.Auth(null, null, null, null),
                Collections.emptyMap(),
                Collections.emptyList());
        provider = new AwsSecretsManagerProvider("test-vault", definition, null, null, fakeClient);
    }

    @Test
    void authenticateWithIamSucceeds() throws CnosError {
        assertDoesNotThrow(() ->
                provider.authenticate(VaultAuthConfig.ofMethod("iam", Collections.emptyMap())));
    }

    @Test
    void authenticateWithEnvironmentSucceeds() throws CnosError {
        assertDoesNotThrow(() ->
                provider.authenticate(VaultAuthConfig.ofMethod("environment", Collections.emptyMap())));
    }

    @Test
    void authenticateWithTokenFails() {
        assertThrows(CnosError.class, () ->
                provider.authenticate(VaultAuthConfig.ofToken("tok", Collections.emptyMap())));
    }

    @Test
    void batchGetReturnsValues() throws CnosError {
        fakeClient.batchResponse = BatchGetSecretValueResponse.builder()
                .secretValues(
                        SecretValueEntry.builder().name("secret-a").secretString("value-a").build(),
                        SecretValueEntry.builder().name("secret-b").secretString("value-b").build())
                .build();

        Map<String, Object> result = provider.batchGet(Arrays.asList("secret-a", "secret-b"));
        assertEquals("value-a", result.get("secret-a"));
        assertEquals("value-b", result.get("secret-b"));
    }

    @Test
    void batchGetRespectsMapping() throws CnosError {
        Map<String, String> mapping = new HashMap<>();
        mapping.put("external-name", "logical-ref");
        VaultDefinition mapped = new VaultDefinition("aws-secrets-manager",
                new VaultDefinition.Auth(null, null, null, null),
                mapping, Collections.emptyList());
        AwsSecretsManagerProvider mappedProvider =
                new AwsSecretsManagerProvider("test-vault", mapped, null, null, fakeClient);

        fakeClient.batchResponse = BatchGetSecretValueResponse.builder()
                .secretValues(
                        SecretValueEntry.builder().name("external-name").secretString("secret-val").build())
                .build();

        Map<String, Object> result = mappedProvider.batchGet(Collections.singletonList("logical-ref"));
        assertEquals("secret-val", result.get("logical-ref"));
    }

    @Test
    void getReturnsValue() throws CnosError {
        fakeClient.getResponse = GetSecretValueResponse.builder()
                .name("my-secret")
                .secretString("my-value")
                .build();

        Object result = provider.get("my-secret");
        assertEquals("my-value", result);
    }

    @Test
    void getReturnsNullOn404() throws CnosError {
        fakeClient.throwResourceNotFound = true;
        Object result = provider.get("missing-secret");
        assertNull(result);
    }

    @Test
    void getReturnsBinaryValue() throws CnosError {
        fakeClient.getResponse = GetSecretValueResponse.builder()
                .name("binary-secret")
                .secretBinary(SdkBytes.fromByteArray("binary-data".getBytes()))
                .build();

        Object result = provider.get("binary-secret");
        assertEquals("binary-data", result);
    }

    @Test
    void batchGetDeduplicatesRefs() throws CnosError {
        fakeClient.batchResponse = BatchGetSecretValueResponse.builder()
                .secretValues(
                        SecretValueEntry.builder().name("a").secretString("va").build())
                .build();

        // Duplicates should be deduplicated before sending to batch
        Map<String, Object> result = provider.batchGet(Arrays.asList("a", "a", "a"));
        assertEquals(1, fakeClient.lastBatchRequest.secretIdList().size());
        assertEquals("va", result.get("a"));
    }

    /** Fake client for testing without real AWS. */
    static final class FakeClient implements AwsSecretsManagerProvider.Client {
        BatchGetSecretValueResponse batchResponse;
        GetSecretValueResponse getResponse;
        boolean throwResourceNotFound;
        BatchGetSecretValueRequest lastBatchRequest;

        @Override
        public BatchGetSecretValueResponse batchGetSecretValue(BatchGetSecretValueRequest request) {
            lastBatchRequest = request;
            if (batchResponse != null) return batchResponse;
            return BatchGetSecretValueResponse.builder().build();
        }

        @Override
        public GetSecretValueResponse getSecretValue(GetSecretValueRequest request) {
            if (throwResourceNotFound) throw ResourceNotFoundException.builder().build();
            if (getResponse != null) return getResponse;
            throw ResourceNotFoundException.builder().build();
        }
    }
}

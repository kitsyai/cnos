package ai.kitsy.cnos.vault.aws;

import ai.kitsy.cnos.CnosError;
import ai.kitsy.cnos.SecretVaultProvider;
import ai.kitsy.cnos.VaultAuthConfig;
import ai.kitsy.cnos.VaultDefinition;
import software.amazon.awssdk.services.secretsmanager.SecretsManagerClient;
import software.amazon.awssdk.services.secretsmanager.model.*;

import java.util.*;

/**
 * CNOS provider for AWS Secrets Manager.
 * Provider name: {@code aws-secrets-manager}.
 */
public final class AwsSecretsManagerProvider implements SecretVaultProvider {

    /** Narrow client interface, injectable for testing. */
    public interface Client {
        BatchGetSecretValueResponse batchGetSecretValue(BatchGetSecretValueRequest request);
        GetSecretValueResponse getSecretValue(GetSecretValueRequest request);
    }

    private final String vaultId;
    private final VaultDefinition definition;
    private final String versionId;
    private final String versionStage;
    private final Client client;
    private boolean authenticated;

    AwsSecretsManagerProvider(String vaultId, VaultDefinition definition,
            String versionId, String versionStage, Client client) {
        this.vaultId = vaultId;
        this.definition = definition;
        this.versionId = versionId;
        this.versionStage = versionStage;
        this.client = client;
    }

    @Override
    public void authenticate(VaultAuthConfig auth) throws CnosError {
        if (!"iam".equals(auth.getMethod()) && !"environment".equals(auth.getMethod())) {
            throw new CnosError("vault \"" + vaultId
                    + "\" uses aws-secrets-manager and requires iam authentication");
        }
        authenticated = true;
    }

    @Override
    public Map<String, Object> batchGet(List<String> refs) throws CnosError {
        List<String> unique = uniqueSorted(refs);
        Map<String, Object> resolved = new LinkedHashMap<>();

        // If version params set, fall back to individual gets
        if (versionId != null || versionStage != null) {
            for (String ref : unique) {
                Object v = get(ref);
                if (v != null) resolved.put(ref, v);
            }
            return resolved;
        }

        // Build external→logical mapping
        Map<String, String> externalToLogical = new LinkedHashMap<>();
        List<String> secretIds = new ArrayList<>();
        for (String ref : unique) {
            String external = externalIdForRef(ref);
            externalToLogical.put(external, ref);
            secretIds.add(external);
        }

        try {
            BatchGetSecretValueResponse response = client.batchGetSecretValue(
                    BatchGetSecretValueRequest.builder().secretIdList(secretIds).build());

            // Check for non-404 errors
            if (response.hasErrors()) {
                for (APIErrorType err : response.errors()) {
                    if (!"ResourceNotFoundException".equals(err.errorCode())) {
                        String msg = err.errorCode() != null ? err.errorCode() : "UnknownError";
                        if (err.message() != null) msg += ": " + err.message();
                        throw new CnosError("AWS Secrets Manager batch read failed for \""
                                + err.secretId() + "\": " + msg);
                    }
                }
            }

            for (SecretValueEntry entry : response.secretValues()) {
                String logical = resolveOutputRef(entry, externalToLogical);
                String value = decodeSecretEntry(entry);
                if (logical != null && !logical.isEmpty() && value != null) {
                    resolved.put(logical, value);
                }
            }
        } catch (CnosError e) {
            throw e;
        } catch (Exception e) {
            // BatchGet not supported — fall back to individual gets
            if (isResourceNotFound(e)) {
                return getEach(unique);
            }
            return getEach(unique);
        }

        return resolved;
    }

    @Override
    public Object get(String ref) throws CnosError {
        GetSecretValueRequest.Builder reqBuilder = GetSecretValueRequest.builder()
                .secretId(externalIdForRef(ref));
        if (versionId != null) reqBuilder.versionId(versionId);
        if (versionStage != null) reqBuilder.versionStage(versionStage);

        try {
            GetSecretValueResponse response = client.getSecretValue(reqBuilder.build());
            return decodeGetResponse(response);
        } catch (Exception e) {
            if (isResourceNotFound(e)) return null;
            throw new CnosError("AWS Secrets Manager get failed for ref \"" + ref + "\": " + e.getMessage(), e);
        }
    }

    private Map<String, Object> getEach(List<String> refs) throws CnosError {
        Map<String, Object> result = new LinkedHashMap<>();
        for (String ref : refs) {
            Object v = get(ref);
            if (v != null) result.put(ref, v);
        }
        return result;
    }

    private String externalIdForRef(String ref) {
        for (Map.Entry<String, String> e : definition.getMapping().entrySet()) {
            if (ref.equals(e.getValue())) return e.getKey();
        }
        return ref;
    }

    private String logicalRefForExternalId(String externalId) {
        String mapped = definition.getMapping().get(externalId);
        return mapped != null ? mapped : externalId;
    }

    private String resolveOutputRef(SecretValueEntry entry, Map<String, String> externalToLogical) {
        if (entry.arn() != null) {
            String logical = externalToLogical.get(entry.arn());
            if (logical != null) return logical;
        }
        if (entry.name() != null) {
            String logical = externalToLogical.get(entry.name());
            if (logical != null) return logical;
            return logicalRefForExternalId(entry.name());
        }
        return null;
    }

    private static String decodeSecretEntry(SecretValueEntry entry) {
        if (entry.secretString() != null) return entry.secretString();
        if (entry.secretBinary() != null) return new String(entry.secretBinary().asByteArray());
        return null;
    }

    private static String decodeGetResponse(GetSecretValueResponse response) {
        if (response.secretString() != null) return response.secretString();
        if (response.secretBinary() != null) return new String(response.secretBinary().asByteArray());
        return null;
    }

    private static boolean isResourceNotFound(Exception e) {
        if (e instanceof ResourceNotFoundException) return true;
        return e.getClass().getSimpleName().contains("ResourceNotFoundException");
    }

    private static List<String> uniqueSorted(List<String> refs) {
        Set<String> seen = new LinkedHashSet<>();
        for (String r : refs) if (r != null) seen.add(r);
        List<String> result = new ArrayList<>(seen);
        Collections.sort(result);
        return result;
    }

    /** SDK-backed client adapter. */
    static final class SdkClientAdapter implements Client {
        private final SecretsManagerClient sdk;

        SdkClientAdapter(SecretsManagerClient sdk) { this.sdk = sdk; }

        @Override
        public BatchGetSecretValueResponse batchGetSecretValue(BatchGetSecretValueRequest request) {
            return sdk.batchGetSecretValue(request);
        }

        @Override
        public GetSecretValueResponse getSecretValue(GetSecretValueRequest request) {
            return sdk.getSecretValue(request);
        }
    }
}

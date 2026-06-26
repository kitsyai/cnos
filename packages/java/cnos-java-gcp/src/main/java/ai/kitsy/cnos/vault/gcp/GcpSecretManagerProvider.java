package ai.kitsy.cnos.vault.gcp;

import ai.kitsy.cnos.CnosError;
import ai.kitsy.cnos.SecretVaultProvider;
import ai.kitsy.cnos.VaultAuthConfig;
import ai.kitsy.cnos.VaultDefinition;

import java.util.*;
import java.util.regex.Pattern;

/**
 * CNOS provider for GCP Secret Manager.
 * Provider name: {@code gcp-secret-manager}.
 */
public final class GcpSecretManagerProvider implements SecretVaultProvider {

    private static final Pattern FULL_VERSION_NAME = Pattern.compile(
            "^projects/[^/]+/(locations/[^/]+/)?secrets/[^/]+/versions/[^/]+$");

    /** Narrow GCP client interface, injectable for testing. */
    public interface Client {
        byte[] accessSecretVersion(String name) throws Exception;
        String projectId() throws Exception;
    }

    private final String vaultId;
    private final VaultDefinition definition;
    private final String configProjectId;
    private final String configLocation;
    private final String configVersion;
    private final Client client;
    private boolean authenticated;

    public GcpSecretManagerProvider(String vaultId, VaultDefinition definition,
            String configProjectId, String configLocation, String configVersion,
            Client client) {
        this.vaultId = vaultId;
        this.definition = definition;
        this.configProjectId = configProjectId;
        this.configLocation = configLocation;
        this.configVersion = configVersion;
        this.client = client;
    }

    @Override
    public void authenticate(VaultAuthConfig auth) throws CnosError {
        if (!"iam".equals(auth.getMethod()) && !"environment".equals(auth.getMethod())) {
            throw new CnosError("vault \"" + vaultId
                    + "\" uses gcp-secret-manager and requires iam authentication");
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
        try {
            String name = versionNameForRef(ref);
            byte[] data = client.accessSecretVersion(name);
            return data != null ? new String(data, java.nio.charset.StandardCharsets.UTF_8) : null;
        } catch (CnosError e) {
            throw e;
        } catch (Exception e) {
            if (isNotFound(e)) return null;
            throw new CnosError("GCP Secret Manager get failed for ref \"" + ref + "\": " + e.getMessage(), e);
        }
    }

    private String versionNameForRef(String ref) throws CnosError {
        String secretId = externalIdForRef(ref);
        if (FULL_VERSION_NAME.matcher(secretId).matches()) return secretId;

        String projectId = resolveProjectId();
        String version = configVersion != null && !configVersion.isEmpty() ? configVersion : "latest";

        if (configLocation != null && !configLocation.isEmpty()) {
            return String.format("projects/%s/locations/%s/secrets/%s/versions/%s",
                    projectId, configLocation, secretId, version);
        }
        return String.format("projects/%s/secrets/%s/versions/%s", projectId, secretId, version);
    }

    private String resolveProjectId() throws CnosError {
        if (configProjectId != null && !configProjectId.isEmpty()) return configProjectId;
        try {
            String id = client.projectId();
            if (id != null && !id.isEmpty()) return id;
        } catch (Exception ignored) {}
        throw new CnosError("vault \"" + vaultId
                + "\" requires auth.config.projectId when Google ADC cannot infer a project ID");
    }

    private String externalIdForRef(String ref) {
        for (Map.Entry<String, String> e : definition.getMapping().entrySet()) {
            if (ref.equals(e.getValue())) return e.getKey();
        }
        return ref;
    }

    private static boolean isNotFound(Exception e) {
        String msg = e.getClass().getName() + " " + e.getMessage();
        return msg.toLowerCase().contains("not found") || msg.contains("NOT_FOUND")
                || msg.contains("404");
    }

    static List<String> uniqueSorted(List<String> refs) {
        Set<String> seen = new LinkedHashSet<>();
        for (String r : refs) if (r != null) seen.add(r);
        List<String> result = new ArrayList<>(seen);
        Collections.sort(result);
        return result;
    }
}

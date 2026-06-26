package ai.kitsy.cnos;

import java.util.List;
import java.util.Map;

/**
 * Pluggable vault backend for resolving secret refs.
 */
public interface SecretVaultProvider {

    /**
     * Authenticates this provider using the resolved auth material.
     *
     * @param auth resolved auth config
     * @throws CnosError on authentication failure
     */
    void authenticate(VaultAuthConfig auth) throws CnosError;

    /**
     * Fetches multiple secret values in one operation.
     *
     * @param refs logical ref strings to fetch
     * @return map of ref to resolved value; absent entries mean the secret was not found
     * @throws CnosError on a non-404 error
     */
    Map<String, Object> batchGet(List<String> refs) throws CnosError;

    /**
     * Fetches a single secret value.
     *
     * @param ref logical ref string
     * @return the resolved value, or {@code null} if not found
     * @throws CnosError on a non-404 error
     */
    Object get(String ref) throws CnosError;
}

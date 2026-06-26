package ai.kitsy.cnos;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;

/**
 * Options for loading a CNOS runtime instance.
 */
public final class CnosOptions {

    private final String projectionPath;
    private final byte[] projectionData;
    private final String workingDir;
    private final Map<String, String> environment;
    private final String secretHome;
    private final List<SecretVaultProviderFactory> secretVaultProviders;

    private CnosOptions(Builder builder) {
        this.projectionPath = builder.projectionPath;
        this.projectionData = builder.projectionData;
        this.workingDir = builder.workingDir;
        this.environment = builder.environment != null
                ? Collections.unmodifiableMap(builder.environment) : null;
        this.secretHome = builder.secretHome;
        this.secretVaultProviders = Collections.unmodifiableList(
                builder.secretVaultProviders != null ? builder.secretVaultProviders : Collections.emptyList());
    }

    public String getProjectionPath() { return projectionPath; }
    public byte[] getProjectionData() { return projectionData; }
    public String getWorkingDir() { return workingDir; }
    public Map<String, String> getEnvironment() { return environment; }
    public String getSecretHome() { return secretHome; }
    public List<SecretVaultProviderFactory> getSecretVaultProviders() { return secretVaultProviders; }

    public static Builder builder() { return new Builder(); }

    /** Returns a default options instance (no overrides). */
    public static CnosOptions defaults() { return builder().build(); }

    public static final class Builder {
        private String projectionPath;
        private byte[] projectionData;
        private String workingDir;
        private Map<String, String> environment;
        private String secretHome;
        private List<SecretVaultProviderFactory> secretVaultProviders;

        private Builder() {}

        /** Explicit path to the .cnos-server.json projection file. */
        public Builder projectionPath(String projectionPath) {
            this.projectionPath = projectionPath;
            return this;
        }

        /** Explicit projection JSON bytes, bypassing file discovery. */
        public Builder projectionData(byte[] projectionData) {
            this.projectionData = projectionData;
            return this;
        }

        /** Working directory used for relative projection path resolution and file discovery. */
        public Builder workingDir(String workingDir) {
            this.workingDir = workingDir;
            return this;
        }

        /**
         * Override the process environment. When set, only these variables are visible;
         * the OS environment is ignored.
         */
        public Builder environment(Map<String, String> environment) {
            this.environment = environment;
            return this;
        }

        /** Override the secret home directory (default: {@code ~/.cnos/secrets}). */
        public Builder secretHome(String secretHome) {
            this.secretHome = secretHome;
            return this;
        }

        /** Register remote secret vault provider factories. */
        public Builder secretVaultProviders(List<SecretVaultProviderFactory> secretVaultProviders) {
            this.secretVaultProviders = new ArrayList<>(secretVaultProviders);
            return this;
        }

        /** Register a single remote secret vault provider factory. */
        public Builder addSecretVaultProvider(SecretVaultProviderFactory factory) {
            if (this.secretVaultProviders == null) {
                this.secretVaultProviders = new ArrayList<>();
            }
            this.secretVaultProviders.add(factory);
            return this;
        }

        public CnosOptions build() { return new CnosOptions(this); }
    }
}

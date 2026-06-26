package ai.kitsy.cnos;

/**
 * Options for {@link CnosRuntime#toEnv}.
 */
public final class ToEnvOptions {

    private final boolean includeSecrets;

    public ToEnvOptions(boolean includeSecrets) {
        this.includeSecrets = includeSecrets;
    }

    public ToEnvOptions() {
        this(false);
    }

    public boolean isIncludeSecrets() { return includeSecrets; }

    public ToEnvOptions withIncludeSecrets(boolean includeSecrets) {
        return new ToEnvOptions(includeSecrets);
    }
}

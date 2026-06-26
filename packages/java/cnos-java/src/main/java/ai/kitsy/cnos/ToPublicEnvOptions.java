package ai.kitsy.cnos;

/**
 * Options for {@link CnosRuntime#toPublicEnv}.
 */
public final class ToPublicEnvOptions {

    private final String framework;
    private final String prefix;

    public ToPublicEnvOptions(String framework, String prefix) {
        this.framework = framework;
        this.prefix = prefix;
    }

    public ToPublicEnvOptions() {
        this(null, null);
    }

    public String getFramework() { return framework; }
    public String getPrefix() { return prefix; }

    public ToPublicEnvOptions withFramework(String framework) {
        return new ToPublicEnvOptions(framework, prefix);
    }

    public ToPublicEnvOptions withPrefix(String prefix) {
        return new ToPublicEnvOptions(framework, prefix);
    }
}

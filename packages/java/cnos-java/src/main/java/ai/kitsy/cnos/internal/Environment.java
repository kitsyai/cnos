package ai.kitsy.cnos.internal;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * Abstraction over the process environment, with optional override map.
 * When the override map is null the real OS environment is used.
 */
public final class Environment {

    private final Map<String, String> override;
    private final boolean useOs;

    private Environment(Map<String, String> override, boolean useOs) {
        this.override = override;
        this.useOs = useOs;
    }

    /** Creates an environment that reads from the OS. */
    public static Environment ofOs() {
        return new Environment(null, true);
    }

    /**
     * Creates an environment backed by the given map.
     * The OS environment is NOT consulted.
     */
    public static Environment ofMap(Map<String, String> values) {
        return new Environment(values != null ? new HashMap<>(values) : new HashMap<>(), false);
    }

    /**
     * Creates an environment according to the options convention:
     * if {@code overrideMap} is null, use the real OS environment.
     */
    public static Environment of(Map<String, String> overrideMap) {
        if (overrideMap == null) {
            return ofOs();
        }
        return ofMap(overrideMap);
    }

    /** Returns the value for {@code key}, or empty if not present. */
    public Optional<String> get(String key) {
        if (useOs) {
            String value = System.getenv(key);
            return Optional.ofNullable(value);
        }
        if (override.containsKey(key)) {
            return Optional.of(override.get(key));
        }
        return Optional.empty();
    }

    /** Returns all env entries as KEY=VALUE strings, merging OS env and any overrides. */
    public List<String> processEnv() {
        Map<String, String> merged = new HashMap<>();
        // Seed with OS env
        for (Map.Entry<String, String> entry : System.getenv().entrySet()) {
            merged.put(entry.getKey(), entry.getValue());
        }
        // Apply overrides (only meaningful when override map is set)
        if (!useOs && override != null) {
            merged.putAll(override);
        }
        List<String> result = new ArrayList<>(merged.size());
        for (Map.Entry<String, String> entry : merged.entrySet()) {
            result.add(entry.getKey() + "=" + entry.getValue());
        }
        return result;
    }
}

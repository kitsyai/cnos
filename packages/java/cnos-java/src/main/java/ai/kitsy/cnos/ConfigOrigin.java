package ai.kitsy.cnos;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * Origin metadata for a config entry — where in source the value came from.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public final class ConfigOrigin {

    @JsonProperty("file")
    private final String file;

    @JsonProperty("line")
    private final int line;

    @JsonProperty("envVar")
    private final String envVar;

    @JsonProperty("cliArg")
    private final String cliArg;

    public ConfigOrigin(
            @JsonProperty("file") String file,
            @JsonProperty("line") int line,
            @JsonProperty("envVar") String envVar,
            @JsonProperty("cliArg") String cliArg) {
        this.file = file;
        this.line = line;
        this.envVar = envVar;
        this.cliArg = cliArg;
    }

    public String getFile() { return file; }
    public int getLine() { return line; }
    public String getEnvVar() { return envVar; }
    public String getCliArg() { return cliArg; }

    public ConfigOrigin copy() {
        return new ConfigOrigin(file, line, envVar, cliArg);
    }
}

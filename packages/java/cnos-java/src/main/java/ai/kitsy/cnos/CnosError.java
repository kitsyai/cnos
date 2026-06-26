package ai.kitsy.cnos;

/**
 * Base exception for all CNOS runtime errors.
 */
public class CnosError extends RuntimeException {

    /** Thrown when no server projection can be located. */
    public static final String PROJECTION_NOT_FOUND = "cnos: no server projection found";

    /** Thrown when a required config key is absent. */
    public static final String MISSING_KEY = "cnos: missing config key";

    public CnosError(String message) {
        super(message);
    }

    public CnosError(String message, Throwable cause) {
        super(message, cause);
    }

    /** Returns true when the error signals that no projection was found. */
    public boolean isProjectionNotFound() {
        return getMessage() != null && getMessage().startsWith(PROJECTION_NOT_FOUND);
    }
}

package ai.kitsy.cnos.internal;

import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.IOException;

/**
 * JS-compatible value serialization helpers, mirroring the Go jscompat.go functions.
 * Used for env var value serialization and derive concat operations.
 */
public final class JsCompat {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    private JsCompat() {}

    /**
     * Serializes a value to a string in JS-compatible format.
     * null → ""  (used for env var values)
     */
    public static String jsStringifyValue(Object value) {
        if (value == null) {
            return "";
        }
        if (value instanceof String) {
            return (String) value;
        }
        if (value instanceof Boolean) {
            return value.toString();
        }
        if (value instanceof Double) {
            return jsNumberString((Double) value);
        }
        if (value instanceof Float) {
            return jsNumberString(((Float) value).doubleValue());
        }
        if (value instanceof Long) {
            return Long.toString((Long) value);
        }
        if (value instanceof Integer) {
            return Integer.toString((Integer) value);
        }
        if (value instanceof Number) {
            // Covers BigDecimal, BigInteger, Short, Byte
            double d = ((Number) value).doubleValue();
            if (value instanceof java.math.BigDecimal || value instanceof Float) {
                return jsNumberString(d);
            }
            // Integer-like
            long l = ((Number) value).longValue();
            if ((double) l == d) {
                return Long.toString(l);
            }
            return jsNumberString(d);
        }
        // Objects and arrays: JSON-encode them
        try {
            return MAPPER.writeValueAsString(value);
        } catch (IOException e) {
            return value.toString();
        }
    }

    /**
     * Serializes a value for log message substitution.
     * null → "null"  (unlike jsStringifyValue which returns "")
     */
    public static String jsLogStringifyValue(Object value) {
        if (value == null) {
            return "null";
        }
        return jsStringifyValue(value);
    }

    /**
     * JS-compatible number string formatting.
     * Matches JavaScript's Number.prototype.toString() behavior:
     *  - No trailing zeros
     *  - Scientific notation for very large (&ge; 1e21) or very small (&lt; 1e-6) values
     */
    public static String jsNumberString(double value) {
        if (Double.isNaN(value)) return "NaN";
        if (Double.isInfinite(value)) return value > 0 ? "Infinity" : "-Infinity";
        if (value == 0.0) return "0";

        double abs = Math.abs(value);
        if (abs >= 1e-6 && abs < 1e21) {
            // Use plain decimal, strip trailing zeros
            String s = Double.toString(value);
            // Java's Double.toString may produce e.g. "1.0" or "1.23456789E10"
            if (s.contains("E") || s.contains("e")) {
                // Fall through to scientific notation formatting below
            } else {
                // Strip unnecessary trailing zero for whole doubles (e.g. "1.0" → "1")
                if (s.endsWith(".0")) {
                    return s.substring(0, s.length() - 2);
                }
                return s;
            }
        }

        // Scientific notation — strip leading zeros from exponent, remove '+' sign
        String formatted = String.format("%.20e", value);
        // Parse mantissa and exponent
        int eIdx = formatted.indexOf('e');
        if (eIdx < 0) return formatted;
        String mantissa = formatted.substring(0, eIdx);
        String expStr = formatted.substring(eIdx + 1);

        // Strip trailing zeros from mantissa
        if (mantissa.contains(".")) {
            mantissa = mantissa.replaceAll("0+$", "").replaceAll("\\.$", "");
        }

        // Parse exponent
        int exp = Integer.parseInt(expStr);
        String sign = exp < 0 ? "-" : "+";
        String expAbs = Integer.toString(Math.abs(exp));

        String expNormalized = expAbs.replaceAll("^0+", "");
        if (expNormalized.isEmpty()) expNormalized = "0";
        return mantissa + "e" + sign + expNormalized;
    }

    /**
     * JS strict equality — matches Go's jsStrictEqual.
     */
    public static boolean jsStrictEqual(Object left, Object right) {
        if (left == null && right == null) return true;
        if (left == null || right == null) return false;

        if (left instanceof Boolean && right instanceof Boolean) {
            return left.equals(right);
        }
        if (left instanceof String && right instanceof String) {
            return left.equals(right);
        }

        Double leftNum = numericValue(left);
        Double rightNum = numericValue(right);
        if (leftNum != null || rightNum != null) {
            if (leftNum == null || rightNum == null) return false;
            if (leftNum.isNaN() || rightNum.isNaN()) return false;
            return leftNum.equals(rightNum);
        }

        return false;
    }

    private static Double numericValue(Object value) {
        if (value instanceof Double) return (Double) value;
        if (value instanceof Float) return ((Float) value).doubleValue();
        if (value instanceof Long) return ((Long) value).doubleValue();
        if (value instanceof Integer) return ((Integer) value).doubleValue();
        if (value instanceof Number) return ((Number) value).doubleValue();
        return null;
    }

    /**
     * Returns the node.js platform string for the current OS.
     */
    public static String nodePlatform() {
        String os = System.getProperty("os.name", "").toLowerCase();
        if (os.contains("win")) return "win32";
        if (os.contains("mac")) return "darwin";
        if (os.contains("linux")) return "linux";
        if (os.contains("freebsd")) return "freebsd";
        if (os.contains("sunos") || os.contains("solaris")) return "sunos";
        if (os.contains("aix")) return "aix";
        return os;
    }

    /**
     * Returns the node.js arch string for the current CPU architecture.
     */
    public static String nodeArch() {
        String arch = System.getProperty("os.arch", "").toLowerCase();
        if (arch.equals("amd64") || arch.equals("x86_64")) return "x64";
        if (arch.equals("x86") || arch.equals("i386") || arch.equals("i686")) return "ia32";
        if (arch.equals("aarch64") || arch.equals("arm64")) return "arm64";
        if (arch.startsWith("arm")) return "arm";
        if (arch.contains("ppc64le")) return "ppc64le";
        if (arch.contains("ppc64")) return "ppc64";
        if (arch.contains("s390x")) return "s390x";
        return arch;
    }
}

using System;
using System.Text.Json;

namespace Kitsy.Cnos.Internal
{
    internal static class JsCompat
    {
        /// <summary>
        /// Serializes a value to a string in JS-compatible format.
        /// null → "" (used for env var values).
        /// </summary>
        public static string JsStringifyValue(object? value)
        {
            return value switch
            {
                null => "",
                string s => s,
                bool b => b ? "true" : "false",
                double d => JsNumberString(d),
                float f => JsNumberString(f),
                long l => l.ToString(),
                int i => i.ToString(),
                JsonElement el => JsStringifyElement(el),
                _ when IsIntegralNumber(value) => Convert.ToInt64(value).ToString(),
                _ when value is IConvertible => JsNumberString(Convert.ToDouble(value)),
                _ => JsonSerializer.Serialize(value),
            };
        }

        /// <summary>Serializes a value for log message substitution. null → "null".</summary>
        public static string JsLogStringifyValue(object? value) =>
            value == null ? "null" : JsStringifyValue(value);

        /// <summary>JS-compatible number formatting, matching JS Number.prototype.toString().</summary>
        public static string JsNumberString(double value)
        {
            if (double.IsNaN(value)) return "NaN";
            if (double.IsPositiveInfinity(value)) return "Infinity";
            if (double.IsNegativeInfinity(value)) return "-Infinity";
            if (value == 0.0) return "0";

            double abs = Math.Abs(value);
            if (abs >= 1e-6 && abs < 1e21)
            {
                string s = value.ToString("G17");
                // Strip trailing zeros and unnecessary decimal point
                if (s.Contains('.') && !s.Contains('E') && !s.Contains('e'))
                {
                    s = s.TrimEnd('0').TrimEnd('.');
                }
                return s;
            }

            // Scientific notation
            string formatted = value.ToString("0.####################e+0");
            return formatted.Replace("e+0", "e+0").Replace("e-0", "e-0"); // already compact
        }

        public static bool JsStrictEqual(object? left, object? right)
        {
            if (left == null && right == null) return true;
            if (left == null || right == null) return false;

            if (left is bool lb && right is bool rb) return lb == rb;
            if (left is string ls && right is string rs) return ls == rs;

            double? ln = NumericValue(left);
            double? rn = NumericValue(right);
            if (ln.HasValue || rn.HasValue)
            {
                if (!ln.HasValue || !rn.HasValue) return false;
                if (double.IsNaN(ln.Value) || double.IsNaN(rn.Value)) return false;
                return ln.Value == rn.Value;
            }

            return false;
        }

        public static bool IsTruthy(object? value) => value switch
        {
            null => false,
            bool b => b,
            string s => s.Length > 0,
            double d => d != 0.0,
            float f => f != 0.0f,
            long l => l != 0,
            int i => i != 0,
            _ when value is IConvertible => Convert.ToDouble(value) != 0.0,
            _ => true,
        };

        public static string NodePlatform()
        {
            string os = System.Runtime.InteropServices.RuntimeInformation.OSDescription.ToLowerInvariant();
            if (os.Contains("windows")) return "win32";
            if (os.Contains("darwin") || os.Contains("macos")) return "darwin";
            if (os.Contains("linux")) return "linux";
            if (os.Contains("freebsd")) return "freebsd";
            return "linux";
        }

        public static string NodeArch()
        {
            return System.Runtime.InteropServices.RuntimeInformation.ProcessArchitecture switch
            {
                System.Runtime.InteropServices.Architecture.X64 => "x64",
                System.Runtime.InteropServices.Architecture.X86 => "ia32",
                System.Runtime.InteropServices.Architecture.Arm64 => "arm64",
                System.Runtime.InteropServices.Architecture.Arm => "arm",
                _ => "x64",
            };
        }

        private static string JsStringifyElement(JsonElement el) => el.ValueKind switch
        {
            JsonValueKind.Null => "",
            JsonValueKind.True => "true",
            JsonValueKind.False => "false",
            JsonValueKind.String => el.GetString() ?? "",
            JsonValueKind.Number => el.TryGetDouble(out double d) ? JsNumberString(d) : el.ToString(),
            _ => el.GetRawText(),
        };

        private static bool IsIntegralNumber(object value) =>
            value is long || value is int || value is short || value is byte ||
            value is uint || value is ulong || value is ushort || value is sbyte;

        private static double? NumericValue(object? value) => value switch
        {
            double d => d,
            float f => (double)f,
            long l => (double)l,
            int i => (double)i,
            _ when value is IConvertible c => c.ToDouble(null),
            _ => null,
        };
    }
}

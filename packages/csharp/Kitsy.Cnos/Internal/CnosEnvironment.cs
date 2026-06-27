using System;
using System.Collections.Generic;

namespace Kitsy.Cnos.Internal
{
    internal sealed class CnosEnvironment
    {
        private readonly Dictionary<string, string> _vars;

        private CnosEnvironment(Dictionary<string, string> vars) => _vars = vars;

        public static CnosEnvironment Of(Dictionary<string, string>? overrides)
        {
            var vars = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (System.Collections.DictionaryEntry entry in System.Environment.GetEnvironmentVariables())
            {
                if (entry.Key is string k && entry.Value is string v)
                    vars[k] = v;
            }
            if (overrides != null)
            {
                foreach (var kv in overrides)
                    vars[kv.Key] = kv.Value;
            }
            return new CnosEnvironment(vars);
        }

        public bool TryGet(string key, out string value)
        {
            if (_vars.TryGetValue(key, out var v)) { value = v; return true; }
            value = "";
            return false;
        }

        public string? Get(string key) => _vars.TryGetValue(key, out var v) ? v : null;
    }
}

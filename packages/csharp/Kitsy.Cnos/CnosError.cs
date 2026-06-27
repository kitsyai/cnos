using System;

namespace Kitsy.Cnos
{
    /// <summary>CNOS runtime error.</summary>
    public class CnosError : Exception
    {
        public const string ProjectionNotFound = "cnos: projection not found";
        public const string MissingKey = "cnos: missing required config key";

        public CnosError(string message) : base(message) { }
        public CnosError(string message, Exception inner) : base(message, inner) { }
    }
}

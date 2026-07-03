using System;
using System.Collections.Generic;
using System.Text;
using Kitsy.Cnos;
using Xunit;

namespace Kitsy.Cnos.Tests
{
    // Serialize all tests in this class — Cnos singleton is process-wide static state.
    [Collection("Singleton")]
    public sealed class CnosTests : IDisposable
    {
        private static readonly string MinimalProjection = @"{
          ""version"": 1,
          ""workspace"": ""base"",
          ""profile"": ""local"",
          ""resolvedAt"": ""2024-01-01T00:00:00Z"",
          ""configHash"": ""abc123"",
          ""values"": {
            ""server.port"": 3000,
            ""app.name"": ""cnos-csharp""
          },
          ""derived"": {
            ""app.effectiveHost"": {
              ""expr"": ""coalesce(request.headers.host, 'default.host')"",
              ""deps"": [],
              ""runtimeRefs"": [""request.headers.host""]
            }
          },
          ""secretRefs"": {},
          ""publicKeys"": [""app.name""],
          ""runtimeNamespaces"": [""request""],
          ""meta"": {
            ""workspace"": ""base"",
            ""profile"": ""local"",
            ""cnos_version"": ""1.14.0""
          }
        }";

        private static CnosRuntime MakeRuntime() =>
            CnosRuntime.LoadProjection(Encoding.UTF8.GetBytes(MinimalProjection));

        public CnosTests() => Cnos.ResetDefaultRuntime();
        public void Dispose() => Cnos.ResetDefaultRuntime();

        [Fact]
        public void ReadBeforeInitThrows()
        {
            var ex = Assert.Throws<CnosError>(() => Cnos.Read("value.server.port"));
            Assert.Contains("not initialized", ex.Message);
        }

        [Fact]
        public void SetDefaultRuntimeMakesReadWork()
        {
            Cnos.SetDefaultRuntime(MakeRuntime());
            var (value, found) = Cnos.Value("server.port");
            Assert.True(found);
            Assert.Equal(3000L, Convert.ToInt64(value));
        }

        [Fact]
        public void DefaultRuntimeReturnsSetInstance()
        {
            var rt = MakeRuntime();
            Cnos.SetDefaultRuntime(rt);
            Assert.Same(rt, Cnos.DefaultRuntime());
        }

        [Fact]
        public void RequireReturnsValue()
        {
            Cnos.SetDefaultRuntime(MakeRuntime());
            var v = Cnos.Require("value.app.name");
            Assert.Equal("cnos-csharp", v);
        }

        [Fact]
        public void ReadOrReturnsFallbackForMissingKey()
        {
            Cnos.SetDefaultRuntime(MakeRuntime());
            var v = Cnos.ReadOr("value.nonexistent", "fallback");
            Assert.Equal("fallback", v);
        }

        [Fact]
        public void ReadyIsIdempotentAfterSet()
        {
            Cnos.SetDefaultRuntime(MakeRuntime());
            var first = Cnos.DefaultRuntime();

            // ready() on an already-initialized singleton keeps the same instance
            Cnos.Ready();
            Assert.Same(first, Cnos.DefaultRuntime());
        }

        [Fact]
        public void ResetClearsRuntime()
        {
            Cnos.SetDefaultRuntime(MakeRuntime());
            Cnos.ResetDefaultRuntime();
            Assert.Throws<CnosError>(() => Cnos.Read("value.server.port"));
        }

        [Fact]
        public void FormatSubstitutesConfigKeys()
        {
            Cnos.SetDefaultRuntime(MakeRuntime());
            var msg = Cnos.Format("App: ${value.app.name}");
            Assert.Equal("App: cnos-csharp", msg);
        }

        [Fact]
        public void ToPublicEnvIncludesPromotedKeys()
        {
            Cnos.SetDefaultRuntime(MakeRuntime());
            var env = Cnos.ToPublicEnv(new ToPublicEnvOptions { Framework = "vite" });
            Assert.Equal("cnos-csharp", env["VITE_APP_NAME"]);
        }

        [Fact]
        public void RegisterRuntimeProviderDelegates()
        {
            Cnos.SetDefaultRuntime(MakeRuntime());
            Cnos.RegisterRuntimeProvider("request", path =>
                path == "headers.host" ? "console.kitsy.local" : null);

            var (host, found) = Cnos.Value("app.effectiveHost");
            Assert.True(found);
            Assert.Equal("console.kitsy.local", host);
        }
    }

    [CollectionDefinition("Singleton")]
    public sealed class SingletonCollection { }
}

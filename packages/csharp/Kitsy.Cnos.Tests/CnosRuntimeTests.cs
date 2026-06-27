using System;
using System.Collections.Generic;
using System.Text;
using Kitsy.Cnos;
using Xunit;

namespace Kitsy.Cnos.Tests
{
    public sealed class CnosRuntimeTests
    {
        private static readonly string MinimalProjection = @"{
          ""version"": 1,
          ""workspace"": ""base"",
          ""profile"": ""local"",
          ""resolvedAt"": ""2024-01-01T00:00:00Z"",
          ""configHash"": ""abc123"",
          ""values"": {
            ""server.port"": 3000,
            ""server.host"": ""localhost"",
            ""featureFlag"": true,
            ""app.name"": ""my-app""
          },
          ""derived"": {
            ""server.url"": {
              ""expr"": ""${value.server.host}:${value.server.port}"",
              ""deps"": [""value.server.host"", ""value.server.port""],
              ""runtimeRefs"": []
            }
          },
          ""secretRefs"": {
            ""db.password"": { ""provider"": ""environment"", ""ref"": ""DB_PASSWORD"", ""vault"": ""default"" }
          },
          ""publicKeys"": [""server.port""],
          ""runtimeNamespaces"": [],
          ""meta"": {
            ""workspace"": ""base"",
            ""profile"": ""local"",
            ""cnos_version"": ""1.11.4""
          }
        }";

        private readonly CnosRuntime _runtime;

        public CnosRuntimeTests()
        {
            _runtime = CnosRuntime.LoadProjection(
                Encoding.UTF8.GetBytes(MinimalProjection),
                new CnosOptions { Environment = new Dictionary<string, string> { ["DB_PASSWORD"] = "s3cr3t" } });
        }

        [Fact] public void LoadFromProjectionBytes() => Assert.NotNull(_runtime);

        [Fact]
        public void ReadValueKey()
        {
            var (value, found) = _runtime.Value("server.port");
            Assert.True(found);
            Assert.Equal(3000L, Convert.ToInt64(value));
        }

        [Fact]
        public void ReadStringValue()
        {
            var (value, found) = _runtime.Value("server.host");
            Assert.True(found);
            Assert.Equal("localhost", value);
        }

        [Fact]
        public void ReadBooleanValue()
        {
            var (value, found) = _runtime.Value("featureFlag");
            Assert.True(found);
            Assert.Equal(true, value);
        }

        [Fact]
        public void ReadAbsentKeyReturnsFalse()
        {
            var (_, found) = _runtime.Read("value.nonexistent");
            Assert.False(found);
        }

        [Fact]
        public void RequireAbsentKeyThrows()
        {
            Assert.Throws<CnosError>(() => _runtime.Require("value.nonexistent"));
        }

        [Fact]
        public void ReadDerivedTemplateFormula()
        {
            var (value, found) = _runtime.Value("server.url");
            Assert.True(found);
            Assert.Equal("localhost:3000", value);
        }

        [Fact]
        public void ReadMetaProfile()
        {
            var (value, found) = _runtime.Meta("profile");
            Assert.True(found);
            Assert.Equal("local", value);
        }

        [Fact]
        public void ReadMetaWorkspace()
        {
            var (value, found) = _runtime.Meta("workspace");
            Assert.True(found);
            Assert.Equal("base", value);
        }

        [Fact]
        public void ReadMetaCnosVersion()
        {
            var (value, found) = _runtime.Meta("cnos_version");
            Assert.True(found);
            Assert.Equal("1.11.4", value);
        }

        [Fact]
        public void ReadOrReturnsFallbackWhenAbsent()
        {
            object? result = _runtime.ReadOr("value.missing", "fallback");
            Assert.Equal("fallback", result);
        }

        [Fact]
        public void ReadOrReturnsValueWhenPresent()
        {
            object? result = _runtime.ReadOr("value.server.host", "fallback");
            Assert.Equal("localhost", result);
        }

        [Fact]
        public void ReadSecretFromEnvironment()
        {
            var (value, found) = _runtime.Secret("db.password");
            Assert.True(found);
            Assert.Equal("s3cr3t", value);
        }

        [Fact]
        public void ReadPublicKey()
        {
            var (value, found) = _runtime.Public("server.port");
            Assert.True(found);
            Assert.Equal(3000L, Convert.ToInt64(value));
        }

        [Fact]
        public void ToLogicalKeyIsIdempotent()
        {
            var (v1, f1) = _runtime.Value("server.host");
            var (v2, f2) = _runtime.Value("value.server.host");
            Assert.True(f1);
            Assert.True(f2);
            Assert.Equal(v1, v2);
        }

        [Fact]
        public void InvalidProjectionThrows()
        {
            Assert.Throws<CnosError>(() =>
                CnosRuntime.LoadProjection(Encoding.UTF8.GetBytes("{}"), null));
        }

        [Fact]
        public void MissingProjectionThrows()
        {
            Assert.Throws<CnosError>(() =>
                CnosRuntime.Load(new CnosOptions { WorkingDir = "/no-such-dir" }));
        }

        [Fact]
        public void FormatInterpolatesKeys()
        {
            string result = _runtime.Format("host=${value.server.host} port=${value.server.port}");
            Assert.Equal("host=localhost port=3000", result);
        }

        [Fact]
        public void ToPublicEnvContainsPromotedKeys()
        {
            var env = _runtime.ToPublicEnv();
            Assert.True(env.ContainsKey("SERVER_PORT"));
            Assert.Equal("3000", env["SERVER_PORT"]);
        }

        [Fact]
        public void ToPublicEnvAppliesFrameworkPrefix()
        {
            var env = _runtime.ToPublicEnv(new ToPublicEnvOptions { Framework = "next" });
            Assert.True(env.ContainsKey("NEXT_PUBLIC_SERVER_PORT"));
        }

        [Fact]
        public void RegisterAndCallRuntimeProvider()
        {
            string projection = @"{
              ""version"":1,""workspace"":""base"",""profile"":""local"",
              ""resolvedAt"":""2024-01-01T00:00:00Z"",""configHash"":""h"",
              ""values"":{},
              ""derived"":{""request.result"":{""expr"":""${request.user}"",""deps"":[],""runtimeRefs"":[""request.user""]}},
              ""secretRefs"":{},""publicKeys"":[],
              ""runtimeNamespaces"":[""request""],
              ""meta"":{""workspace"":""base"",""profile"":""local"",""cnos_version"":""1.11.4"",""namespaces"":[""request""]}
            }";
            var rt = CnosRuntime.LoadProjection(Encoding.UTF8.GetBytes(projection), null);
            rt.RegisterRuntimeProvider("request", path => path == "user" ? "alice" : null);

            var (value, found) = rt.Read("request.user");
            Assert.True(found);
            Assert.Equal("alice", value);
        }

        [Fact]
        public void RegisterRuntimeProviderForProcessThrows()
        {
            Assert.Throws<CnosError>(() =>
                _runtime.RegisterRuntimeProvider("process", _ => null));
        }

        [Fact]
        public void DerivedCyclicReferenceThrows()
        {
            string projection = @"{
              ""version"":1,""workspace"":""base"",""profile"":""local"",
              ""resolvedAt"":""2024-01-01T00:00:00Z"",""configHash"":""h"",
              ""values"":{},
              ""derived"":{
                ""value.a"":{""expr"":""${value.b}"",""deps"":[""value.b""],""runtimeRefs"":[]},
                ""value.b"":{""expr"":""${value.a}"",""deps"":[""value.a""],""runtimeRefs"":[]}
              },
              ""secretRefs"":{},""publicKeys"":[],""runtimeNamespaces"":[],
              ""meta"":{""workspace"":""base"",""profile"":""local"",""cnos_version"":""1.11.4""}
            }";
            Assert.Throws<CnosError>(() =>
                CnosRuntime.LoadProjection(Encoding.UTF8.GetBytes(projection), null));
        }
    }
}

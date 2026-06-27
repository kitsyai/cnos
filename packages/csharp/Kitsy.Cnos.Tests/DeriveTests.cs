using System;
using System.Text;
using Kitsy.Cnos;
using Xunit;

namespace Kitsy.Cnos.Tests
{
    public sealed class DeriveTests
    {
        private static CnosRuntime Load(string json) =>
            CnosRuntime.LoadProjection(Encoding.UTF8.GetBytes(json), null);

        [Fact]
        public void TemplateInterpolation()
        {
            var rt = Load(@"{
              ""version"":1,""workspace"":""base"",""profile"":""local"",
              ""resolvedAt"":""2024-01-01T00:00:00Z"",""configHash"":""h"",
              ""values"":{""server.host"":""localhost"",""server.port"":8080},
              ""derived"":{""value.url"":{""expr"":""${value.server.host}:${value.server.port}"",""deps"":[""value.server.host"",""value.server.port""],""runtimeRefs"":[]}},
              ""secretRefs"":{},""publicKeys"":[],""runtimeNamespaces"":[],
              ""meta"":{""workspace"":""base"",""profile"":""local"",""cnos_version"":""1.11.4""}
            }");
            var (v, found) = rt.Value("url");
            Assert.True(found);
            Assert.Equal("localhost:8080", v);
        }

        [Fact]
        public void CoalesceReturnsFirstNonNull()
        {
            var rt = Load(@"{
              ""version"":1,""workspace"":""base"",""profile"":""local"",
              ""resolvedAt"":""2024-01-01T00:00:00Z"",""configHash"":""h"",
              ""values"":{""x"":""hello""},
              ""derived"":{""value.result"":{""expr"":""coalesce(value.missing, value.x)"",""deps"":[""value.x""],""runtimeRefs"":[]}},
              ""secretRefs"":{},""publicKeys"":[],""runtimeNamespaces"":[],
              ""meta"":{""workspace"":""base"",""profile"":""local"",""cnos_version"":""1.11.4""}
            }");
            var (v, found) = rt.Value("result");
            Assert.True(found);
            Assert.Equal("hello", v);
        }

        [Fact]
        public void WhenTrueReturnsFirstBranch()
        {
            var rt = Load(@"{
              ""version"":1,""workspace"":""base"",""profile"":""local"",
              ""resolvedAt"":""2024-01-01T00:00:00Z"",""configHash"":""h"",
              ""values"":{""flag"":true},
              ""derived"":{""value.result"":{""expr"":""when(value.flag, 'yes', 'no')"",""deps"":[""value.flag""],""runtimeRefs"":[]}},
              ""secretRefs"":{},""publicKeys"":[],""runtimeNamespaces"":[],
              ""meta"":{""workspace"":""base"",""profile"":""local"",""cnos_version"":""1.11.4""}
            }");
            var (v, found) = rt.Value("result");
            Assert.True(found);
            Assert.Equal("yes", v);
        }

        [Fact]
        public void WhenFalseReturnsSecondBranch()
        {
            var rt = Load(@"{
              ""version"":1,""workspace"":""base"",""profile"":""local"",
              ""resolvedAt"":""2024-01-01T00:00:00Z"",""configHash"":""h"",
              ""values"":{""flag"":false},
              ""derived"":{""value.result"":{""expr"":""when(value.flag, 'yes', 'no')"",""deps"":[""value.flag""],""runtimeRefs"":[]}},
              ""secretRefs"":{},""publicKeys"":[],""runtimeNamespaces"":[],
              ""meta"":{""workspace"":""base"",""profile"":""local"",""cnos_version"":""1.11.4""}
            }");
            var (v, found) = rt.Value("result");
            Assert.True(found);
            Assert.Equal("no", v);
        }

        [Fact]
        public void ExistsReturnsTrueForPresentKey()
        {
            var rt = Load(@"{
              ""version"":1,""workspace"":""base"",""profile"":""local"",
              ""resolvedAt"":""2024-01-01T00:00:00Z"",""configHash"":""h"",
              ""values"":{""x"":""hello""},
              ""derived"":{""value.result"":{""expr"":""exists(value.x)"",""deps"":[""value.x""],""runtimeRefs"":[]}},
              ""secretRefs"":{},""publicKeys"":[],""runtimeNamespaces"":[],
              ""meta"":{""workspace"":""base"",""profile"":""local"",""cnos_version"":""1.11.4""}
            }");
            var (v, found) = rt.Value("result");
            Assert.True(found);
            Assert.Equal(true, v);
        }

        [Fact]
        public void EqReturnsTrueForEqualStrings()
        {
            var rt = Load(@"{
              ""version"":1,""workspace"":""base"",""profile"":""local"",
              ""resolvedAt"":""2024-01-01T00:00:00Z"",""configHash"":""h"",
              ""values"":{""env"":""prod""},
              ""derived"":{""value.result"":{""expr"":""eq(value.env, 'prod')"",""deps"":[""value.env""],""runtimeRefs"":[]}},
              ""secretRefs"":{},""publicKeys"":[],""runtimeNamespaces"":[],
              ""meta"":{""workspace"":""base"",""profile"":""local"",""cnos_version"":""1.11.4""}
            }");
            var (v, found) = rt.Value("result");
            Assert.True(found);
            Assert.Equal(true, v);
        }

        [Fact]
        public void ConfigOnlyDerivedValueIsCached()
        {
            var rt = Load(@"{
              ""version"":1,""workspace"":""base"",""profile"":""local"",
              ""resolvedAt"":""2024-01-01T00:00:00Z"",""configHash"":""h"",
              ""values"":{""base"":""hello""},
              ""derived"":{""value.result"":{""expr"":""${value.base}"",""deps"":[""value.base""],""runtimeRefs"":[]}},
              ""secretRefs"":{},""publicKeys"":[],""runtimeNamespaces"":[],
              ""meta"":{""workspace"":""base"",""profile"":""local"",""cnos_version"":""1.11.4""}
            }");
            var (v1, _) = rt.Value("result");
            var (v2, _) = rt.Value("result");
            Assert.Equal(v1, v2);
        }

        [Fact]
        public void LiteralStringInExpression()
        {
            var rt = Load(@"{
              ""version"":1,""workspace"":""base"",""profile"":""local"",
              ""resolvedAt"":""2024-01-01T00:00:00Z"",""configHash"":""h"",
              ""values"":{},
              ""derived"":{""value.result"":{""expr"":""'static-value'"",""deps"":[],""runtimeRefs"":[]}},
              ""secretRefs"":{},""publicKeys"":[],""runtimeNamespaces"":[],
              ""meta"":{""workspace"":""base"",""profile"":""local"",""cnos_version"":""1.11.4""}
            }");
            var (v, found) = rt.Value("result");
            Assert.True(found);
            Assert.Equal("static-value", v);
        }

        [Fact]
        public void LiteralNumberInExpression()
        {
            var rt = Load(@"{
              ""version"":1,""workspace"":""base"",""profile"":""local"",
              ""resolvedAt"":""2024-01-01T00:00:00Z"",""configHash"":""h"",
              ""values"":{},
              ""derived"":{""value.result"":{""expr"":""42"",""deps"":[],""runtimeRefs"":[]}},
              ""secretRefs"":{},""publicKeys"":[],""runtimeNamespaces"":[],
              ""meta"":{""workspace"":""base"",""profile"":""local"",""cnos_version"":""1.11.4""}
            }");
            var (v, found) = rt.Value("result");
            Assert.True(found);
            Assert.Equal(42.0, Convert.ToDouble(v));
        }

        [Fact]
        public void NeExpression()
        {
            var rt = Load(@"{
              ""version"":1,""workspace"":""base"",""profile"":""local"",
              ""resolvedAt"":""2024-01-01T00:00:00Z"",""configHash"":""h"",
              ""values"":{""env"":""dev""},
              ""derived"":{""value.result"":{""expr"":""ne(value.env, 'prod')"",""deps"":[""value.env""],""runtimeRefs"":[]}},
              ""secretRefs"":{},""publicKeys"":[],""runtimeNamespaces"":[],
              ""meta"":{""workspace"":""base"",""profile"":""local"",""cnos_version"":""1.11.4""}
            }");
            var (v, found) = rt.Value("result");
            Assert.True(found);
            Assert.Equal(true, v);
        }

        [Fact]
        public void LiteralBoolTrue()
        {
            var rt = Load(@"{
              ""version"":1,""workspace"":""base"",""profile"":""local"",
              ""resolvedAt"":""2024-01-01T00:00:00Z"",""configHash"":""h"",
              ""values"":{},
              ""derived"":{""value.result"":{""expr"":""true"",""deps"":[],""runtimeRefs"":[]}},
              ""secretRefs"":{},""publicKeys"":[],""runtimeNamespaces"":[],
              ""meta"":{""workspace"":""base"",""profile"":""local"",""cnos_version"":""1.11.4""}
            }");
            var (v, found) = rt.Value("result");
            Assert.True(found);
            Assert.Equal(true, v);
        }
    }
}

package ai.kitsy.cnos

import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test

class CnosRuntimeTest {

    private val MINIMAL = """
    {
      "version": 1,
      "workspace": "base",
      "profile": "local",
      "resolvedAt": "2024-01-01T00:00:00Z",
      "configHash": "abc123",
      "values": {
        "server.port": 3000,
        "server.host": "localhost",
        "featureFlag": true,
        "app.name": "my-app"
      },
      "derived": {
        "server.url": {
          "expr": "${'$'}{value.server.host}:${'$'}{value.server.port}",
          "deps": ["value.server.host","value.server.port"],
          "runtimeRefs": []
        }
      },
      "secretRefs": {
        "db.password": { "provider": "environment", "ref": "DB_PASSWORD", "vault": "default" }
      },
      "publicKeys": ["server.port"],
      "runtimeNamespaces": [],
      "meta": {
        "workspace": "base",
        "profile": "local",
        "cnos_version": "1.11.4"
      }
    }""".trimIndent()

    private fun makeRuntime(): CnosRuntime =
        CnosRuntime.loadProjection(
            MINIMAL.toByteArray(),
            CnosOptions(environment = mapOf("DB_PASSWORD" to "s3cr3t"))
        )

    @Test fun `load from projection bytes`() {
        val rt = makeRuntime()
        assertNotNull(rt.getProjection())
    }

    @Test fun `read value key`() {
        val v = makeRuntime().value("server.port")
        assertTrue(v.isPresent)
        assertEquals(3000L, (v.get() as Number).toLong())
    }

    @Test fun `read string value`() {
        val v = makeRuntime().value("server.host")
        assertTrue(v.isPresent)
        assertEquals("localhost", v.get())
    }

    @Test fun `read boolean value`() {
        val v = makeRuntime().value("featureFlag")
        assertTrue(v.isPresent)
        assertEquals(true, v.get())
    }

    @Test fun `read absent key returns empty`() {
        val v = makeRuntime().read("value.nonexistent")
        assertFalse(v.isPresent)
    }

    @Test fun `require absent key throws`() {
        val rt = makeRuntime()
        val ex = assertThrows(CnosError::class.java) { rt.require("value.nonexistent") }
        assertTrue(ex.message!!.contains("missing"))
    }

    @Test fun `read derived template formula`() {
        val v = makeRuntime().value("server.url")
        assertTrue(v.isPresent)
        assertEquals("localhost:3000", v.get())
    }

    @Test fun `read meta profile`() {
        val v = makeRuntime().meta("profile")
        assertTrue(v.isPresent)
        assertEquals("local", v.get())
    }

    @Test fun `read meta workspace`() {
        val v = makeRuntime().meta("workspace")
        assertTrue(v.isPresent)
        assertEquals("base", v.get())
    }

    @Test fun `read meta cnos version`() {
        val v = makeRuntime().meta("cnos_version")
        assertTrue(v.isPresent)
        assertEquals("1.11.4", v.get())
    }

    @Test fun `readOr returns fallback when absent`() {
        val v = makeRuntime().readOr("value.missing", "fallback")
        assertEquals("fallback", v)
    }

    @Test fun `readOr returns value when present`() {
        val v = makeRuntime().readOr("value.server.host", "fallback")
        assertEquals("localhost", v)
    }

    @Test fun `read secret from environment`() {
        val v = makeRuntime().secret("db.password")
        assertTrue(v.isPresent)
        assertEquals("s3cr3t", v.get())
    }

    @Test fun `read public key`() {
        val v = makeRuntime().publicKey("server.port")
        assertTrue(v.isPresent)
        assertEquals(3000L, (v.get() as Number).toLong())
    }

    @Test fun `to logical key is idempotent`() {
        val rt = makeRuntime()
        val v1 = rt.value("server.host")
        val v2 = rt.read("value.server.host")
        assertEquals(v1, v2)
    }

    @Test fun `invalid projection returns error`() {
        assertThrows(Exception::class.java) {
            CnosRuntime.loadProjection("{}".toByteArray(), CnosOptions.defaults())
        }
    }

    @Test fun `missing projection returns error`() {
        val ex = assertThrows(CnosError::class.java) {
            CnosRuntime.load(CnosOptions(workingDir = "/no-such-dir-cnos-test"))
        }
        assertTrue(ex.isProjectionNotFound)
    }

    @Test fun `format interpolates keys`() {
        val result = makeRuntime().format("host=\${value.server.host} port=\${value.server.port}")
        assertEquals("host=localhost port=3000", result)
    }

    @Test fun `to public env contains promoted keys`() {
        val env = makeRuntime().toPublicEnv()
        assertTrue(env.containsKey("SERVER_PORT"))
        assertEquals("3000", env["SERVER_PORT"])
    }

    @Test fun `to public env applies framework prefix`() {
        val env = makeRuntime().toPublicEnv(ToPublicEnvOptions(framework = "next"))
        assertTrue(env.containsKey("NEXT_PUBLIC_SERVER_PORT"))
    }

    @Test fun `register and call runtime provider`() {
        val projection = """
        {
          "version":1,"workspace":"base","profile":"local",
          "resolvedAt":"2024-01-01T00:00:00Z","configHash":"h",
          "values":{},
          "derived":{"request.result":{"expr":"${'$'}{request.user}","deps":[],"runtimeRefs":["request.user"]}},
          "secretRefs":{},"publicKeys":[],
          "runtimeNamespaces":["request"],
          "meta":{"workspace":"base","profile":"local","cnos_version":"1.11.4","namespaces":["request"]}
        }""".trimIndent()
        val rt = CnosRuntime.loadProjection(projection.toByteArray(), CnosOptions.defaults())
        rt.registerRuntimeProvider("request") { path ->
            if (path == "user") "alice" else null
        }
        val v = rt.read("request.user")
        assertTrue(v.isPresent)
        assertEquals("alice", v.get())
    }

    @Test fun `register runtime provider for process fails`() {
        val rt = makeRuntime()
        assertThrows(CnosError::class.java) {
            rt.registerRuntimeProvider("process") { null }
        }
    }

    @Test fun `derived cyclic reference returns error`() {
        val projection = """
        {
          "version":1,"workspace":"base","profile":"local",
          "resolvedAt":"2024-01-01T00:00:00Z","configHash":"h",
          "values":{},
          "derived":{
            "value.a":{"expr":"${'$'}{value.b}","deps":["value.b"],"runtimeRefs":[]},
            "value.b":{"expr":"${'$'}{value.a}","deps":["value.a"],"runtimeRefs":[]}
          },
          "secretRefs":{},"publicKeys":[],"runtimeNamespaces":[],
          "meta":{"workspace":"base","profile":"local","cnos_version":"1.11.4"}
        }""".trimIndent()
        assertThrows(CnosError::class.java) {
            CnosRuntime.loadProjection(projection.toByteArray(), CnosOptions.defaults())
        }
    }
}

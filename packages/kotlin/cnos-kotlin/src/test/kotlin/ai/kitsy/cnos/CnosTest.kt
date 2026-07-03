package ai.kitsy.cnos

import java.util.Optional
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows

class CnosTest {

    private val MINIMAL = """
    {
      "version": 1,
      "workspace": "base",
      "profile": "local",
      "resolvedAt": "2024-01-01T00:00:00Z",
      "configHash": "abc123",
      "values": {
        "server.port": 3000,
        "app.name": "cnos-kotlin"
      },
      "derived": {
        "app.effectivePort": {
          "expr": "coalesce(process.env.PORT, value.server.port, '3000')",
          "deps": ["value.server.port"],
          "runtimeRefs": ["process.env.PORT"]
        }
      },
      "secretRefs": {},
      "publicKeys": ["app.name"],
      "runtimeNamespaces": [],
      "meta": {
        "workspace": "base",
        "profile": "local",
        "cnos_version": "1.14.0"
      }
    }""".trimIndent()

    @AfterEach
    fun cleanup() {
        Cnos.resetDefaultRuntime()
    }

    @Test
    fun `read throws when not initialized`() {
        assertThrows<CnosError> {
            Cnos.read("value.server.port")
        }
    }

    @Test
    fun `setDefaultRuntime makes read work`() {
        val rt = CnosRuntime.loadProjection(MINIMAL.toByteArray())
        Cnos.setDefaultRuntime(rt)

        val port = Cnos.value("server.port")
        assertTrue(port.isPresent)
        assertEquals(3000L, (port.get() as Number).toLong())
    }

    @Test
    fun `defaultRuntime returns the set instance`() {
        val rt = CnosRuntime.loadProjection(MINIMAL.toByteArray())
        Cnos.setDefaultRuntime(rt)
        assertSame(rt, Cnos.defaultRuntime())
    }

    @Test
    fun `ready is idempotent — second call preserves first runtime`() {
        val rt = CnosRuntime.loadProjection(MINIMAL.toByteArray())
        Cnos.setDefaultRuntime(rt)
        val first = Cnos.defaultRuntime()

        // ready() on an already-initialized singleton keeps the same instance
        Cnos.ready()
        assertSame(first, Cnos.defaultRuntime())
    }

    @Test
    fun `require throws on missing key`() {
        val rt = CnosRuntime.loadProjection(MINIMAL.toByteArray())
        Cnos.setDefaultRuntime(rt)
        assertThrows<CnosError> {
            Cnos.require("value.does.not.exist")
        }
    }

    @Test
    fun `readOr returns fallback on missing key`() {
        val rt = CnosRuntime.loadProjection(MINIMAL.toByteArray())
        Cnos.setDefaultRuntime(rt)
        val result = Cnos.readOr("value.missing", "default-val")
        assertEquals("default-val", result)
    }

    @Test
    fun `registerRuntimeProvider is delegated to runtime`() {
        val withRequest = """
        {
          "version": 1, "workspace": "base", "profile": "local",
          "resolvedAt": "2024-01-01T00:00:00Z", "configHash": "abc123",
          "values": { "app.host": "default.host" },
          "derived": {
            "app.effectiveHost": {
              "expr": "coalesce(request.headers.host, value.app.host)",
              "deps": ["value.app.host"],
              "runtimeRefs": ["request.headers.host"]
            }
          },
          "secretRefs": {}, "publicKeys": [], "runtimeNamespaces": ["request"],
          "meta": { "workspace": "base", "profile": "local", "cnos_version": "1.14.0" }
        }""".trimIndent()

        val rt = CnosRuntime.loadProjection(withRequest.toByteArray())
        Cnos.setDefaultRuntime(rt)

        Cnos.registerRuntimeProvider("request") { path ->
            if (path == "headers.host") "console.kitsy.local" else null
        }

        val host = Cnos.value("app.effectiveHost")
        assertTrue(host.isPresent)
        assertEquals("console.kitsy.local", host.get())
    }

    @Test
    fun `format delegates to runtime`() {
        val rt = CnosRuntime.loadProjection(MINIMAL.toByteArray())
        Cnos.setDefaultRuntime(rt)

        val msg = Cnos.format("App: \${value.app.name}")
        assertEquals("App: cnos-kotlin", msg)
    }

    @Test
    fun `toPublicEnv includes promoted keys`() {
        val rt = CnosRuntime.loadProjection(MINIMAL.toByteArray())
        Cnos.setDefaultRuntime(rt)

        val env = Cnos.toPublicEnv(ToPublicEnvOptions(framework = "vite"))
        assertEquals("cnos-kotlin", env["VITE_APP_NAME"])
    }

    @Test
    fun `resetDefaultRuntime clears the instance`() {
        val rt = CnosRuntime.loadProjection(MINIMAL.toByteArray())
        Cnos.setDefaultRuntime(rt)
        Cnos.resetDefaultRuntime()
        assertThrows<CnosError> { Cnos.read("value.app.name") }
    }

    @Test
    fun `toObject returns flat key-value map`() {
        val rt = CnosRuntime.loadProjection(MINIMAL.toByteArray())
        Cnos.setDefaultRuntime(rt)
        val obj = Cnos.toObject()
        assertNotNull(obj)
        assertTrue(obj.containsKey("value.server.port") || obj.containsKey("value"))
    }

    @Test
    fun `refreshSecrets completes without error when no secrets`() {
        val rt = CnosRuntime.loadProjection(MINIMAL.toByteArray())
        Cnos.setDefaultRuntime(rt)
        assertDoesNotThrow { Cnos.refreshSecrets() }
    }

    @Test
    fun `refreshSecret on missing key is a no-op`() {
        val rt = CnosRuntime.loadProjection(MINIMAL.toByteArray())
        Cnos.setDefaultRuntime(rt)
        assertDoesNotThrow { Cnos.refreshSecret("does.not.exist") }
    }

    // ================================================================
    // Composition model
    // ================================================================

    // Simulates: root → libA → libB where each library reads from the
    // module-level singleton and only the root calls setDefaultRuntime.

    private fun libB_read(): Optional<Any> = Cnos.value("server.port")
    private fun libA_read(): Optional<Any> = libB_read()

    @Test
    fun `composition root — libraries succeed after root initializes singleton`() {
        val rt = CnosRuntime.loadProjection(MINIMAL.toByteArray())
        Cnos.setDefaultRuntime(rt)    // root initializes once

        val port = libA_read()        // libA → libB → Cnos.value(…)
        assertTrue(port.isPresent)
        assertEquals(3000L, (port.get() as Number).toLong())
    }

    @Test
    fun `composition root — libraries throw before root initializes`() {
        // root has NOT initialized the singleton
        assertThrows<CnosError> { libA_read() }
    }
}

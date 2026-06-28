package ai.kitsy.cnos

import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test

class DeriveTest {

    private fun load(json: String): CnosRuntime =
        CnosRuntime.loadProjection(json.toByteArray(), CnosOptions.defaults())

    private fun proj(valuesJson: String, derivedJson: String) = """
    {
      "version":1,"workspace":"base","profile":"local",
      "resolvedAt":"2024-01-01T00:00:00Z","configHash":"h",
      "values":$valuesJson,
      "derived":$derivedJson,
      "secretRefs":{},"publicKeys":[],"runtimeNamespaces":[],
      "meta":{"workspace":"base","profile":"local","cnos_version":"1.11.4"}
    }""".trimIndent()

    @Test fun `template interpolation`() {
        val rt = load(proj(
            """{"server.host":"localhost","server.port":8080}""",
            """{"value.url":{"expr":"${'$'}{value.server.host}:${'$'}{value.server.port}","deps":["value.server.host","value.server.port"],"runtimeRefs":[]}}"""
        ))
        assertEquals("localhost:8080", rt.value("url").get())
    }

    @Test fun `coalesce returns first non-null`() {
        val rt = load(proj(
            """{"x":"hello"}""",
            """{"value.result":{"expr":"coalesce(value.missing, value.x)","deps":["value.x"],"runtimeRefs":[]}}"""
        ))
        assertEquals("hello", rt.value("result").get())
    }

    @Test fun `when true returns first branch`() {
        val rt = load(proj(
            """{"flag":true}""",
            """{"value.result":{"expr":"when(value.flag, 'yes', 'no')","deps":["value.flag"],"runtimeRefs":[]}}"""
        ))
        assertEquals("yes", rt.value("result").get())
    }

    @Test fun `when false returns second branch`() {
        val rt = load(proj(
            """{"flag":false}""",
            """{"value.result":{"expr":"when(value.flag, 'yes', 'no')","deps":["value.flag"],"runtimeRefs":[]}}"""
        ))
        assertEquals("no", rt.value("result").get())
    }

    @Test fun `exists returns true for present key`() {
        val rt = load(proj(
            """{"x":"hello"}""",
            """{"value.result":{"expr":"exists(value.x)","deps":["value.x"],"runtimeRefs":[]}}"""
        ))
        assertEquals(true, rt.value("result").get())
    }

    @Test fun `eq returns true for equal strings`() {
        val rt = load(proj(
            """{"env":"prod"}""",
            """{"value.result":{"expr":"eq(value.env, 'prod')","deps":["value.env"],"runtimeRefs":[]}}"""
        ))
        assertEquals(true, rt.value("result").get())
    }

    @Test fun `ne expression`() {
        val rt = load(proj(
            """{"env":"dev"}""",
            """{"value.result":{"expr":"ne(value.env, 'prod')","deps":["value.env"],"runtimeRefs":[]}}"""
        ))
        assertEquals(true, rt.value("result").get())
    }

    @Test fun `config only derived value is cached`() {
        val rt = load(proj(
            """{"base":"hello"}""",
            """{"value.result":{"expr":"${'$'}{value.base}","deps":["value.base"],"runtimeRefs":[]}}"""
        ))
        val v1 = rt.value("result")
        val v2 = rt.value("result")
        assertEquals(v1, v2)
    }

    @Test fun `literal string in expression`() {
        val rt = load(proj(
            """{}""",
            """{"value.result":{"expr":"'static-value'","deps":[],"runtimeRefs":[]}}"""
        ))
        assertEquals("static-value", rt.value("result").get())
    }

    @Test fun `literal number in expression`() {
        val rt = load(proj(
            """{}""",
            """{"value.result":{"expr":"42","deps":[],"runtimeRefs":[]}}"""
        ))
        val v = (rt.value("result").get() as Number).toDouble()
        assertEquals(42.0, v, 1e-9)
    }

    @Test fun `literal bool true`() {
        val rt = load(proj(
            """{}""",
            """{"value.result":{"expr":"true","deps":[],"runtimeRefs":[]}}"""
        ))
        assertEquals(true, rt.value("result").get())
    }
}

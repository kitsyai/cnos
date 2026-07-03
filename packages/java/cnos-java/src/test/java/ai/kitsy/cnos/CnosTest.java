package ai.kitsy.cnos;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Singleton / module-level API contract tests.
 *
 * Covers all 15 contract methods:
 *   ready, read, require, readOr, value, secret, meta,
 *   setDefaultRuntime, defaultRuntime, resetDefaultRuntime,
 *   toObject, toPublicEnv, format, refreshSecrets, refreshSecret
 *
 * Also covers the library composition model:
 *   root → libA → libB → libC → libD, libE → libF
 */
class CnosTest {

    private static final String MINIMAL = "{"
            + "\"version\":1,"
            + "\"workspace\":\"base\","
            + "\"profile\":\"local\","
            + "\"resolvedAt\":\"2024-01-01T00:00:00Z\","
            + "\"configHash\":\"abc123\","
            + "\"values\":{"
            + "  \"server.port\":3000,"
            + "  \"app.name\":\"cnos-java\""
            + "},"
            + "\"derived\":{"
            + "  \"app.effectiveHost\":{"
            + "    \"expr\":\"coalesce(request.headers.host,'default.host')\","
            + "    \"deps\":[],"
            + "    \"runtimeRefs\":[\"request.headers.host\"]"
            + "  }"
            + "},"
            + "\"secretRefs\":{},"
            + "\"publicKeys\":[\"app.name\"],"
            + "\"runtimeNamespaces\":[\"request\"],"
            + "\"meta\":{"
            + "  \"workspace\":\"base\","
            + "  \"profile\":\"local\","
            + "  \"cnos_version\":\"1.14.0\""
            + "}"
            + "}";

    private static CnosRuntime makeRuntime() throws CnosError {
        return CnosRuntime.load(CnosOptions.builder()
                .projectionData(MINIMAL.getBytes(StandardCharsets.UTF_8))
                .build());
    }

    @BeforeEach
    void resetBefore() {
        Cnos.resetDefaultRuntime();
    }

    @AfterEach
    void resetAfter() {
        Cnos.resetDefaultRuntime();
    }

    // ================================================================
    // Lifecycle
    // ================================================================

    @Test
    void readBeforeInitThrows() {
        CnosError err = assertThrows(CnosError.class, () -> Cnos.read("value.server.port"));
        assertTrue(err.getMessage().contains("not initialized") || err.getMessage().contains("not ready"));
    }

    @Test
    void setDefaultRuntimeMakesReadWork() throws CnosError {
        Cnos.setDefaultRuntime(makeRuntime());
        Optional<Object> v = Cnos.value("server.port");
        assertTrue(v.isPresent());
        assertEquals(3000, ((Number) v.get()).intValue());
    }

    @Test
    void defaultRuntimeReturnsSetInstance() throws CnosError {
        CnosRuntime rt = makeRuntime();
        Cnos.setDefaultRuntime(rt);
        assertSame(rt, Cnos.defaultRuntime());
    }

    @Test
    void resetDefaultRuntimeClears() throws CnosError {
        Cnos.setDefaultRuntime(makeRuntime());
        Cnos.resetDefaultRuntime();
        assertThrows(CnosError.class, () -> Cnos.read("value.server.port"));
    }

    @Test
    void readyIsIdempotent() throws CnosError {
        Cnos.setDefaultRuntime(makeRuntime());
        CnosRuntime first = Cnos.defaultRuntime();
        // ready() on already-initialized singleton — may fail to find projection on disk
        try { Cnos.ready(); } catch (CnosError ignored) {}
        assertSame(first, Cnos.defaultRuntime());
    }

    // ================================================================
    // read / require / readOr
    // ================================================================

    @Test
    void readReturnsValueForExistingKey() throws CnosError {
        Cnos.setDefaultRuntime(makeRuntime());
        Optional<Object> v = Cnos.read("value.app.name");
        assertTrue(v.isPresent());
        assertEquals("cnos-java", v.get());
    }

    @Test
    void readReturnsEmptyForMissingKey() throws CnosError {
        Cnos.setDefaultRuntime(makeRuntime());
        Optional<Object> v = Cnos.read("value.does.not.exist");
        assertFalse(v.isPresent());
    }

    @Test
    void requireReturnsValue() throws CnosError {
        Cnos.setDefaultRuntime(makeRuntime());
        assertEquals("cnos-java", Cnos.require("value.app.name"));
    }

    @Test
    void requireThrowsForMissingKey() throws CnosError {
        Cnos.setDefaultRuntime(makeRuntime());
        assertThrows(CnosError.class, () -> Cnos.require("value.does.not.exist"));
    }

    @Test
    void readOrReturnsFallback() throws CnosError {
        Cnos.setDefaultRuntime(makeRuntime());
        assertEquals("fallback", Cnos.readOr("value.missing", "fallback"));
    }

    // ================================================================
    // value / secret / meta
    // ================================================================

    @Test
    void valueShortcut() throws CnosError {
        Cnos.setDefaultRuntime(makeRuntime());
        Optional<Object> v = Cnos.value("server.port");
        assertTrue(v.isPresent());
        assertEquals(3000, ((Number) v.get()).intValue());
    }

    @Test
    void secretReturnsMissingWhenNoSecretRefs() throws CnosError {
        Cnos.setDefaultRuntime(makeRuntime());
        assertFalse(Cnos.secret("does.not.exist").isPresent());
    }

    @Test
    void metaReturnsWorkspace() throws CnosError {
        Cnos.setDefaultRuntime(makeRuntime());
        Optional<Object> v = Cnos.meta("workspace");
        assertTrue(v.isPresent());
        assertEquals("base", v.get());
    }

    // ================================================================
    // toObject / toPublicEnv / format
    // ================================================================

    @Test
    void toObjectReturnsNonEmptyMap() throws CnosError {
        Cnos.setDefaultRuntime(makeRuntime());
        Map<String, Object> obj = Cnos.toObject();
        assertNotNull(obj);
        assertFalse(obj.isEmpty());
    }

    @Test
    void toPublicEnvIncludesPromotedKeys() throws CnosError {
        Cnos.setDefaultRuntime(makeRuntime());
        Map<String, String> env = Cnos.toPublicEnv(new ToPublicEnvOptions("vite", ""));
        assertEquals("cnos-java", env.get("VITE_APP_NAME"));
    }

    @Test
    void formatSubstitutesConfigKeys() throws CnosError {
        Cnos.setDefaultRuntime(makeRuntime());
        assertEquals("App: cnos-java", Cnos.format("App: ${value.app.name}"));
    }

    @Test
    void formatLeavesUnknownKeysUnchanged() throws CnosError {
        Cnos.setDefaultRuntime(makeRuntime());
        assertEquals("${value.does.not.exist}", Cnos.format("${value.does.not.exist}"));
    }

    // ================================================================
    // refreshSecrets / refreshSecret
    // ================================================================

    @Test
    void refreshSecretsCompletesWithNoSecrets() throws CnosError {
        Cnos.setDefaultRuntime(makeRuntime());
        assertDoesNotThrow(Cnos::refreshSecrets);
    }

    @Test
    void refreshSecretOnMissingKeyIsNoop() throws CnosError {
        Cnos.setDefaultRuntime(makeRuntime());
        assertDoesNotThrow(() -> Cnos.refreshSecret("does.not.exist"));
    }

    // ================================================================
    // Composition model
    // ================================================================
    //
    // Simulates: root → libA → libB → libC → libD, libE → libF
    // Libraries read from the singleton. Only the root calls setDefaultRuntime.

    private static Optional<Object> libF_readMeta() throws CnosError {
        return Cnos.meta("workspace");
    }

    private static Optional<Object> libE_readMeta() throws CnosError {
        return libF_readMeta();
    }

    private static Optional<Object> libD_readPort() throws CnosError {
        return Cnos.value("server.port");
    }

    private static Optional<Object> libC_readPort() throws CnosError {
        return libD_readPort();
    }

    private static Object[] libB_read() throws CnosError {
        return new Object[]{libC_readPort().orElse(null), libE_readMeta().orElse(null)};
    }

    private static Object[] libA_read() throws CnosError {
        return libB_read();
    }

    @Test
    void compositionLibrariesSucceedAfterRootInitializes() throws CnosError {
        Cnos.setDefaultRuntime(makeRuntime());  // root initializes once

        Object[] results = libA_read();         // libA → … → libD/libF
        assertEquals(3000, ((Number) results[0]).intValue());
        assertEquals("base", results[1]);
    }

    @Test
    void compositionLibrariesFailBeforeRootInitializes() {
        // Root has NOT initialized — all library reads should fail
        assertThrows(CnosError.class, () -> libA_read());
    }

    @Test
    void compositionMultipleLibrariesShareSameRuntime() throws CnosError {
        CnosRuntime rt = makeRuntime();
        Cnos.setDefaultRuntime(rt);

        assertSame(rt, Cnos.defaultRuntime());
        libA_read();
        assertSame(rt, Cnos.defaultRuntime());  // unchanged after reads
    }
}

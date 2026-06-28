package ai.kitsy.cnos.internal

import ai.kitsy.cnos.SecretReference

internal class RuntimeEntry(
    val key: String,
    val namespace: String,
    val value: Any? = null,
    val aliasTo: String? = null,
    val promotedFrom: String? = null,
    var formula: ParsedFormula? = null,
    val secretRef: SecretReference? = null
) {
    @Volatile private var formulaCached = false
    private var formulaCacheValue: Any? = null

    @Synchronized
    fun getFormulaCache(): Any? = formulaCacheValue

    @Synchronized
    fun setFormulaCache(v: Any?) {
        formulaCacheValue = v
        formulaCached = true
    }

    val isFormulaCached: Boolean get() = formulaCached
}

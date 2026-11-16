package com.aditya.whisprkeyboard

// Dependency-free JVM tests. Run main with the installed Kotlin compiler; no Gradle/network.
object InsertionGuardTest {
    private val editor = EditorIdentity("test.app", 0, 1, 1)
    private fun sameEditorInsertsOnce() {
        val guard = InsertionGuard()
        check(guard.canInsert(1, editor, editor, true))
        guard.markInserted(1)
        check(!guard.canInsert(1, editor, editor, true))
    }
    private fun changedEditorHoldsResult() {
        val guard = InsertionGuard()
        for (changed in listOf(editor.copy(packageName = "another.app"), editor.copy(fieldId = 2),
            editor.copy(inputType = 2), editor.copy(sessionId = 2))) {
            check(!guard.canInsert(1, editor, changed, true))
        }
    }
    private fun duplicateRequestIgnored() {
        val guard = InsertionGuard()
        guard.markInserted(42)
        check(guard.alreadyInserted(42))
        check(!guard.canInsert(42, editor, editor, true))
        check(guard.canInsert(43, editor, editor, true))
    }
    private fun undoRequiresExactSuffix() {
        val guard = InsertionGuard()
        check(guard.canUndo(" hello", "before hello"))
        check(!guard.canUndo(" hello", "before Hello"))
        check(!guard.canUndo(" hello", "before hello!"))
        check(!guard.canUndo("hello", null))
        check(!guard.canUndo("", ""))
    }
    private fun passwordTypesBlockRecording() {
        for (type in listOf(0x81, 0x91, 0xe1, 0x12, 0x80091)) {
            check(InsertionGuard.isSensitive(type))
            check(!InsertionGuard().canInsert(1, editor.copy(inputType = type), editor.copy(inputType = type), true))
        }
        for (type in listOf(1, 2, 0x21, 0x20001)) check(!InsertionGuard.isSensitive(type))
    }
    private fun hiddenOrMissingEditorHoldsResult() {
        val guard = InsertionGuard()
        check(!guard.canInsert(1, editor, editor, false))
        check(!guard.canInsert(1, null, editor, true))
        check(!guard.canInsert(1, editor, null, true))
    }
    @JvmStatic fun main(args: Array<String>) {
        sameEditorInsertsOnce(); changedEditorHoldsResult(); duplicateRequestIgnored()
        undoRequiresExactSuffix(); passwordTypesBlockRecording(); hiddenOrMissingEditorHoldsResult()
        println("6 InsertionGuard JVM tests passed")
    }
}

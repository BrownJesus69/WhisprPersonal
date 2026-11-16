package com.aditya.whisprkeyboard

// No Android imports: the numeric masks are Android InputType's public constants.
data class EditorIdentity(val packageName: String, val fieldId: Int, val inputType: Int, val sessionId: Long)
class InsertionGuard {
    private val inserted = mutableSetOf<Long>()
    fun alreadyInserted(requestId: Long) = requestId in inserted
    fun canInsert(requestId: Long, target: EditorIdentity?, current: EditorIdentity?, visible: Boolean): Boolean =
        !alreadyInserted(requestId) && visible && target != null && target == current && !isSensitive(current.inputType)
    fun markInserted(requestId: Long) { inserted.add(requestId) }
    fun canUndo(insertedText: String, beforeCursor: CharSequence?): Boolean =
        insertedText.isNotEmpty() && beforeCursor?.toString()?.endsWith(insertedText) == true
    companion object {
        fun isSensitive(inputType: Int): Boolean {
            val kind = inputType and 0x0f
            val variation = inputType and 0xff0
            return kind == 1 && variation in setOf(0x80, 0x90, 0xe0) || kind == 2 && variation == 0x10
        }
    }
}

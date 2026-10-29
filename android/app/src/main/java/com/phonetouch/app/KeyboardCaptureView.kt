package com.phonetouch.app

import android.content.Context
import android.text.InputType
import android.view.KeyEvent
import android.view.View
import android.view.inputmethod.BaseInputConnection
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection

/**
 * An invisible view that receives input from the phone's on-screen (or hardware) keyboard and turns it
 * into receiver messages. It keeps no text of its own, so nothing typed is stored or echoed.
 *
 * The keyboard is asked for plain, non-predictive input (no suggestions / composing) so every character
 * is committed as it is typed. Composition updates from keyboards that ignore this are handled by
 * sending only the difference.
 */
class KeyboardCaptureView(context: Context) : View(context) {

    interface Output {
        /** @return false if it could not be sent (for example, not connected). */
        fun text(s: String): Boolean
        fun key(name: String): Boolean
    }

    var output: Output? = null
    private var composing = ""

    init {
        isFocusable = true
        isFocusableInTouchMode = true
    }

    override fun onCheckIsTextEditor(): Boolean = true

    override fun onCreateInputConnection(outAttrs: EditorInfo): InputConnection {
        outAttrs.inputType = InputType.TYPE_CLASS_TEXT or
            InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD or
            InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
        outAttrs.imeOptions = EditorInfo.IME_FLAG_NO_EXTRACT_UI or
            EditorInfo.IME_FLAG_NO_FULLSCREEN or
            EditorInfo.IME_ACTION_NONE
        composing = ""
        return object : BaseInputConnection(this, false) {
            override fun commitText(text: CharSequence?, newCursorPosition: Int): Boolean {
                replaceComposing(text?.toString() ?: "")
                composing = ""
                return true
            }

            override fun setComposingText(text: CharSequence?, newCursorPosition: Int): Boolean {
                replaceComposing(text?.toString() ?: "")
                return true
            }

            override fun finishComposingText(): Boolean {
                composing = ""
                return true
            }

            override fun deleteSurroundingText(beforeLength: Int, afterLength: Int): Boolean {
                repeat(beforeLength.coerceIn(0, 50)) { output?.key("backspace") }
                repeat(afterLength.coerceIn(0, 50)) { output?.key("delete") }
                composing = composing.dropLast(beforeLength)
                return true
            }

            override fun sendKeyEvent(event: KeyEvent): Boolean = handleKey(event)
        }
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean =
        if (handleKey(event)) true else super.onKeyDown(keyCode, event)

    override fun onKeyUp(keyCode: Int, event: KeyEvent): Boolean =
        if (keyName(keyCode) != null) true else super.onKeyUp(keyCode, event)

    /** Make the on-screen text equal [next] by sending only what changed since the composing text. */
    private fun replaceComposing(next: String) {
        var common = 0
        val max = minOf(composing.length, next.length)
        while (common < max && composing[common] == next[common]) common++
        repeat(composing.length - common) { output?.key("backspace") }
        val added = next.substring(common)
        if (added.isNotEmpty()) output?.text(added)
        composing = next
    }

    private fun handleKey(event: KeyEvent): Boolean {
        val name = keyName(event.keyCode)
        if (name != null) {
            if (event.action == KeyEvent.ACTION_DOWN) output?.key(name)
            return true
        }
        if (event.action == KeyEvent.ACTION_DOWN && !event.isCtrlPressed && !event.isAltPressed && !event.isMetaPressed) {
            val u = event.unicodeChar
            if (u > 0 && u != '\n'.code && u != '\t'.code) {
                output?.text(String(Character.toChars(u)))
                return true
            }
        }
        return false
    }

    private fun keyName(code: Int): String? = when (code) {
        KeyEvent.KEYCODE_DEL -> "backspace"
        KeyEvent.KEYCODE_FORWARD_DEL -> "delete"
        KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER -> "enter"
        KeyEvent.KEYCODE_TAB -> "tab"
        KeyEvent.KEYCODE_ESCAPE -> "escape"
        KeyEvent.KEYCODE_SPACE -> "space"
        KeyEvent.KEYCODE_DPAD_LEFT -> "left"
        KeyEvent.KEYCODE_DPAD_RIGHT -> "right"
        KeyEvent.KEYCODE_DPAD_UP -> "up"
        KeyEvent.KEYCODE_DPAD_DOWN -> "down"
        KeyEvent.KEYCODE_MOVE_HOME -> "home"
        KeyEvent.KEYCODE_MOVE_END -> "end"
        KeyEvent.KEYCODE_PAGE_UP -> "pageup"
        KeyEvent.KEYCODE_PAGE_DOWN -> "pagedown"
        else -> null
    }
}

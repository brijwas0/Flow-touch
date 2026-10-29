package com.phonetouch.app

/** Builders for the JSON messages the receiver understands (see windows/src/protocol.js). Pure JVM. */
object Messages {
    const val MAX_TEXT_UNITS = 200 // receiver accepts up to 256 UTF-16 units per message
    const val MAX_MOVE = 1000
    const val MAX_SCROLL = 2400

    fun jsonString(s: String): String {
        val sb = StringBuilder(s.length + 2)
        sb.append('"')
        for (c in s) {
            when {
                c == '"' -> sb.append("\\\"")
                c == '\\' -> sb.append("\\\\")
                c == '\n' -> sb.append("\\n")
                c == '\r' -> sb.append("\\r")
                c == '\t' -> sb.append("\\t")
                c.code < 0x20 -> sb.append("\\u").append(c.code.toString(16).padStart(4, '0'))
                else -> sb.append(c)
            }
        }
        sb.append('"')
        return sb.toString()
    }

    fun pair(clientNonce: String, proof: String, name: String): String =
        """{"t":"pair","cn":"$clientNonce","proof":"$proof","name":${jsonString(name)}}"""

    fun move(dx: Int, dy: Int): String = """{"t":"m","dx":$dx,"dy":$dy}"""

    /** button: 'l' | 'r' | 'm'; action: 'd' (down) | 'u' (up) | 'c' (click). */
    fun button(button: Char, action: Char): String = """{"t":"b","b":"$button","a":"$action"}"""

    fun scroll(dx: Int, dy: Int): String = """{"t":"s","dx":$dx,"dy":$dy}"""

    fun gesture(action: String): String = """{"t":"g","a":"$action"}"""

    fun zoom(dy: Int): String = """{"t":"z","dy":$dy}"""

    fun key(name: String): String = """{"t":"k","k":"$name"}"""

    fun text(s: String): String = """{"t":"txt","s":${jsonString(s)}}"""

    const val PING = """{"t":"ping"}"""
    const val BYE = """{"t":"bye"}"""

    /** Split text into chunks that fit one message without cutting a surrogate pair in half. */
    fun chunkText(s: String, max: Int = MAX_TEXT_UNITS): List<String> {
        val out = ArrayList<String>()
        var i = 0
        while (i < s.length) {
            var end = minOf(s.length, i + max)
            if (end < s.length && Character.isHighSurrogate(s[end - 1])) end--
            out.add(s.substring(i, end))
            i = end
        }
        return out
    }

    /** Split a movement into messages that respect the receiver's +-1000 limit. */
    fun clampSplit(v: Int, limit: Int): List<Int> {
        if (v == 0) return emptyList()
        val out = ArrayList<Int>()
        var rest = v
        while (rest != 0) {
            val part = rest.coerceIn(-limit, limit)
            out.add(part)
            rest -= part
        }
        return out
    }
}

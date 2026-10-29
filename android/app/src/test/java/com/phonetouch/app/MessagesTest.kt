package com.phonetouch.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class MessagesTest {
    @Test
    fun simpleMessages() {
        assertEquals("""{"t":"m","dx":5,"dy":-3}""", Messages.move(5, -3))
        assertEquals("""{"t":"b","b":"l","a":"c"}""", Messages.button('l', 'c'))
        assertEquals("""{"t":"s","dx":0,"dy":120}""", Messages.scroll(0, 120))
        assertEquals("""{"t":"g","a":"start"}""", Messages.gesture("start"))
        assertEquals("""{"t":"z","dy":120}""", Messages.zoom(120))
        assertEquals("""{"t":"k","k":"enter"}""", Messages.key("enter"))
        assertEquals("""{"t":"ping"}""", Messages.PING)
    }

    @Test
    fun textIsEscaped() {
        assertEquals("\"a\\\"b\\\\c\\n\\t\\u0001\"", Messages.jsonString("a\"b\\c\n\t\u0001"))
        assertEquals("""{"t":"txt","s":"héllo 世界 😀"}""", Messages.text("héllo 世界 😀"))
    }

    @Test
    fun pairMessageHasAllFields() {
        val m = Messages.pair("a".repeat(32), "b".repeat(64), "My \"Phone\"")
        assertTrue(m.contains(""""t":"pair""""))
        assertTrue(m.contains(""""name":"My \"Phone\"""""))
    }

    @Test
    fun chunkTextNeverSplitsSurrogatePairs() {
        val s = "a" + "😀".repeat(10) // 1 + 20 UTF-16 units
        val chunks = Messages.chunkText(s, 4)
        assertEquals(s, chunks.joinToString(""))
        for (c in chunks) {
            assertTrue(c.length <= 4)
            assertTrue(!Character.isHighSurrogate(c.last()))
            assertTrue(!Character.isLowSurrogate(c.first()))
        }
        assertEquals(emptyList<String>(), Messages.chunkText(""))
    }

    @Test
    fun clampSplitRespectsLimit() {
        assertEquals(emptyList<Int>(), Messages.clampSplit(0, 1000))
        assertEquals(listOf(250), Messages.clampSplit(250, 1000))
        assertEquals(listOf(1000, 1000, 500), Messages.clampSplit(2500, 1000))
        assertEquals(listOf(-1000, -200), Messages.clampSplit(-1200, 1000))
    }
}

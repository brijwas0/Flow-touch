package com.phonetouch.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class GestureEngineTest {
    private class Rec : PointerSink {
        val log = ArrayList<String>()
        val gestures = ArrayList<String>()
        var mx = 0f
        var my = 0f
        var sx = 0f
        var sy = 0f
        var zy = 0f

        override fun onMove(dx: Float, dy: Float) {
            mx += dx; my += dy; log.add("move")
        }
        override fun onScroll(dx: Float, dy: Float) {
            sx += dx; sy += dy; log.add("scroll")
        }
        override fun onZoom(dy: Float) {
            zy += dy; log.add("zoom")
        }
        override fun onButton(button: Char, action: Char) {
            log.add("$button$action")
        }
        override fun onGesture(action: String) {
            gestures.add(action); log.add("g:$action")
        }

        fun clicks() = log.filter { it.length == 2 && (it[0] == 'l' || it[0] == 'r') }
    }

    private lateinit var rec: Rec
    private lateinit var g: GestureEngine
    private var t = 0L

    @Before
    fun setUp() {
        rec = Rec()
        // density 1, sensitivity 1 so numbers are easy to reason about
        g = GestureEngine(GestureConfig(density = 1f, sensitivity = 1f, naturalScroll = true), rec)
        t = 1000
    }

    private fun down(id: Int, x: Float, y: Float) = g.down(id, x, y, t)
    private fun up(id: Int) = g.up(id, t)
    private fun move(vararg p: Triple<Int, Float, Float>) {
        for ((id, x, y) in p) g.pointerMoved(id, x, y)
        g.endFrame(t)
    }
    private fun adv(ms: Long) { t += ms }

    @Test
    fun quickTapIsLeftClick() {
        down(0, 100f, 100f); adv(80); up(0)
        assertEquals(listOf("lc"), rec.clicks())
        assertEquals(GestureEngine.State.IDLE, g.state)
    }

    @Test
    fun longPressWithoutMovingDoesNotClickOrOpenFolder() {
        // Holding finger still for > 320ms arms drag, but lifting without moving must NOT click
        down(0, 100f, 100f); adv(400); g.endFrame(t); adv(100); up(0)
        assertEquals(emptyList<String>(), rec.clicks())
        assertEquals(GestureEngine.State.IDLE, g.state)
    }

    @Test
    fun clickAndHoldDraggingWorksReliably() {
        // Press and hold for >= 320ms, then move past drag threshold -> enters DRAGGING
        down(0, 100f, 100f); adv(350); g.endFrame(t)
        assertEquals(GestureEngine.State.DRAG_ARMED, g.state)
        adv(16); move(Triple(0, 130f, 100f)) // move past dragThresholdPx (10px)
        assertEquals(GestureEngine.State.DRAGGING, g.state)
        assertEquals(listOf("ld"), rec.clicks())
        adv(16); move(Triple(0, 160f, 100f))
        adv(16); up(0)
        assertEquals(listOf("ld", "lu"), rec.clicks())
        assertEquals(GestureEngine.State.IDLE, g.state)
    }

    @Test
    fun tinyJitterDuringTapStillClicksAndDoesNotMoveCursor() {
        down(0, 100f, 100f); adv(20); move(Triple(0, 102f, 101f)); adv(20); up(0)
        assertEquals(listOf("lc"), rec.clicks())
        assertTrue(rec.log.none { it == "move" })
    }

    @Test
    fun oneFingerMoveMovesCursorAndDoesNotClick() {
        down(0, 100f, 100f)
        for (i in 1..10) { adv(16); move(Triple(0, 100f + i * 10, 100f)) }
        up(0)
        assertEquals(emptyList<String>(), rec.clicks())
        assertTrue("moved right", rec.mx > 90f)
        assertEquals(0f, rec.my, 0.001f)
        assertEquals(GestureEngine.State.IDLE, g.state)
    }

    @Test
    fun sensitivityScalesMovement() {
        fun run(sens: Float): Float {
            val r = Rec()
            val e = GestureEngine(GestureConfig(density = 1f, sensitivity = sens), r)
            var tt = 0L
            e.down(0, 0f, 0f, tt)
            for (i in 1..10) { tt += 16; e.pointerMoved(0, i * 10f, 0f); e.endFrame(tt) }
            return r.mx
        }
        assertTrue(run(2f) > run(1f) * 1.8f)
    }

    @Test
    fun tapThenPressAndMoveIsDragAndDrop() {
        down(0, 100f, 100f); adv(60); up(0)           // tap -> click
        adv(100)
        down(0, 102f, 101f)                           // press again, near the first tap
        adv(50); move(Triple(0, 140f, 101f))          // move -> drag starts
        adv(16); move(Triple(0, 200f, 101f))
        adv(16); up(0)                                // release -> drop
        assertEquals(listOf("lc", "ld", "lu"), rec.clicks())
        assertTrue(rec.mx > 90f)
    }

    @Test
    fun tapThenQuickSecondTapIsDoubleClick() {
        down(0, 100f, 100f); adv(60); up(0)
        adv(100)
        down(0, 100f, 100f); adv(60); up(0)
        assertEquals(listOf("lc", "lc"), rec.clicks())
    }

    @Test
    fun secondTapTooLateIsJustAnotherClickNotDrag() {
        down(0, 100f, 100f); adv(60); up(0)
        adv(600)
        down(0, 100f, 100f); adv(20); move(Triple(0, 160f, 100f)); adv(20); up(0)
        assertEquals(listOf("lc"), rec.clicks())
        assertTrue(rec.mx > 0f)
    }

    @Test
    fun dragIsReleasedOnCancel() {
        down(0, 100f, 100f); adv(60); up(0); adv(100)
        down(0, 100f, 100f); adv(30); move(Triple(0, 160f, 100f))
        g.cancel()
        assertEquals(listOf("lc", "ld", "lu"), rec.clicks())
        assertEquals(GestureEngine.State.IDLE, g.state)
    }

    @Test
    fun twoFingerTapIsRightClick() {
        down(0, 100f, 100f); adv(10); down(1, 160f, 100f)
        adv(80); up(0); adv(5); up(1)
        assertEquals(listOf("rc"), rec.clicks())
        assertEquals(GestureEngine.State.IDLE, g.state)
    }

    @Test
    fun twoFingerHoldIsNotRightClick() {
        down(0, 100f, 100f); down(1, 160f, 100f)
        adv(700); up(0); up(1)
        assertEquals(emptyList<String>(), rec.clicks())
    }

    @Test
    fun twoFingerVerticalSwipeScrollsAndDoesNotClick() {
        down(0, 100f, 100f); down(1, 160f, 100f)
        for (i in 1..10) { adv(16); move(Triple(0, 100f, 100f + i * 10), Triple(1, 160f, 100f + i * 10)) }
        up(0); up(1)
        assertEquals(emptyList<String>(), rec.clicks())
        assertTrue("natural scroll: swipe down = wheel up (positive)", rec.sy > 100f)
        assertEquals(0f, rec.sx, 0.001f)
    }

    @Test
    fun scrollDirectionFlipsWhenNaturalScrollIsOff() {
        val r = Rec()
        val e = GestureEngine(GestureConfig(density = 1f, naturalScroll = false), r)
        var tt = 0L
        e.down(0, 100f, 100f, tt); e.down(1, 160f, 100f, tt)
        for (i in 1..10) { tt += 16; e.pointerMoved(0, 100f, 100f + i * 10); e.pointerMoved(1, 160f, 100f + i * 10); e.endFrame(tt) }
        assertTrue(r.sy < -100f)
    }

    @Test
    fun twoFingerHorizontalSwipeScrollsHorizontally() {
        down(0, 100f, 100f); down(1, 160f, 100f)
        for (i in 1..10) { adv(16); move(Triple(0, 100f + i * 10, 100f), Triple(1, 160f + i * 10, 100f)) }
        up(0); up(1)
        assertTrue("natural: swipe right = wheel left (negative)", rec.sx < -100f)
        assertEquals(0f, rec.sy, 0.001f)
    }

    @Test
    fun twoFingerPinchToZoom() {
        down(0, 100f, 100f); down(1, 200f, 100f) // initial span 100px
        // Spread fingers apart to zoom in
        for (i in 1..6) {
            adv(16)
            move(Triple(0, 100f - i * 5, 100f), Triple(1, 200f + i * 5, 100f))
        }
        up(0); up(1)
        assertTrue("zoom delta must be positive when fingers spread", rec.zy > 0f)
        assertEquals(emptyList<String>(), rec.clicks())
    }

    @Test
    fun threeFingerTapOpensStartMenu() {
        down(0, 100f, 100f); down(1, 150f, 100f); down(2, 200f, 100f)
        adv(80); up(0); up(1); up(2)
        assertEquals(listOf("start"), rec.gestures)
        assertEquals(emptyList<String>(), rec.clicks())
    }

    @Test
    fun threeFingerSwipeDownShowsDesktop() {
        down(0, 100f, 100f); down(1, 150f, 100f); down(2, 200f, 100f)
        for (i in 1..6) {
            adv(16)
            move(Triple(0, 100f, 100f + i * 12), Triple(1, 150f, 100f + i * 12), Triple(2, 200f, 100f + i * 12))
        }
        up(0); up(1); up(2)
        assertEquals(listOf("desktop"), rec.gestures)
    }

    @Test
    fun threeFingerSwipeHorizontalSwitchesApps() {
        // Swipe right -> app_next
        down(0, 100f, 100f); down(1, 150f, 100f); down(2, 200f, 100f)
        for (i in 1..6) {
            adv(16)
            move(Triple(0, 100f + i * 12, 100f), Triple(1, 150f + i * 12, 100f), Triple(2, 200f + i * 12, 100f))
        }
        up(0); up(1); up(2)
        assertEquals(listOf("app_next"), rec.gestures)

        // Swipe left -> app_prev
        adv(200)
        down(0, 200f, 100f); down(1, 250f, 100f); down(2, 300f, 100f)
        for (i in 1..6) {
            adv(16)
            move(Triple(0, 200f - i * 12, 100f), Triple(1, 250f - i * 12, 100f), Triple(2, 300f - i * 12, 100f))
        }
        up(0); up(1); up(2)
        assertEquals(listOf("app_next", "app_prev"), rec.gestures)
    }

    @Test
    fun fourFingerTapOpensNotificationCenter() {
        down(0, 100f, 100f); down(1, 140f, 100f); down(2, 180f, 100f); down(3, 220f, 100f)
        adv(80); up(0); up(1); up(2); up(3)
        assertEquals(listOf("notifications"), rec.gestures)
    }

    @Test
    fun liftingOneFingerAfterScrollDoesNotJumpCursor() {
        down(0, 100f, 100f); down(1, 160f, 100f)
        for (i in 1..5) { adv(16); move(Triple(0, 100f, 100f + i * 10), Triple(1, 160f, 100f + i * 10)) }
        up(1)                                          // one finger remains on the pad
        assertEquals(GestureEngine.State.SETTLE, g.state)
        val movesBefore = rec.log.count { it == "move" }
        for (i in 1..5) { adv(16); move(Triple(0, 100f + i * 20, 150f + i * 20)) }
        assertEquals("remaining finger must not move the cursor", movesBefore, rec.log.count { it == "move" })
        up(0)
        assertEquals(GestureEngine.State.IDLE, g.state)
        // and the next touch works normally again
        adv(500); down(0, 50f, 50f); adv(50); up(0)
        assertEquals(listOf("lc"), rec.clicks())
    }

    @Test
    fun addingASecondFingerWhileMovingDoesNotJumpOrClick() {
        down(0, 100f, 100f)
        for (i in 1..5) { adv(16); move(Triple(0, 100f + i * 10, 100f)) }
        val before = rec.mx
        down(1, 300f, 300f)                             // far away second finger lands
        adv(16); move(Triple(0, 160f, 100f), Triple(1, 300f, 300f))
        assertEquals("no cursor jump", before, rec.mx, 0.001f)
        adv(50); up(1); up(0)
        assertEquals("a two-finger touch that began while moving is not a right click", emptyList<String>(), rec.clicks())
    }

    @Test
    fun extraFingerWhileDraggingDoesNotReleaseOrJump() {
        down(0, 100f, 100f); adv(60); up(0); adv(100)
        down(0, 100f, 100f); adv(30); move(Triple(0, 160f, 100f))
        down(1, 400f, 400f)                              // stray second finger
        adv(16); move(Triple(0, 180f, 100f), Triple(1, 400f, 400f))
        up(1)
        adv(16); up(0)
        assertEquals(listOf("lc", "ld", "lu"), rec.clicks())
    }

    @Test
    fun missingUpEventIsRecoveredFromOnNextDown() {
        down(0, 100f, 100f); adv(30); move(Triple(0, 160f, 100f))
        // the "up" for pointer 0 was lost; a brand-new touch begins
        adv(500)
        g.cancel()
        down(5, 10f, 10f); adv(40); up(5)
        assertEquals(listOf("lc"), rec.clicks())
    }
}

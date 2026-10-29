package com.phonetouch.app

import kotlin.math.abs
import kotlin.math.hypot
import kotlin.math.min

/** Receives the output of the gesture engine. Pure JVM so the engine can be unit-tested. */
interface PointerSink {
    /** Relative cursor movement in screen pixels, already scaled by sensitivity/acceleration. */
    fun onMove(dx: Float, dy: Float)

    /** Scroll in Windows wheel units (120 = one notch). dy > 0 scrolls up, dx > 0 scrolls right. */
    fun onScroll(dx: Float, dy: Float)

    /** Zoom in Windows wheel delta units (dy > 0 zooms in / scrolls up with Ctrl). */
    fun onZoom(dy: Float) {}

    /** button: 'l' | 'r' | 'm'; action: 'd' (press) | 'u' (release) | 'c' (click). */
    fun onButton(button: Char, action: Char)

    /** Named Windows Precision Touchpad gesture (e.g. 'start', 'desktop', 'notifications', 'app_next', 'app_prev', 'task_view'). */
    fun onGesture(action: String) {}
}

class GestureConfig(
    @Volatile var density: Float = 1f,
    @Volatile var sensitivity: Float = 1.5f,
    @Volatile var naturalScroll: Boolean = true,
    @Volatile var scrollUnitsPerDp: Float = 6f,
    @Volatile var dragThresholdDp: Float = 10f,
    @Volatile var holdToDragMs: Long = 320L,
    @Volatile var zoomUnitsPerDp: Float = 4f,
    @Volatile var swipeThresholdDp: Float = 45f,
    @Volatile var pinchThresholdDp: Float = 14f,
) {
    val slopPx: Float get() = 8f * density
    val doubleTapDistPx: Float get() = 40f * density
    val dragThresholdPx: Float get() = dragThresholdDp * density
    val swipeThresholdPx: Float get() = swipeThresholdDp * density
    val pinchThresholdPx: Float get() = pinchThresholdDp * density
    val zoomUnitsPerPx: Float get() = zoomUnitsPerDp / density
}

/**
 * Windows Precision Touchpad gesture state machine:
 *
 *   1 finger:
 *     - tap (< 250 ms) -> left click
 *     - double tap (< 300 ms) -> double click
 *     - tap, then press & move -> drag and drop
 *     - hold still (>= holdToDragMs), then move -> click-and-hold drag (arms drag, moves with left button down)
 *     - hold still (>= holdToDragMs), then lift without moving -> cancels drag cleanly (prevents accidental folder opening)
 *     - move past slop (< holdToDragMs) -> natural accelerated cursor tracking
 *
 *   2 fingers:
 *     - tap (< 300 ms without moving) -> right click
 *     - vertical / horizontal swipe -> smooth scrolling (with natural scrolling toggle)
 *     - pinch in / out -> smooth pinch-to-zoom (Ctrl + Wheel)
 *
 *   3 fingers:
 *     - tap (< 250 ms without moving) -> Windows Start Menu ('start')
 *     - swipe down -> Show Desktop / minimize windows ('desktop')
 *     - swipe up -> Task View ('task_view')
 *     - swipe right -> Switch to next app ('app_next')
 *     - swipe left -> Switch to previous app ('app_prev')
 *
 *   4 fingers:
 *     - tap (< 250 ms without moving) -> Windows Notification Center ('notifications')
 *
 *   Settle / finger transitions:
 *     - When fingers are lifted from a multi-touch gesture, remaining fingers are ignored
 *       until all lift to completely eliminate cursor jumps.
 */
class GestureEngine(private val cfg: GestureConfig, private val sink: PointerSink) {

    enum class State {
        IDLE,
        ONE,
        DRAG_ARMED,
        DRAG_PENDING,
        MOVING,
        DRAGGING,
        TWO,
        THREE,
        FOUR,
        SETTLE,
        IGNORE
    }

    private enum class TwoMode { NONE, SCROLL, ZOOM }

    private class Pt(var x: Float, var y: Float)

    var state: State = State.IDLE
        private set

    private val pointers = LinkedHashMap<Int, Pt>()
    private var primaryId = -1
    private var downTime = 0L
    private var startX = 0f
    private var startY = 0f
    private var lastX = 0f
    private var lastY = 0f
    private var lastT = 0L

    private var lastTapUp = -1L
    private var lastTapX = 0f
    private var lastTapY = 0f

    // Two finger state
    private var twoDownTime = 0L
    private var twoStartX = 0f
    private var twoStartY = 0f
    private var twoStartSpan = 0f
    private var twoLastSpan = 0f
    private var lastCx = 0f
    private var lastCy = 0f
    private var twoMode = TwoMode.NONE
    private var twoDisqualified = false

    // Three finger state
    private var threeDownTime = 0L
    private var threeStartX = 0f
    private var threeStartY = 0f
    private var threeGestureTriggered = false
    private var threeDisqualified = false

    // Four finger state
    private var fourDownTime = 0L
    private var fourStartX = 0f
    private var fourStartY = 0f
    private var fourDisqualified = false

    fun down(id: Int, x: Float, y: Float, t: Long) {
        val existing = pointers[id]
        if (existing != null) {
            existing.x = x
            existing.y = y
            return
        }
        if (pointers.isEmpty() && state != State.IDLE) reset() // lost an "up" event: start clean
        pointers[id] = Pt(x, y)
        when (pointers.size) {
            1 -> beginSingle(id, x, y, t)
            2 -> when (state) {
                State.ONE, State.DRAG_PENDING, State.DRAG_ARMED -> enterTwo(t, disqualified = false)
                State.MOVING -> enterTwo(t, disqualified = true)
                State.DRAGGING -> Unit // continue dragging with primary finger
                else -> enterTwo(t, disqualified = true)
            }
            3 -> if (state != State.DRAGGING) enterThree(t)
            4 -> if (state != State.DRAGGING) enterFour(t)
            else -> if (state != State.DRAGGING) state = State.IGNORE
        }
    }

    fun pointerMoved(id: Int, x: Float, y: Float) {
        val p = pointers[id] ?: return
        p.x = x
        p.y = y
    }

    /** Call once per touch MOVE event after all [pointerMoved] calls. */
    fun endFrame(t: Long) {
        when (state) {
            State.ONE -> {
                val p = pointers[primaryId] ?: return
                val dist = hypot(p.x - startX, p.y - startY)
                if (dist > cfg.slopPx) {
                    state = State.MOVING
                    trackPrimary(t)
                } else if (t - downTime >= cfg.holdToDragMs) {
                    // Held still long enough: arm click-and-hold drag
                    state = State.DRAG_ARMED
                }
            }
            State.DRAG_ARMED -> {
                val p = pointers[primaryId] ?: return
                val dist = hypot(p.x - startX, p.y - startY)
                if (dist > cfg.dragThresholdPx) {
                    // Moved past drag threshold while armed: start dragging!
                    state = State.DRAGGING
                    sink.onButton('l', 'd')
                    lastX = p.x
                    lastY = p.y
                    lastT = t
                }
            }
            State.DRAG_PENDING -> {
                val p = pointers[primaryId] ?: return
                if (hypot(p.x - startX, p.y - startY) > cfg.slopPx) {
                    state = State.DRAGGING
                    sink.onButton('l', 'd')
                    trackPrimary(t)
                }
            }
            State.MOVING, State.DRAGGING -> trackPrimary(t)
            State.TWO -> processTwo()
            State.THREE -> {
                val avg = averagePoint()
                if (avg != null && hypot(avg.x - threeStartX, avg.y - threeStartY) > cfg.slopPx) {
                    threeDisqualified = true
                }
                processThree()
            }
            State.FOUR -> {
                val avg = averagePoint()
                if (avg != null && hypot(avg.x - fourStartX, avg.y - fourStartY) > cfg.slopPx) {
                    fourDisqualified = true
                }
            }
            else -> Unit
        }
    }

    fun up(id: Int, t: Long) {
        if (pointers.remove(id) == null) return
        val n = pointers.size
        when (state) {
            State.ONE -> if (n == 0) {
                if (t - downTime <= TAP_MS) {
                    sink.onButton('l', 'c')
                    lastTapUp = t
                    lastTapX = startX
                    lastTapY = startY
                } else {
                    lastTapUp = -1
                }
                state = State.IDLE
            }
            State.DRAG_ARMED -> if (n == 0) {
                // Lifted without moving past drag threshold: no button action, no click
                lastTapUp = -1
                state = State.IDLE
            }
            State.DRAG_PENDING -> if (n == 0) {
                if (t - downTime <= TAP_MS) sink.onButton('l', 'c')
                lastTapUp = -1
                state = State.IDLE
            }
            State.MOVING -> if (n == 0) {
                lastTapUp = -1
                state = State.IDLE
            }
            State.DRAGGING -> {
                if (n == 0) {
                    sink.onButton('l', 'u')
                    lastTapUp = -1
                    state = State.IDLE
                } else if (id == primaryId) {
                    // another finger takes over the drag without a jump
                    primaryId = pointers.keys.first()
                    val p = pointers.getValue(primaryId)
                    lastX = p.x
                    lastY = p.y
                    lastT = t
                }
            }
            State.TWO -> {
                if (twoMode == TwoMode.NONE && !twoDisqualified && t - twoDownTime <= TWO_TAP_MS) {
                    sink.onButton('r', 'c')
                }
                state = if (n == 0) State.IDLE else State.SETTLE
            }
            State.THREE -> {
                if (!threeGestureTriggered && !threeDisqualified && t - threeDownTime <= TAP_MS) {
                    sink.onGesture("start")
                }
                threeDisqualified = true
                state = if (n == 0) State.IDLE else State.SETTLE
            }
            State.FOUR -> {
                if (!fourDisqualified && t - fourDownTime <= TAP_MS) {
                    sink.onGesture("notifications")
                }
                fourDisqualified = true
                state = if (n == 0) State.IDLE else State.SETTLE
            }
            State.SETTLE, State.IGNORE -> if (n == 0) state = State.IDLE
            State.IDLE -> Unit
        }
    }

    /** Touch sequence was cancelled by the system: release anything held and start clean. */
    fun cancel() = reset()

    private fun reset() {
        if (state == State.DRAGGING) sink.onButton('l', 'u')
        pointers.clear()
        state = State.IDLE
        lastTapUp = -1
        twoMode = TwoMode.NONE
        threeGestureTriggered = false
        threeDisqualified = false
        fourDisqualified = false
    }

    private fun beginSingle(id: Int, x: Float, y: Float, t: Long) {
        primaryId = id
        downTime = t
        startX = x
        startY = y
        lastX = x
        lastY = y
        lastT = t
        val isDoubleTap = lastTapUp >= 0 &&
            t - lastTapUp <= DOUBLE_TAP_MS &&
            hypot(x - lastTapX, y - lastTapY) <= cfg.doubleTapDistPx
        state = if (isDoubleTap) State.DRAG_PENDING else State.ONE
    }

    private fun enterTwo(t: Long, disqualified: Boolean) {
        val it = pointers.values.iterator()
        val a = it.next()
        val b = it.next()
        twoStartX = (a.x + b.x) / 2f
        twoStartY = (a.y + b.y) / 2f
        lastCx = twoStartX
        lastCy = twoStartY
        twoStartSpan = hypot(a.x - b.x, a.y - b.y)
        twoLastSpan = twoStartSpan
        twoDownTime = t
        twoDisqualified = disqualified
        twoMode = TwoMode.NONE
        lastTapUp = -1
        state = State.TWO
    }

    private fun enterThree(t: Long) {
        val avg = averagePoint() ?: return
        threeStartX = avg.x
        threeStartY = avg.y
        threeDownTime = t
        threeGestureTriggered = false
        threeDisqualified = false
        lastTapUp = -1
        state = State.THREE
    }

    private fun enterFour(t: Long) {
        val avg = averagePoint() ?: return
        fourStartX = avg.x
        fourStartY = avg.y
        fourDownTime = t
        fourDisqualified = false
        lastTapUp = -1
        state = State.FOUR
    }

    private fun averagePoint(): Pt? {
        if (pointers.isEmpty()) return null
        var sx = 0f
        var sy = 0f
        for (p in pointers.values) {
            sx += p.x
            sy += p.y
        }
        val n = pointers.size.toFloat()
        return Pt(sx / n, sy / n)
    }

    private fun trackPrimary(t: Long) {
        val p = pointers[primaryId] ?: return
        val dx = p.x - lastX
        val dy = p.y - lastY
        val dt = maxOf(1L, t - lastT).toFloat()
        lastX = p.x
        lastY = p.y
        lastT = t
        if (dx == 0f && dy == 0f) return

        val dist = hypot(dx, dy)
        // Suppress micro-jitter (finger tremor while stationary)
        if (dist < 0.35f * cfg.density && dist / dt < 0.05f) return

        val speedDpPerMs = dist / dt / cfg.density
        // Smooth non-linear acceleration curve
        val speedFactor = when {
            speedDpPerMs <= 0.2f -> 1.0f
            speedDpPerMs <= 1.5f -> 1.0f + (speedDpPerMs - 0.2f) * 0.9f
            else -> 2.17f + min(0.83f, (speedDpPerMs - 1.5f) * 0.5f)
        }
        val gain = cfg.sensitivity * speedFactor
        sink.onMove(dx * gain, dy * gain)
    }

    private fun processTwo() {
        if (pointers.size < 2) return
        val it = pointers.values.iterator()
        val a = it.next()
        val b = it.next()
        val cx = (a.x + b.x) / 2f
        val cy = (a.y + b.y) / 2f
        val currentSpan = hypot(a.x - b.x, a.y - b.y)

        // Pinch-to-zoom vs scroll decision
        if (twoMode == TwoMode.NONE) {
            val spanDiff = abs(currentSpan - twoStartSpan)
            val moveDist = hypot(cx - twoStartX, cy - twoStartY)
            if (spanDiff > cfg.pinchThresholdPx && spanDiff > moveDist * 0.8f) {
                twoMode = TwoMode.ZOOM
                twoLastSpan = currentSpan
            } else if (moveDist > cfg.slopPx) {
                twoMode = TwoMode.SCROLL
                lastCx = twoStartX
                lastCy = twoStartY
            }
        }

        when (twoMode) {
            TwoMode.ZOOM -> {
                val spanDelta = currentSpan - twoLastSpan
                twoLastSpan = currentSpan
                if (abs(spanDelta) > 0.5f) {
                    val zoomDelta = spanDelta * cfg.zoomUnitsPerPx
                    sink.onZoom(zoomDelta)
                }
            }
            TwoMode.SCROLL -> {
                var dx = cx - lastCx
                var dy = cy - lastCy
                lastCx = cx
                lastCy = cy
                // Axis lock: filter out accidental minor axis wobble
                if (abs(dx) < abs(dy) * 0.4f) dx = 0f
                if (abs(dy) < abs(dx) * 0.4f) dy = 0f
                if (dx == 0f && dy == 0f) return
                val unitsPerPx = cfg.scrollUnitsPerDp / cfg.density
                val wheelY = (if (cfg.naturalScroll) dy else -dy) * unitsPerPx
                val wheelX = (if (cfg.naturalScroll) -dx else dx) * unitsPerPx
                sink.onScroll(wheelX, wheelY)
            }
            TwoMode.NONE -> Unit
        }
    }

    private fun processThree() {
        if (threeGestureTriggered) return
        val avg = averagePoint() ?: return
        val dx = avg.x - threeStartX
        val dy = avg.y - threeStartY
        val thresh = cfg.swipeThresholdPx

        if (abs(dx) > thresh || abs(dy) > thresh) {
            threeGestureTriggered = true
            if (abs(dx) > abs(dy)) {
                // Horizontal 3-finger swipe: switch apps / desktops
                if (dx > 0) sink.onGesture("app_next")
                else sink.onGesture("app_prev")
            } else {
                // Vertical 3-finger swipe: down = show desktop, up = task view
                if (dy > 0) sink.onGesture("desktop")
                else sink.onGesture("task_view")
            }
        }
    }

    companion object {
        const val TAP_MS = 250L
        const val TWO_TAP_MS = 300L
        const val DOUBLE_TAP_MS = 300L
    }
}

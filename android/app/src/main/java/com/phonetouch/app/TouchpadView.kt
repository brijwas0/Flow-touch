package com.phonetouch.app

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RadialGradient
import android.graphics.Shader
import android.view.MotionEvent
import android.view.View
import kotlin.math.roundToInt

/**
 * The touchpad surface. Feeds touches to [GestureEngine] and batches the output: cursor movement and
 * scroll deltas are accumulated and sent at most once per display frame, with sub-pixel remainders
 * carried over so slow movements are not lost.
 */
class TouchpadView(context: Context) : View(context), PointerSink {

    interface Output {
        fun move(dx: Int, dy: Int)
        fun scroll(dx: Int, dy: Int)
        fun zoom(dy: Int)
        fun button(button: Char, action: Char)
        fun gesture(action: String)
    }

    var output: Output? = null
    val config = GestureConfig(density = resources.displayMetrics.density)

    /** Text shown in the middle of the pad (for example "Not connected"). */
    var hint: String = ""
        set(value) {
            field = value
            invalidate()
        }

    private val engine = GestureEngine(config, this)

    private var moveX = 0f
    private var moveY = 0f
    private var scrollX = 0f
    private var scrollY = 0f
    private var zoomY = 0f
    private var flushScheduled = false
    private val flushRunnable = Runnable {
        flushScheduled = false
        flushNow()
    }

    private val touches = LinkedHashMap<Int, FloatArray>()
    private val glowRadius = 64f * config.density
    private val glowPaint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val hintPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.argb(110, 255, 255, 255)
        textAlign = Paint.Align.CENTER
        textSize = 15f * resources.displayMetrics.scaledDensity
    }

    init {
        setBackgroundColor(Color.parseColor("#0B0B0D"))
        isHapticFeedbackEnabled = false
    }

    // ---------------------------------------------------------------- touch input

    override fun onTouchEvent(event: MotionEvent): Boolean {
        val t = event.eventTime
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN, MotionEvent.ACTION_POINTER_DOWN -> {
                val i = event.actionIndex
                val id = event.getPointerId(i)
                touches[id] = floatArrayOf(event.getX(i), event.getY(i))
                engine.down(id, event.getX(i), event.getY(i), t)
            }
            MotionEvent.ACTION_MOVE -> {
                for (i in 0 until event.pointerCount) {
                    val id = event.getPointerId(i)
                    touches[id]?.let {
                        it[0] = event.getX(i)
                        it[1] = event.getY(i)
                    }
                    engine.pointerMoved(id, event.getX(i), event.getY(i))
                }
                engine.endFrame(t)
            }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_POINTER_UP -> {
                val id = event.getPointerId(event.actionIndex)
                touches.remove(id)
                engine.up(id, t)
            }
            MotionEvent.ACTION_CANCEL -> {
                touches.clear()
                engine.cancel()
            }
            else -> return true
        }
        invalidate()
        return true
    }

    override fun onDetachedFromWindow() {
        engine.cancel()
        removeCallbacks(flushRunnable)
        super.onDetachedFromWindow()
    }

    /** Release anything held (for example a drag in progress) and drop pending movement. */
    fun reset() {
        engine.cancel()
        touches.clear()
        moveX = 0f; moveY = 0f; scrollX = 0f; scrollY = 0f; zoomY = 0f
        invalidate()
    }

    // ---------------------------------------------------------------- engine output (batched)

    override fun onMove(dx: Float, dy: Float) {
        moveX += dx
        moveY += dy
        scheduleFlush()
    }

    override fun onScroll(dx: Float, dy: Float) {
        scrollX += dx
        scrollY += dy
        scheduleFlush()
    }

    override fun onZoom(dy: Float) {
        zoomY += dy
        scheduleFlush()
    }

    override fun onButton(button: Char, action: Char) {
        flushNow() // keep movement and clicks in order
        output?.button(button, action)
    }

    override fun onGesture(action: String) {
        flushNow()
        output?.gesture(action)
    }

    private fun scheduleFlush() {
        if (flushScheduled) return
        flushScheduled = true
        postOnAnimation(flushRunnable)
    }

    private fun flushNow() {
        val ix = moveX.roundToInt()
        val iy = moveY.roundToInt()
        if (ix != 0 || iy != 0) {
            moveX -= ix
            moveY -= iy
            output?.move(ix, iy)
        }
        val sx = scrollX.roundToInt()
        val sy = scrollY.roundToInt()
        if (sx != 0 || sy != 0) {
            scrollX -= sx
            scrollY -= sy
            output?.scroll(sx, sy)
        }
        val zy = zoomY.roundToInt()
        if (zy != 0) {
            zoomY -= zy
            output?.zoom(zy)
        }
    }

    // ---------------------------------------------------------------- drawing

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        for (p in touches.values) {
            glowPaint.shader = RadialGradient(
                p[0], p[1], glowRadius,
                intArrayOf(Color.argb(46, 255, 255, 255), Color.argb(0, 255, 255, 255)),
                null, Shader.TileMode.CLAMP,
            )
            canvas.drawCircle(p[0], p[1], glowRadius, glowPaint)
        }
        if (hint.isNotEmpty() && touches.isEmpty()) {
            canvas.drawText(hint, width / 2f, height / 2f - (hintPaint.descent() + hintPaint.ascent()) / 2f, hintPaint)
        }
    }
}

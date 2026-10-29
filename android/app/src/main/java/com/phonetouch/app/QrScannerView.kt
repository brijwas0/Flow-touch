package com.phonetouch.app

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.ImageFormat
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.SurfaceTexture
import android.hardware.camera2.CameraCaptureSession
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraDevice
import android.hardware.camera2.CameraManager
import android.hardware.camera2.CaptureRequest
import android.media.ImageReader
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.view.Gravity
import android.view.Surface
import android.view.TextureView
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import com.google.zxing.BarcodeFormat
import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.MultiFormatReader
import com.google.zxing.PlanarYUVLuminanceSource
import com.google.zxing.common.HybridBinarizer
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * Full-screen QR code scanner view powered by Camera2 and ZXing.
 * Shows an elegant viewfinder overlay, animated scan line, and quick fallback buttons.
 */
@SuppressLint("MissingPermission")
class QrScannerView(
    context: Context,
    private val onScanned: (String) -> Unit,
    private val onManualEntry: () -> Unit,
    private val onClose: () -> Unit,
) : FrameLayout(context), TextureView.SurfaceTextureListener {

    private val uiHandler = Handler(Looper.getMainLooper())
    private var cameraThread: HandlerThread? = null
    private var cameraHandler: Handler? = null

    private lateinit var textureView: TextureView
    private lateinit var overlayView: ViewfinderOverlay
    private var cameraDevice: CameraDevice? = null
    private var captureSession: CameraCaptureSession? = null
    private var imageReader: ImageReader? = null
    private var isTorchOn = false

    private val scanningActive = AtomicBoolean(true)
    private val qrReader = MultiFormatReader().apply {
        setHints(mapOf(
            DecodeHintType.POSSIBLE_FORMATS to listOf(BarcodeFormat.QR_CODE),
            DecodeHintType.TRY_HARDER to true,
            DecodeHintType.CHARACTER_SET to "UTF-8",
        ))
    }

    private val d get() = resources.displayMetrics.density
    private fun dp(v: Int): Int = (v * d).roundToInt()

    init {
        setBackgroundColor(Color.BLACK)
        buildViews()
    }

    private fun buildViews() {
        // 1. Camera preview
        textureView = TextureView(context).apply {
            surfaceTextureListener = this@QrScannerView
        }
        addView(textureView, LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))

        // 2. Viewfinder Overlay
        overlayView = ViewfinderOverlay(context)
        addView(overlayView, LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))

        // 3. Top bar controls (Close & Torch)
        val topBar = LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(20), dp(16), dp(20), dp(16))
        }

        val btnClose = Button(context).apply {
            text = "✕  Cancel"
            setTextColor(Color.WHITE)
            textSize = 14f
            isAllCaps = false
            background = null
            setPadding(dp(12), dp(8), dp(12), dp(8))
            setOnClickListener { onClose() }
        }
        topBar.addView(btnClose, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT))

        val spacer = View(context)
        topBar.addView(spacer, LinearLayout.LayoutParams(0, 1, 1f))

        val btnTorch = Button(context).apply {
            text = "🔦 Flashlight"
            setTextColor(Color.WHITE)
            textSize = 13f
            isAllCaps = false
            background = null
            setPadding(dp(12), dp(8), dp(12), dp(8))
            setOnClickListener {
                isTorchOn = !isTorchOn
                text = if (isTorchOn) "🔦 Torch ON" else "🔦 Flashlight"
                setTorch(isTorchOn)
            }
        }
        topBar.addView(btnTorch, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT))

        addView(topBar, LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP))

        // 4. Bottom action panel
        val bottomPanel = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            setPadding(dp(20), dp(10), dp(20), dp(24))
        }

        val tvHint = TextView(context).apply {
            text = "Point camera at the QR code on your Windows screen"
            setTextColor(Color.parseColor("#E5E5EA"))
            textSize = 14f
            gravity = Gravity.CENTER
            setShadowLayer(4f, 0f, 2f, Color.BLACK)
        }
        bottomPanel.addView(tvHint)

        val btnManual = Button(context).apply {
            text = "Enter Code Manually"
            setTextColor(Color.parseColor("#0A84FF"))
            textSize = 14f
            isAllCaps = false
            background = null
            setPadding(dp(16), dp(10), dp(16), dp(10))
            setOnClickListener { onManualEntry() }
        }
        val btnLp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
            topMargin = dp(8)
        }
        bottomPanel.addView(btnManual, btnLp)

        addView(bottomPanel, LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM))
    }

    fun startScanning() {
        scanningActive.set(true)
        startCameraThread()
        if (textureView.isAvailable) {
            openCamera(textureView.surfaceTexture!!, textureView.width, textureView.height)
        }
    }

    fun stopScanning() {
        scanningActive.set(false)
        closeCamera()
        stopCameraThread()
    }

    private fun startCameraThread() {
        if (cameraThread == null) {
            cameraThread = HandlerThread("QrCameraThread").apply { start() }
            cameraHandler = Handler(cameraThread!!.looper)
        }
    }

    private fun stopCameraThread() {
        cameraThread?.quitSafely()
        try {
            cameraThread?.join(500)
        } catch (_: InterruptedException) {}
        cameraThread = null
        cameraHandler = null
    }

    override fun onSurfaceTextureAvailable(surface: SurfaceTexture, width: Int, height: Int) {
        if (scanningActive.get()) {
            openCamera(surface, width, height)
        }
    }

    override fun onSurfaceTextureSizeChanged(surface: SurfaceTexture, width: Int, height: Int) {}
    override fun onSurfaceTextureDestroyed(surface: SurfaceTexture): Boolean {
        closeCamera()
        return true
    }
    override fun onSurfaceTextureUpdated(surface: SurfaceTexture) {}

    private fun openCamera(surfaceTexture: SurfaceTexture, width: Int, height: Int) {
        val manager = context.getSystemService(Context.CAMERA_SERVICE) as? CameraManager ?: return
        val handler = cameraHandler ?: return

        try {
            val cameraId = manager.cameraIdList.firstOrNull { id ->
                val chars = manager.getCameraCharacteristics(id)
                chars.get(CameraCharacteristics.LENS_FACING) == CameraCharacteristics.LENS_FACING_BACK
            } ?: manager.cameraIdList.firstOrNull() ?: return

            val imgW = 640
            val imgH = 480
            imageReader = ImageReader.newInstance(imgW, imgH, ImageFormat.YUV_420_888, 2).apply {
                setOnImageAvailableListener({ reader ->
                    if (!scanningActive.get()) return@setOnImageAvailableListener
                    val image = reader.acquireLatestImage() ?: return@setOnImageAvailableListener
                    try {
                        val planes = image.planes
                        val yBuffer = planes[0].buffer
                        val ySize = yBuffer.remaining()
                        val yBytes = ByteArray(ySize)
                        yBuffer.get(yBytes)

                        val source = PlanarYUVLuminanceSource(
                            yBytes, image.width, image.height,
                            0, 0, image.width, image.height, false
                        )
                        val bitmap = BinaryBitmap(HybridBinarizer(source))
                        var rawText: String? = null
                        try {
                            rawText = qrReader.decodeWithState(bitmap)?.text
                        } catch (_: Exception) {
                            try {
                                val inverted = BinaryBitmap(HybridBinarizer(source.invert()))
                                rawText = qrReader.decodeWithState(inverted)?.text
                            } catch (_: Exception) {}
                        } finally {
                            qrReader.reset()
                        }

                        if (!rawText.isNullOrBlank() && scanningActive.compareAndSet(true, false)) {
                            uiHandler.post { onScanned(rawText) }
                        }
                    } catch (_: Exception) {
                    } finally {
                        image.close()
                    }
                }, handler)
            }

            manager.openCamera(cameraId, object : CameraDevice.StateCallback() {
                override fun onOpened(camera: CameraDevice) {
                    cameraDevice = camera
                    startCaptureSession(surfaceTexture)
                }

                override fun onDisconnected(camera: CameraDevice) {
                    camera.close()
                    cameraDevice = null
                }

                override fun onError(camera: CameraDevice, error: Int) {
                    camera.close()
                    cameraDevice = null
                }
            }, handler)
        } catch (_: Exception) {
            // Camera not available: user can fall back to manual entry
        }
    }

    private fun startCaptureSession(surfaceTexture: SurfaceTexture) {
        val camera = cameraDevice ?: return
        val reader = imageReader ?: return
        val handler = cameraHandler ?: return

        try {
            surfaceTexture.setDefaultBufferSize(640, 480)
            val previewSurface = Surface(surfaceTexture)
            val readerSurface = reader.surface

            val requestBuilder = camera.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW).apply {
                addTarget(previewSurface)
                addTarget(readerSurface)
                set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE)
            }

            camera.createCaptureSession(listOf(previewSurface, readerSurface), object : CameraCaptureSession.StateCallback() {
                override fun onConfigured(session: CameraCaptureSession) {
                    if (cameraDevice == null) return
                    captureSession = session
                    try {
                        session.setRepeatingRequest(requestBuilder.build(), null, handler)
                    } catch (_: Exception) {}
                }

                override fun onConfigureFailed(session: CameraCaptureSession) {}
            }, handler)
        } catch (_: Exception) {}
    }

    private fun setTorch(on: Boolean) {
        val session = captureSession ?: return
        val camera = cameraDevice ?: return
        val handler = cameraHandler ?: return
        try {
            val texture = textureView.surfaceTexture ?: return
            val previewSurface = Surface(texture)
            val readerSurface = imageReader?.surface ?: return
            val builder = camera.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW).apply {
                addTarget(previewSurface)
                addTarget(readerSurface)
                set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE)
                set(CaptureRequest.FLASH_MODE, if (on) CaptureRequest.FLASH_MODE_TORCH else CaptureRequest.FLASH_MODE_OFF)
            }
            session.setRepeatingRequest(builder.build(), null, handler)
        } catch (_: Exception) {}
    }

    private fun closeCamera() {
        try {
            captureSession?.close()
            captureSession = null
            cameraDevice?.close()
            cameraDevice = null
            imageReader?.close()
            imageReader = null
        } catch (_: Exception) {}
    }

    override fun onDetachedFromWindow() {
        stopScanning()
        super.onDetachedFromWindow()
    }

    /** Viewfinder overlay displaying a semi-transparent dark mask and glowing targeting frame. */
    private inner class ViewfinderOverlay(context: Context) : View(context) {
        private val maskPaint = Paint().apply {
            color = Color.argb(170, 0, 0, 0)
        }
        private val framePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = Color.parseColor("#0A84FF")
            style = Paint.Style.STROKE
            strokeWidth = 3f * d
        }
        private val laserPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = Color.parseColor("#32D74B")
            strokeWidth = 2.5f * d
        }
        private var laserY = 0f
        private var laserDir = 1f
        private val frameRect = RectF()

        init {
            setWillNotDraw(false)
        }

        override fun onDraw(canvas: Canvas) {
            super.onDraw(canvas)
            val w = width.toFloat()
            val h = height.toFloat()
            if (w == 0f || h == 0f) return

            val size = min(w * 0.55f, h * 0.75f).coerceIn(dp(180).toFloat(), dp(280).toFloat())
            val left = (w - size) / 2f
            val top = (h - size) / 2f
            frameRect.set(left, top, left + size, top + size)

            // Draw darkened borders around viewfinder box
            canvas.drawRect(0f, 0f, w, top, maskPaint)
            canvas.drawRect(0f, top, left, top + size, maskPaint)
            canvas.drawRect(left + size, top, w, top + size, maskPaint)
            canvas.drawRect(0f, top + size, w, h, maskPaint)

            // Draw rounded targeting frame
            val cornerRadius = 16f * d
            canvas.drawRoundRect(frameRect, cornerRadius, cornerRadius, framePaint)

            // Animated scanning laser
            if (laserY < top || laserY > top + size) laserY = top
            laserY += 3.5f * d * laserDir
            if (laserY >= top + size) laserDir = -1f
            else if (laserY <= top) laserDir = 1f
            canvas.drawLine(left + dp(8), laserY, left + size - dp(8), laserY, laserPaint)

            postInvalidateOnAnimation()
        }
    }
}

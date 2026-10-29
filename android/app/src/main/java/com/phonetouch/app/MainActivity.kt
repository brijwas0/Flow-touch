package com.phonetouch.app

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.Rect
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.text.InputType
import android.text.TextUtils
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.WindowManager
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.SeekBar
import android.widget.Switch
import android.widget.TextView
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * PhoneTouch Main Activity.
 *
 * Flow:
 *  1. Welcome Screen with prominent "Pair" button, manual code option, and OEM gesture guidance.
 *  2. QR Scanner (Camera2 + ZXing) scans the Windows companion app QR code.
 *  3. Verifies TLS handshake & pairing proofs.
 *  4. Shows animated green checkmark and "Connected Successfully".
 *  5. Automatically transitions to the full-screen precision touchpad / keyboard.
 *  6. System gesture protection (exclusion rects + FLAG_SECURE) minimizes OEM gesture conflicts.
 */
class MainActivity : Activity(), ReceiverClient.Listener {

    private val ui = Handler(Looper.getMainLooper())
    private lateinit var prefs: SharedPreferences
    private lateinit var client: ReceiverClient

    private lateinit var root: FrameLayout
    private lateinit var pad: TouchpadView
    private lateinit var kbd: KeyboardCaptureView
    private lateinit var kbdSurface: FrameLayout
    private lateinit var statusPill: LinearLayout
    private lateinit var statusDot: View
    private lateinit var statusText: TextView
    private lateinit var toggle: LinearLayout
    private lateinit var tabMouse: TextView
    private lateinit var tabKeyboard: TextView
    private lateinit var keyStrip: LinearLayout

    // Welcome Screen
    private lateinit var welcomeView: FrameLayout

    // QR Scanner View
    private var scannerView: QrScannerView? = null

    // Connecting / Status Dialog Modal
    private lateinit var connectModal: FrameLayout
    private lateinit var modalTitle: TextView
    private lateinit var modalMessage: TextView
    private lateinit var modalSpinner: ProgressBar
    private lateinit var modalCheckBadge: View
    private lateinit var modalActions: LinearLayout
    private lateinit var btnModalRetry: Button
    private lateinit var btnModalManual: Button
    private lateinit var btnModalClose: Button

    // Manual Connection / Settings Panel
    private lateinit var scrim: FrameLayout
    private lateinit var hostField: EditText
    private lateinit var portField: EditText
    private lateinit var codeField: EditText
    private lateinit var connectForm: LinearLayout
    private lateinit var connectedInfo: TextView
    private lateinit var panelError: TextView
    private lateinit var primaryButton: Button
    private lateinit var closeButton: Button

    private var keyboardMode = false
    private var connState = ConnState.DISCONNECTED
    private var remoteName: String? = null
    private var lastFlash = 0L

    private val d get() = resources.displayMetrics.density
    private fun dp(v: Int): Int = (v * d).roundToInt()

    // ------------------------------------------------------------------ lifecycle

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = getSharedPreferences("phonetouch", Context.MODE_PRIVATE)
        val deviceName = (Build.MODEL ?: "Android").filter { !it.isISOControl() }.take(40).ifBlank { "Android" }
        client = ReceiverClient(deviceName, this)

        buildUi()
        setContentView(root)
        applySystemBarsAndCutout()

        // Enable Touchpad Gesture Protection (FLAG_SECURE) by default to prevent OEM 3-finger screenshots
        val gestureProtection = prefs.getBoolean("gesture_prot", true)
        applyGestureProtection(gestureProtection)

        renderState()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) {
            hideSystemBars()
            updateGestureExclusion()
        }
    }

    override fun onDestroy() {
        scannerView?.stopScanning()
        client.disconnect(notify = false)
        ui.removeCallbacksAndMessages(null)
        super.onDestroy()
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        when {
            scannerView != null -> closeScanner()
            connectModal.visibility == View.VISIBLE && connState != ConnState.CONNECTING -> {
                connectModal.visibility = View.GONE
            }
            scrim.visibility == View.VISIBLE && connState == ConnState.CONNECTED -> {
                hidePanel()
            }
            connState == ConnState.CONNECTED -> {
                // Confirm disconnect before exiting
                AlertDialog.Builder(this)
                    .setTitle("Disconnect")
                    .setMessage("Do you want to disconnect from ${remoteName ?: "your PC"}?")
                    .setPositiveButton("Disconnect") { _, _ -> client.disconnect() }
                    .setNegativeButton("Cancel", null)
                    .show()
            }
            else -> {
                @Suppress("DEPRECATION")
                super.onBackPressed()
            }
        }
    }

    // ------------------------------------------------------------------ UI construction

    private fun buildUi() {
        root = FrameLayout(this).apply { setBackgroundColor(BG) }

        // 1. Touchpad View
        pad = TouchpadView(this).apply {
            config.sensitivity = prefs.getFloat("sens", 1.5f)
            config.naturalScroll = prefs.getBoolean("natural", true)
            config.dragThresholdDp = prefs.getFloat("drag_thresh", 10f)
            output = object : TouchpadView.Output {
                override fun move(dx: Int, dy: Int) { client.sendMove(dx, dy) }
                override fun scroll(dx: Int, dy: Int) { client.sendScroll(dx, dy) }
                override fun zoom(dy: Int) { client.sendZoom(dy) }
                override fun button(button: Char, action: Char) { client.sendButton(button, action) }
                override fun gesture(action: String) { client.sendGesture(action) }
            }
        }
        root.addView(pad, match())

        // 2. Keyboard surface + capture view
        kbdSurface = FrameLayout(this).apply {
            setBackgroundColor(BG)
            visibility = View.GONE
            isClickable = true
            setOnClickListener { showKeyboard() }
        }
        kbdSurface.addView(
            TextView(this).apply {
                text = "Type on your phone’s keyboard\nTap anywhere to bring it up"
                setTextColor(Color.argb(110, 255, 255, 255))
                textSize = 15f
                gravity = Gravity.CENTER
            },
            FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.CENTER),
        )
        root.addView(kbdSurface, match())

        kbd = KeyboardCaptureView(this).apply {
            output = object : KeyboardCaptureView.Output {
                override fun text(s: String): Boolean = report(client.sendText(s))
                override fun key(name: String): Boolean = report(client.sendKey(name))
            }
        }
        root.addView(kbd, FrameLayout.LayoutParams(1, 1, Gravity.TOP or Gravity.START))

        // 3. Mouse | Keyboard toggle
        tabMouse = tab("Mouse") { setMode(false) }
        tabKeyboard = tab("Keyboard") { setMode(true) }
        toggle = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            background = pill(SURFACE, 100)
            setPadding(dp(3), dp(3), dp(3), dp(3))
            addView(tabMouse)
            addView(tabKeyboard)
        }
        root.addView(toggle, FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP or Gravity.CENTER_HORIZONTAL).apply {
            topMargin = dp(14)
        })

        // 4. Special keys strip (Keyboard mode)
        keyStrip = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            visibility = View.GONE
        }
        for ((label, key) in listOf(
            "Esc" to "escape", "Tab" to "tab", "←" to "left", "↑" to "up",
            "↓" to "down", "→" to "right", "⌫" to "backspace", "⏎" to "enter",
        )) {
            keyStrip.addView(
                Button(this).apply {
                    text = label
                    setAllCaps(false)
                    textSize = 14f
                    setTextColor(Color.WHITE)
                    background = pill(SURFACE, 100)
                    minWidth = dp(44)
                    minimumWidth = dp(44)
                    minHeight = 0
                    minimumHeight = 0
                    setPadding(dp(12), dp(6), dp(12), dp(6))
                    setOnClickListener { report(client.sendKey(key)) }
                },
                LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                    marginStart = dp(3)
                    marginEnd = dp(3)
                },
            )
        }
        root.addView(keyStrip, FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP or Gravity.CENTER_HORIZONTAL).apply {
            topMargin = dp(58)
        })

        // 5. Status pill (top left)
        statusDot = View(this).apply { background = oval(GRAY) }
        statusText = TextView(this).apply {
            textSize = 13f
            setTextColor(Color.parseColor("#C7C7CC"))
            maxLines = 1
            ellipsize = TextUtils.TruncateAt.END
        }
        statusPill = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            background = pill(SURFACE, 100)
            setPadding(dp(12), dp(8), dp(14), dp(8))
            setOnClickListener {
                if (connState == ConnState.CONNECTED) showPanel(null)
                else showWelcome()
            }
            addView(statusDot, LinearLayout.LayoutParams(dp(9), dp(9)).apply { marginEnd = dp(8) })
            addView(statusText, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        }
        root.addView(statusPill, FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP or Gravity.START).apply {
            topMargin = dp(14)
            marginStart = dp(16)
        })

        // 6. Welcome View
        buildWelcomeView()

        // 7. Connecting / Status Modal
        buildConnectModal()

        // 8. Manual Panel
        buildPanel()

        styleTabs(animate = false)
    }

    private fun buildWelcomeView() {
        welcomeView = FrameLayout(this).apply {
            setBackgroundColor(Color.argb(240, 11, 11, 13))
            isClickable = true
        }

        val centerCard = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            background = GradientDrawable().apply {
                setColor(SURFACE)
                cornerRadius = dp(24).toFloat()
                setStroke(dp(1), Color.argb(35, 255, 255, 255))
            }
            setPadding(dp(32), dp(28), dp(32), dp(28))
        }

        // App Icon
        val iconBadge = TextView(this).apply {
            text = "📱"
            textSize = 34f
            gravity = Gravity.CENTER
            background = oval(Color.argb(45, 10, 132, 255))
        }
        centerCard.addView(iconBadge, LinearLayout.LayoutParams(dp(64), dp(64)).apply { bottomMargin = dp(16) })

        centerCard.addView(TextView(this).apply {
            text = "PhoneTouch"
            setTextColor(Color.WHITE)
            textSize = 24f
            typeface = Typeface.DEFAULT_BOLD
            gravity = Gravity.CENTER
        })

        centerCard.addView(TextView(this).apply {
            text = "Wireless Windows Touchpad & Keyboard"
            setTextColor(GRAY)
            textSize = 13f
            gravity = Gravity.CENTER
        }, lp(top = 4))

        // Big Pair Button
        val btnPair = Button(this).apply {
            text = "📷  Pair Device"
            setAllCaps(false)
            textSize = 17f
            typeface = Typeface.DEFAULT_BOLD
            setTextColor(Color.WHITE)
            background = pill(BLUE, 16)
            minHeight = dp(52)
            minimumHeight = dp(52)
            setPadding(dp(28), dp(12), dp(28), dp(12))
            setOnClickListener { startQrPairingFlow() }
        }
        val pairLp = LinearLayout.LayoutParams(dp(220), ViewGroup.LayoutParams.WRAP_CONTENT).apply {
            topMargin = dp(24)
        }
        centerCard.addView(btnPair, pairLp)

        // Actions row (Manual Entry + Gesture Advice)
        val actionsRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER
        }

        val btnManual = Button(this).apply {
            text = "Enter Code"
            setAllCaps(false)
            textSize = 13f
            setTextColor(Color.parseColor("#0A84FF"))
            background = null
            setPadding(dp(12), dp(6), dp(12), dp(6))
            setOnClickListener {
                welcomeView.visibility = View.GONE
                showPanel(null)
            }
        }
        actionsRow.addView(btnManual)

        actionsRow.addView(TextView(this).apply {
            text = "•"
            setTextColor(GRAY)
            setPadding(dp(4), 0, dp(4), 0)
        })

        val btnGestureAdvice = Button(this).apply {
            text = "Gesture Conflicts Guide"
            setAllCaps(false)
            textSize = 13f
            setTextColor(Color.parseColor("#FF9F0A"))
            background = null
            setPadding(dp(12), dp(6), dp(12), dp(6))
            setOnClickListener { showGestureConflictAdvice() }
        }
        actionsRow.addView(btnGestureAdvice)

        centerCard.addView(actionsRow, lp(top = 12))

        val scroll = ScrollView(this).apply {
            isFillViewport = true
            isVerticalScrollBarEnabled = false
            val holder = FrameLayout(context)
            holder.addView(centerCard, FrameLayout.LayoutParams(min(dp(420), resources.displayMetrics.widthPixels - dp(32)), ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.CENTER))
            addView(holder, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        }

        welcomeView.addView(scroll, match())
        root.addView(welcomeView, match())
    }

    private fun buildConnectModal() {
        connectModal = FrameLayout(this).apply {
            setBackgroundColor(Color.argb(200, 0, 0, 0))
            isClickable = true
            visibility = View.GONE
        }

        val card = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            background = GradientDrawable().apply {
                setColor(SURFACE)
                cornerRadius = dp(20).toFloat()
            }
            setPadding(dp(28), dp(24), dp(28), dp(24))
        }

        modalSpinner = ProgressBar(this).apply {
            isIndeterminate = true
        }
        card.addView(modalSpinner, LinearLayout.LayoutParams(dp(48), dp(48)))

        modalCheckBadge = TextView(this).apply {
            text = "✓"
            setTextColor(GREEN)
            textSize = 36f
            typeface = Typeface.DEFAULT_BOLD
            gravity = Gravity.CENTER
            background = oval(Color.argb(35, 50, 215, 75))
            visibility = View.GONE
        }
        card.addView(modalCheckBadge, LinearLayout.LayoutParams(dp(56), dp(56)))

        modalTitle = TextView(this).apply {
            text = "Connecting to PC"
            setTextColor(Color.WHITE)
            textSize = 18f
            typeface = Typeface.DEFAULT_BOLD
            gravity = Gravity.CENTER
        }
        card.addView(modalTitle, lp(top = 16))

        modalMessage = TextView(this).apply {
            text = "Establishing secure connection..."
            setTextColor(GRAY)
            textSize = 13f
            gravity = Gravity.CENTER
        }
        card.addView(modalMessage, lp(top = 6))

        modalActions = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER
            visibility = View.GONE
        }

        btnModalRetry = button("Scan Again", BLUE) {
            connectModal.visibility = View.GONE
            startQrPairingFlow()
        }
        btnModalManual = button("Enter Code", SURFACE_2) {
            connectModal.visibility = View.GONE
            showPanel(null)
        }
        btnModalClose = button("Cancel", SURFACE_2) {
            connectModal.visibility = View.GONE
            showWelcome()
        }

        modalActions.addView(btnModalRetry, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { marginEnd = dp(8) })
        modalActions.addView(btnModalManual, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { marginEnd = dp(8) })
        modalActions.addView(btnModalClose)
        card.addView(modalActions, lp(top = 20))

        val scroll = ScrollView(this).apply {
            isFillViewport = true
            isVerticalScrollBarEnabled = false
            val holder = FrameLayout(context)
            holder.addView(card, FrameLayout.LayoutParams(min(dp(380), resources.displayMetrics.widthPixels - dp(32)), ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.CENTER))
            addView(holder, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        }

        connectModal.addView(scroll, match())
        root.addView(connectModal, match())
    }

    private fun buildPanel() {
        scrim = FrameLayout(this).apply {
            setBackgroundColor(Color.argb(210, 0, 0, 0))
            isClickable = true
            visibility = View.GONE
        }

        val card = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = GradientDrawable().apply {
                setColor(SURFACE)
                cornerRadius = dp(18).toFloat()
            }
            setPadding(dp(20), dp(18), dp(20), dp(18))
        }

        card.addView(TextView(this).apply {
            text = "PhoneTouch Settings"
            setTextColor(Color.WHITE)
            textSize = 20f
            typeface = Typeface.DEFAULT_BOLD
        })
        card.addView(TextView(this).apply {
            text = "Manage pairing, sensitivity, drag & drop, and gesture protection."
            setTextColor(GRAY)
            textSize = 13f
        }, lp(top = 4))

        connectForm = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        val row = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        hostField = editField("PC address, e.g. 192.168.1.23", InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS or InputType.TYPE_TEXT_VARIATION_URI)
        hostField.setText(prefs.getString("host", "") ?: "")
        portField = editField("Port", InputType.TYPE_CLASS_NUMBER)
        portField.setText(prefs.getInt("port", 47820).toString())
        row.addView(hostField, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 3f))
        row.addView(portField, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply { marginStart = dp(8) })
        connectForm.addView(row, lp(top = 12))
        codeField = editField(
            "Pairing code, e.g. K7QM-X2TD-9FRA",
            InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_CHARACTERS or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS,
        )
        codeField.setOnEditorActionListener { _, actionId, _ ->
            if (actionId == EditorInfo.IME_ACTION_DONE) { onPrimary(); true } else false
        }
        connectForm.addView(codeField, lp(top = 8))
        card.addView(connectForm)

        connectedInfo = TextView(this).apply {
            setTextColor(Color.WHITE)
            textSize = 15f
            visibility = View.GONE
        }
        card.addView(connectedInfo, lp(top = 14))

        panelError = TextView(this).apply {
            setTextColor(RED)
            textSize = 13f
            visibility = View.GONE
        }
        card.addView(panelError, lp(top = 10))

        // Cursor speed
        card.addView(TextView(this).apply {
            text = "Cursor speed"
            setTextColor(GRAY)
            textSize = 13f
        }, lp(top = 14))
        card.addView(SeekBar(this).apply {
            max = 25 // 0.5x .. 3.0x
            progress = ((pad.config.sensitivity - 0.5f) * 10f).roundToInt().coerceIn(0, 25)
            setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
                override fun onProgressChanged(seekBar: SeekBar?, progress: Int, fromUser: Boolean) {
                    val s = 0.5f + progress / 10f
                    pad.config.sensitivity = s
                    prefs.edit().putFloat("sens", s).apply()
                }
                override fun onStartTrackingTouch(seekBar: SeekBar?) {}
                override fun onStopTrackingTouch(seekBar: SeekBar?) {}
            })
        }, lp(top = 2))

        // Natural scroll switch
        card.addView(Switch(this).apply {
            text = "Natural scrolling"
            setTextColor(Color.parseColor("#C7C7CC"))
            textSize = 14f
            isChecked = pad.config.naturalScroll
            setOnCheckedChangeListener { _, checked ->
                pad.config.naturalScroll = checked
                prefs.edit().putBoolean("natural", checked).apply()
            }
        }, lp(top = 10))

        // Touchpad Gesture Protection (FLAG_SECURE)
        card.addView(Switch(this).apply {
            text = "Touchpad Gesture Protection"
            setTextColor(Color.parseColor("#C7C7CC"))
            textSize = 14f
            isChecked = prefs.getBoolean("gesture_prot", true)
            setOnCheckedChangeListener { _, checked ->
                prefs.edit().putBoolean("gesture_prot", checked).apply()
                applyGestureProtection(checked)
            }
        }, lp(top = 10))

        // Gesture Conflict Advice button
        card.addView(Button(this).apply {
            text = "System Gesture Conflicts Guide"
            setTextColor(Color.parseColor("#FF9F0A"))
            textSize = 13f
            setAllCaps(false)
            background = null
            gravity = Gravity.START
            setPadding(0, dp(4), 0, dp(4))
            setOnClickListener { showGestureConflictAdvice() }
        }, lp(top = 4))

        val buttons = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.END
        }
        closeButton = button("Close", SURFACE_2) { hidePanel() }
        primaryButton = button("Connect", BLUE) { onPrimary() }
        buttons.addView(closeButton, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { marginEnd = dp(8) })
        buttons.addView(primaryButton)
        card.addView(buttons, lp(top = 16))

        val holder = FrameLayout(this)
        holder.addView(card, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.CENTER))
        val scroll = ScrollView(this).apply {
            isFillViewport = true
            isVerticalScrollBarEnabled = false
            addView(holder, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        }
        val width = min(dp(440), resources.displayMetrics.widthPixels - dp(32))
        scrim.addView(scroll, FrameLayout.LayoutParams(width, ViewGroup.LayoutParams.MATCH_PARENT, Gravity.CENTER_HORIZONTAL).apply {
            topMargin = dp(8)
            bottomMargin = dp(8)
        })
        root.addView(scrim, match())
    }

    // ------------------------------------------------------------------ QR flow

    private fun startQrPairingFlow() {
        if (Build.VERSION.SDK_INT >= 23 && checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.CAMERA), REQ_CAMERA)
            return
        }

        openScanner()
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        if (requestCode == REQ_CAMERA) {
            if (grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
                openScanner()
            } else {
                AlertDialog.Builder(this)
                    .setTitle("Camera Permission")
                    .setMessage("Camera permission is needed to scan the pairing QR code. You can also enter the pairing code manually.")
                    .setPositiveButton("Enter Code") { _, _ -> showPanel(null) }
                    .setNegativeButton("Cancel", null)
                    .show()
            }
        }
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
    }

    private fun openScanner() {
        if (scannerView != null) return
        welcomeView.visibility = View.GONE
        scrim.visibility = View.GONE

        val sView = QrScannerView(
            context = this,
            onScanned = { rawText ->
                closeScanner()
                handleScannedQr(rawText)
            },
            onManualEntry = {
                closeScanner()
                showPanel(null)
            },
            onClose = {
                closeScanner()
                showWelcome()
            },
        )
        scannerView = sView
        root.addView(sView, match())
        sView.startScanning()
    }

    private fun closeScanner() {
        val s = scannerView ?: return
        s.stopScanning()
        root.removeView(s)
        scannerView = null
    }

    private fun handleScannedQr(text: String) {
        val info = Pairing.parsePairingUri(text)
        if (info == null) {
            showModalError("Invalid QR Code", "The scanned QR code is not a valid PhoneTouch pairing code. Make sure to scan the QR code generated by the Windows companion app.")
            return
        }

        // Show connecting state in modal
        showModalConnecting(info.name ?: "PC")

        // Save address in prefs
        prefs.edit().putString("host", info.host).putInt("port", info.port).apply()

        // Establish secure connection
        client.connect(info.host, info.port, info.code)
    }

    private fun showModalConnecting(hostName: String) {
        connectModal.visibility = View.VISIBLE
        modalSpinner.visibility = View.VISIBLE
        modalCheckBadge.visibility = View.GONE
        modalActions.visibility = View.GONE
        modalTitle.text = "Connecting to PC"
        modalMessage.text = "Attempting to pair with $hostName..."
    }

    private fun showModalSuccess(hostName: String) {
        connectModal.visibility = View.VISIBLE
        modalSpinner.visibility = View.GONE
        modalCheckBadge.visibility = View.VISIBLE
        modalActions.visibility = View.GONE
        modalTitle.text = "Connected Successfully"
        modalMessage.text = "Paired with $hostName. Starting touchpad..."

        // Automatically navigate to mouse surface after 1.2s
        ui.postDelayed({
            if (connState == ConnState.CONNECTED) {
                connectModal.visibility = View.GONE
                welcomeView.visibility = View.GONE
                scrim.visibility = View.GONE
            }
        }, 1200)
    }

    private fun showModalError(title: String, msg: String) {
        connectModal.visibility = View.VISIBLE
        modalSpinner.visibility = View.GONE
        modalCheckBadge.visibility = View.GONE
        modalActions.visibility = View.VISIBLE
        modalTitle.text = title
        modalMessage.text = msg
    }

    private fun showWelcome() {
        welcomeView.visibility = View.VISIBLE
        scrim.visibility = View.GONE
        connectModal.visibility = View.GONE
    }

    // ------------------------------------------------------------------ actions

    private fun onPrimary() {
        when (connState) {
            ConnState.CONNECTED, ConnState.CONNECTING -> client.disconnect()
            ConnState.DISCONNECTED -> startConnect()
        }
    }

    private fun startConnect() {
        val host = hostField.text.toString().trim()
        val port = portField.text.toString().trim().toIntOrNull()
        val code = Pairing.normalizeCode(codeField.text.toString())
        val error = when {
            host.isEmpty() || !host.matches(Regex("[A-Za-z0-9.-]+")) ->
                "Enter the PC address shown in the receiver window (for example 192.168.1.23)."
            port == null || port !in 1024..65535 -> "The port must be a number from 1024 to 65535."
            !Pairing.isValidCode(code) ->
                "The pairing code has 12 letters and digits (it never contains I, L, O, 0 or 1)."
            else -> null
        }
        if (error != null || port == null) {
            showError(error ?: "")
            return
        }
        prefs.edit().putString("host", host).putInt("port", port).apply()
        panelError.visibility = View.GONE
        hideKeyboardFrom(codeField)
        showModalConnecting(host)
        client.connect(host, port, code)
    }

    private fun setMode(keyboard: Boolean) {
        if (keyboardMode == keyboard) return
        keyboardMode = keyboard
        styleTabs(animate = true)
        kbdSurface.visibility = if (keyboard) View.VISIBLE else View.GONE
        keyStrip.visibility = if (keyboard) View.VISIBLE else View.GONE
        pad.reset()
        if (keyboard) {
            showKeyboard()
            if (connState != ConnState.CONNECTED) flash("Not connected — typing will not be sent.")
        } else {
            hideKeyboardFrom(kbd)
        }
    }

    private fun showKeyboard() {
        kbd.requestFocus()
        val imm = getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager
        imm.restartInput(kbd)
        imm.showSoftInput(kbd, InputMethodManager.SHOW_IMPLICIT)
    }

    private fun hideKeyboardFrom(v: View) {
        val token = v.windowToken ?: return
        val imm = getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager
        imm.hideSoftInputFromWindow(token, 0)
    }

    private fun report(sent: Boolean): Boolean {
        if (!sent) flash(if (connState == ConnState.CONNECTED) "Could not send — connection problem." else "Not connected — nothing was sent.")
        return sent
    }

    private fun showPanel(error: String?) {
        welcomeView.visibility = View.GONE
        scrim.visibility = View.VISIBLE
        hideKeyboardFrom(kbd)
        if (error != null) {
            showError(error)
        } else if (connState != ConnState.DISCONNECTED) {
            panelError.visibility = View.GONE
        }
    }

    private fun hidePanel() {
        scrim.visibility = View.GONE
        hideKeyboardFrom(codeField)
        if (keyboardMode) showKeyboard()
        if (connState != ConnState.CONNECTED) showWelcome()
    }

    private fun showError(msg: String) {
        if (msg.isEmpty()) return
        panelError.text = msg
        panelError.visibility = View.VISIBLE
    }

    private fun flash(msg: String) {
        val now = System.currentTimeMillis()
        if (now - lastFlash < 1500) return
        lastFlash = now
        statusText.text = msg
        statusDot.background = oval(RED)
        ui.removeCallbacks(restoreStatus)
        ui.postDelayed(restoreStatus, 2500)
    }

    private val restoreStatus = Runnable { renderState() }

    // ------------------------------------------------------------------ connection callbacks

    override fun onState(state: ConnState, message: String?, isError: Boolean, hostName: String?) {
        runOnUiThread {
            if (isFinishing || isDestroyed) return@runOnUiThread
            val wasConnected = connState == ConnState.CONNECTED
            connState = state
            remoteName = hostName
            renderState()
            when (state) {
                ConnState.CONNECTED -> {
                    codeField.setText("")
                    panelError.visibility = View.GONE
                    window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                    showModalSuccess(hostName ?: "PC")
                }
                ConnState.DISCONNECTED -> {
                    window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                    pad.reset()
                    codeField.setText("")
                    if (isError) {
                        showModalError("Connection Failed", message ?: "Could not connect to PC. Ensure both devices are on the same Wi-Fi network.")
                    } else if (wasConnected) {
                        showWelcome()
                    } else {
                        showWelcome()
                    }
                }
                ConnState.CONNECTING -> {
                    panelError.visibility = View.GONE
                }
            }
        }
    }

    private fun renderState() {
        when (connState) {
            ConnState.CONNECTED -> {
                statusDot.background = oval(GREEN)
                statusText.text = "Connected" + (remoteName?.let { " · $it" } ?: "")
                connectForm.visibility = View.GONE
                connectedInfo.visibility = View.VISIBLE
                connectedInfo.text = "Connected to " + (remoteName ?: "your PC")
                primaryButton.text = "Disconnect"
                primaryButton.background = pill(RED_BG, 12)
                pad.hint = ""
                welcomeView.visibility = View.GONE
            }
            ConnState.CONNECTING -> {
                statusDot.background = oval(ORANGE)
                statusText.text = "Connecting…"
                connectForm.visibility = View.VISIBLE
                connectedInfo.visibility = View.GONE
                primaryButton.text = "Cancel"
                primaryButton.background = pill(SURFACE_2, 12)
                pad.hint = "Connecting…"
            }
            ConnState.DISCONNECTED -> {
                statusDot.background = oval(GRAY)
                statusText.text = "Not connected"
                connectForm.visibility = View.VISIBLE
                connectedInfo.visibility = View.GONE
                primaryButton.text = "Connect"
                primaryButton.background = pill(BLUE, 12)
                pad.hint = ""
                if (scrim.visibility != View.VISIBLE && connectModal.visibility != View.VISIBLE && scannerView == null) {
                    welcomeView.visibility = View.VISIBLE
                }
            }
        }
    }

    // ------------------------------------------------------------------ system gesture protection

    private fun applyGestureProtection(enabled: Boolean) {
        if (enabled) {
            window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        } else {
            window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
        }
    }

    private fun updateGestureExclusion() {
        if (Build.VERSION.SDK_INT >= 29) {
            root.post {
                val w = root.width
                val h = root.height
                if (w > 0 && h > 0) {
                    val edgeWidth = dp(40)
                    val leftRect = Rect(0, 0, edgeWidth, h)
                    val rightRect = Rect(w - edgeWidth, 0, w, h)
                    try {
                        root.systemGestureExclusionRects = listOf(leftRect, rightRect)
                    } catch (_: Exception) {}
                }
            }
        }
    }

    private fun showGestureConflictAdvice() {
        AlertDialog.Builder(this)
            .setTitle("Android System Gestures")
            .setMessage(
                "Manufacturer 3-finger gestures (such as screenshot or split-screen on OnePlus, OPPO, realme, and Xiaomi) are intercepted by the Android operating system before reaching any application.\n\n" +
                "Workarounds applied by PhoneTouch:\n" +
                "• Touchpad Gesture Protection (FLAG_SECURE) is active to block system screenshot captures while using the touchpad.\n" +
                "• Edge exclusion rects are enabled to prevent accidental back gestures.\n\n" +
                "For the best experience on OnePlus / OPPO / realme:\n" +
                "Open Settings > Additional Settings > Gestures & Motions, and temporarily disable '3-Finger Screenshot' while using PhoneTouch."
            )
            .setPositiveButton("Open Settings") { _, _ ->
                try {
                    startActivity(Intent(Settings.ACTION_SETTINGS))
                } catch (_: Exception) {}
            }
            .setNegativeButton("Done", null)
            .show()
    }

    // ------------------------------------------------------------------ window

    private fun hideSystemBars() {
        if (Build.VERSION.SDK_INT >= 30) {
            window.setDecorFitsSystemWindows(false)
            window.insetsController?.let {
                it.hide(WindowInsets.Type.systemBars())
                it.systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            }
        } else {
            @Suppress("DEPRECATION")
            window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or
                View.SYSTEM_UI_FLAG_FULLSCREEN or
                View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or
                View.SYSTEM_UI_FLAG_LAYOUT_STABLE or
                View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN or
                View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
        }
    }

    private fun applySystemBarsAndCutout() {
        if (Build.VERSION.SDK_INT >= 28) {
            window.attributes = window.attributes.apply {
                layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
            }
        }
        root.setOnApplyWindowInsetsListener { _, insets ->
            if (Build.VERSION.SDK_INT >= 28) {
                val left = insets.displayCutout?.safeInsetLeft ?: 0
                (statusPill.layoutParams as FrameLayout.LayoutParams).marginStart = dp(16) + left
                statusPill.requestLayout()
            }
            updateGestureExclusion()
            insets
        }
        hideSystemBars()
    }

    // ------------------------------------------------------------------ view helpers

    private fun match() = FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)

    private fun lp(top: Int) = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
        topMargin = dp(top)
    }

    private fun pill(color: Int, radiusDp: Int) = GradientDrawable().apply {
        setColor(color)
        cornerRadius = dp(radiusDp).toFloat()
    }

    private fun oval(color: Int) = GradientDrawable().apply {
        shape = GradientDrawable.OVAL
        setColor(color)
    }

    private fun tab(label: String, onClick: () -> Unit) = TextView(this).apply {
        text = label
        gravity = Gravity.CENTER
        setPadding(dp(18), dp(7), dp(18), dp(7))
        setOnClickListener { onClick() }
    }

    private fun styleTabs(animate: Boolean) {
        for ((tv, active) in listOf(tabMouse to !keyboardMode, tabKeyboard to keyboardMode)) {
            tv.setTextColor(if (active) Color.WHITE else GRAY)
            tv.textSize = 14f
            tv.typeface = if (active) Typeface.DEFAULT_BOLD else Typeface.DEFAULT
            tv.background = if (active) pill(SURFACE_3, 100) else null
            val scale = if (active) 1.06f else 0.92f
            if (animate) tv.animate().scaleX(scale).scaleY(scale).setDuration(150).start()
            else { tv.scaleX = scale; tv.scaleY = scale }
        }
    }

    private fun editField(hint: String, type: Int) = EditText(this).apply {
        this.hint = hint
        setHintTextColor(GRAY)
        setTextColor(Color.WHITE)
        textSize = 16f
        inputType = type
        isSingleLine = true
        imeOptions = EditorInfo.IME_FLAG_NO_EXTRACT_UI or EditorInfo.IME_FLAG_NO_FULLSCREEN or EditorInfo.IME_ACTION_DONE
        background = pill(SURFACE_2, 10)
        setPadding(dp(12), dp(10), dp(12), dp(10))
    }

    private fun button(label: String, color: Int, onClick: () -> Unit) = Button(this).apply {
        text = label
        setAllCaps(false)
        textSize = 15f
        setTextColor(Color.WHITE)
        background = pill(color, 12)
        minHeight = 0
        minimumHeight = 0
        minWidth = dp(96)
        minimumWidth = dp(96)
        setPadding(dp(16), dp(10), dp(16), dp(10))
        setOnClickListener { onClick() }
    }

    companion object {
        private const val REQ_CAMERA = 101

        private val BG = Color.parseColor("#0B0B0D")
        private val SURFACE = Color.parseColor("#1C1C1E")
        private val SURFACE_2 = Color.parseColor("#2C2C2E")
        private val SURFACE_3 = Color.parseColor("#3A3A3C")
        private val GRAY = Color.parseColor("#8E8E93")
        private val GREEN = Color.parseColor("#32D74B")
        private val ORANGE = Color.parseColor("#FF9F0A")
        private val RED = Color.parseColor("#FF453A")
        private val RED_BG = Color.parseColor("#8E2A26")
        private val BLUE = Color.parseColor("#0A84FF")
    }
}

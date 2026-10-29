# PhoneTouch

Turn an Android phone into a laptop-quality wireless **touchpad and keyboard** for a Windows laptop over your local Wi-Fi.

- **Android app** (Kotlin): full-screen landscape precision touchpad with camera QR scanner, welcome screen, Mouse | Keyboard toggle, and system gesture protection.
- **Windows Companion App** (Node.js, zero dependencies): modern standalone companion UI displaying dynamic QR codes, connection metrics, animated status, and cursor/input control via Windows `SendInput`.
- **Laptop-grade Precision Touchpad Experience**: 3-finger app switching, 3-finger desktop minimize, 3-finger Start menu, 4-finger Action Center, 2-finger smooth scrolling, pinch-to-zoom, and reliable click-and-hold drag & drop.
- **Secure Pairing**: ephemeral single-use QR codes, TLS encryption, mutual HMAC-SHA256 authentication proofs, one controller at a time, rate-limited guessing, and revocable sessions.

---

## Quick Start

### 1. On the Windows laptop (Companion App & Receiver)

1. Install **Node.js 22 LTS or newer** from <https://nodejs.org/>.
2. Double-click **`scripts\start-companion.bat`** (or run `npm start` in `PhoneTouch\windows`).
3. The modern PhoneTouch companion app opens with a prominent **Pair Device** button.
4. Click **Pair Device** to display the secure QR code.
5. If the phone cannot connect, right-click **`scripts\add-firewall-rule.bat`** → *Run as administrator* (adds one narrow rule for Private networks only).

No `npm install` is required: the Windows receiver and companion app run with **zero third-party dependencies**.

### 2. On the Android phone

1. Build the APK locally using `.\gradlew.bat assembleDebug` in `android\` (or download the APK from GitHub Actions).
2. Install the APK:
   ```cmd
   adb install -r android\app\build\outputs\apk\debug\app-debug.apk
   ```
3. Open **PhoneTouch** on your phone (ensure phone and laptop are on the same Wi-Fi).
4. Tap the prominent **Pair Device** button.
5. Scan the QR code displayed on your Windows laptop.
6. A green checkmark confirms **Connected Successfully**, and the app automatically switches to the touchpad surface!

*(Manual entry fallback: you can also tap "Enter Code" to type the PC address, port, and 12-character code by hand).*

---

## Laptop Touchpad Gestures

| Gesture | Action | Shortcut / Behavior |
|---|---|---|
| **One finger moves** | Move the cursor | Natural non-linear acceleration + micro-jitter filter |
| **One-finger tap** | Left click | Standard click (<= 250 ms) |
| **Tap, then press & move** | Drag & drop | Traditional double-tap dragging |
| **Click & hold (>= 320 ms) + move** | Drag & drop | Reliable file/folder dragging without accidental opens |
| **Two-finger tap** | Right click | Context menu |
| **Two fingers swipe up/down** | Vertical scroll | Smooth sub-pixel scrolling (natural scrolling toggle) |
| **Two fingers swipe left/right**| Horizontal scroll | Horizontal scrolling |
| **Two-finger pinch / spread** | Pinch to zoom | Zoom in / Zoom out (`Ctrl + MouseWheel`) |
| **Three-finger swipe left/right**| Switch apps / desktops | `Alt + Tab` / `Alt + Shift + Tab` |
| **Three-finger swipe down** | Show Desktop | Minimize all windows (`Win + D`) |
| **Three-finger swipe up** | Task View | Windows Task View (`Win + Tab`) |
| **Three-finger tap** | Windows Start Menu | Opens Start menu (`Win` key) |
| **Four-finger tap** | Action Center | Opens Windows Notification Center (`Win + A`) |

---

## Preventing Android System Gesture Conflicts

On modern Android phones (especially OnePlus OxygenOS, OPPO ColorOS, realme UI, and Xiaomi MIUI/HyperOS), 3-finger swipe down triggers a system screenshot, and edge swipes trigger the system back gesture.

### Android System Limitations & Honest Technical Facts
Under Android's security model, standard third-party apps **cannot** globally or silently disable protected OEM system gestures without root or system privileges. However, PhoneTouch incorporates the most effective practical solutions:

1. **Touchpad Gesture Protection (`FLAG_SECURE`)**:
   PhoneTouch includes a built-in Touchpad Gesture Protection toggle (enabled by default). By activating `FLAG_SECURE` on the window, OEM screenshot interceptors (such as those in ColorOS / OxygenOS / realme UI) automatically abort the 3-finger screenshot capture, allowing the 3-finger swipe gestures to reach PhoneTouch.
2. **System Gesture Exclusion Rects (`setSystemGestureExclusionRects`)**:
   On Android 10+ (API 29+), PhoneTouch requests edge exclusion rects along the screen boundaries, preventing accidental system back swipes while navigating the touchpad.
3. **In-App Gesture Conflict Guide**:
   A dedicated guide modal in the app explains system gesture behavior and provides a direct shortcut to your phone's *Gestures & Motions* settings so you can disable 3-finger screenshot if your manufacturer ROM ignores window flags.

---

## Project Layout

```
PhoneTouch/
├── README.md
├── android/                      Android app (Kotlin, Gradle wrapper included)
│   └── app/src/main/java/com/phonetouch/app/
│       ├── MainActivity.kt         Welcome screen, modal state, settings, cutout
│       ├── QrScannerView.kt        Camera2 + ZXing QR code scanner overlay
│       ├── TouchpadView.kt         Touch surface, batches movement, scroll, zoom
│       ├── GestureEngine.kt        Windows Precision Touchpad gesture engine
│       ├── KeyboardCaptureView.kt  Soft-keyboard input capture
│       ├── ReceiverClient.kt       TLS WebSocket + mutual HMAC handshake
│       ├── Pairing.kt              HMAC proofs & QR URI parsing (unit-tested)
│       └── Messages.kt             Protocol messages (unit-tested)
├── windows/                      Windows receiver & companion app (Node.js 22+, zero dependencies)
│   ├── server.js                   CLI entry point + auto companion window launch
│   ├── src/
│   │   ├── companion-server.js     Loopback HTTP companion server (SSE + REST)
│   │   ├── companion-ui.html       Modern desktop companion HTML/CSS/JS UI
│   │   ├── qr.js                   Zero-dependency pure JS SVG QR code generator
│   │   ├── receiver.js             Receiver, session management, TLS WebSocket
│   │   ├── protocol.js             Protocol validation (mouse, keys, gestures, zoom)
│   │   └── input/                  Windows SendInput backend (PowerShell/C#) & mock backend
│   └── test/                       Node.js automated test suite (65 passing tests)
├── scripts/
│   ├── start-companion.bat         One-click launch: receiver + desktop companion window
│   ├── start-receiver.bat          Console-only launch script
│   ├── add-firewall-rule.bat       Windows Firewall rule for port 47820
│   └── diagnose.bat                Network and firewall diagnostics
└── docs/                           BUILD_ANDROID, WINDOWS_SETUP, SECURITY, TESTING
```

---

## Exact Commands

### Windows Companion App & Receiver
```cmd
cd PhoneTouch\windows
npm test
npm start
```
*(Or double-click `scripts\start-companion.bat` to launch with the modern companion window).*

### Android Build & Install
```cmd
cd PhoneTouch\android
.\gradlew.bat test
.\gradlew.bat assembleDebug
adb install -r app\build\outputs\apk\debug\app-debug.apk
```

---

## Status & Verification

| Area | Status | Verification |
|---|---|---|
| **Windows Receiver & Companion Server** | **Fully Tested** | 65 automated tests passing (`npm test`), 0 failures. Loopback HTTP UI and QR SVG verified. |
| **Gesture Engine & Math** | **Fully Tested** | 35 automated tests passing (`.\gradlew.bat test`). All gestures, click-and-hold drag, and pinch-zoom verified. |
| **Android APK Build** | **Fully Tested** | Compiles cleanly with Android SDK 34 (`assembleDebug`), packages into `app-debug.apk`. |
| **QR Code Pairing Protocol** | **Fully Tested** | Format vectors, URI parser, and SVG generator match across Kotlin and JavaScript. |
| **Physical Touchscreen & Camera** | **Ready for Device** | Requires physical Android device with camera and Wi-Fi to test physical camera lens autofocus and physical multi-finger feel. |

---

## License

MIT. Provided as-is, without warranty.

# Testing

This file separates **what was actually run** from **what you need to check on real hardware**.

## What was run, and the result

### Windows receiver (Node 22, Linux, recording "mock" input backend)

`cd windows && npm run check && npm test` → static check OK, **60 tests passed, 0 failed.**

| Area | Tests |
|---|---|
| WebSocket (`ws-lite.js`) | RFC 6455 handshake key and "Hello" frame examples; 7/16/64-bit lengths; byte-by-byte fragmentation; rejection of unmasked, reserved-bit, bad-opcode, oversized frames |
| Certificate (`cert.js`) | Parses with Node `X509Certificate`, self-signature verifies, key matches, SAN has the IPs, not a CA, OpenSSL parses it |
| Pairing | Cross-language HMAC vectors; code alphabet/format; single use; expiry; MITM fingerprint mismatch rejected; per-IP lockout with doubling; global burn-and-pause after repeated failures |
| Protocol validation | Every message type: valid and invalid ranges, types, whitelist, Unicode checks, text segmentation |
| Receiver (real TLS + WebSocket on loopback) | Health endpoint and 404/405s; successful pairing and server-proof; left/right click, scroll, key, Unicode text reach the backend; wrong code; MITM fingerprint; control before pairing; second phone refused; disconnect releases held button and issues new code; `revoke()`; invalid input and repeated violations; oversized/binary/unmasked/bad-UTF-8 frames; flood disconnect; lockout and recovery; code expiry; pairing timeout; session expiry; too many pending connections; non-private peers dropped (when such an address exists); **no text or codes in logs**; clean `stop()`; backend failure handled |
| Interop | Node's built-in WebSocket client (an independent RFC 6455 implementation) pairs and sends input |
| Windows backend | Exact PowerShell argument list; command lines for move/button/wheel/key/text (text always base64); unsupported keys refused; startup failure, timeout and unexpected-exit handling — **using a fake process**; helper script's key whitelist equals the receiver's |
| CLI smoke test | `node server.js --backend mock` started, answered `/health`, printed address/port/code, shut down cleanly on SIGINT |

### Android logic (Kotlin 2.0.21 compiler, JVM, no Android classes)

The pure-Kotlin files (`GestureEngine.kt`, `Pairing.kt`, `Messages.kt`) were compiled and their unit tests
(`android/app/src/test/...`) **run: 29 passed, 0 failed**:

- tap = left click; long press = no click; jitter does not click-and-move
- one-finger move and sensitivity; tap-then-press-and-move = drag/drop with correct `down`/`up`; double click; late second tap is not a drag; drag released on cancel
- two-finger tap = right click; two-finger hold = none; vertical and horizontal scroll, natural-scroll flip
- **no cursor jump** when a finger is lifted after scrolling, or added while moving; 3 fingers never click; stray finger during drag
- HMAC proofs equal the receiver's test vectors (the same vectors are asserted in the Node tests); code normalization; JSON escaping; surrogate-safe text chunking; movement splitting

## What was **not** run (please check)

1. **Android compile and APK build.** The sandbox had no Android SDK and could not reach Google/Maven. `MainActivity.kt`, `TouchpadView.kt`, `KeyboardCaptureView.kt`, `ReceiverClient.kt` were only syntax-checked (no syntax errors; type errors against the Android/OkHttp APIs could not be checked). The first cloud build may report small compile errors — fix them from the Gradle message or report them.
2. **Windows `SendInput` helper.** `windows/src/input/input-helper.ps1` (PowerShell + C#) was never executed. It targets Windows PowerShell 5.1 (C# 5 syntax).
3. **Real touch behaviour:** feel of acceleration/sensitivity, edge-swipe conflicts with Android gesture navigation, palm touches.
4. **Soft keyboard behaviour** across keyboard apps (Gboard, Samsung, SwiftKey), including backspace and Unicode/emoji.
5. **Real network:** Wi-Fi latency, Windows Firewall prompt/rules, Public vs Private profile, router client isolation, IPv6-only networks (IPv4 only is supported).
6. **Hardware shortcuts** (Ctrl/Alt/Win combinations, media keys, function keys) — **not supported**, by design.
7. **QR scanning** — not implemented.

## Manual checklist (about 10 minutes, on real devices)

Receiver (Windows):
- [ ] `node -v` ≥ 22; `scripts\start-receiver.bat` prints address, port, code
- [ ] `npm run health` returns `"ok":true`
- [ ] Port in use: start a second receiver → clear error with a suggested port

Pairing:
- [ ] Wrong code → red error on phone; receiver logs "Pairing rejected"; cursor not controllable
- [ ] Three wrong codes → "Too many attempts… retry in N s"
- [ ] Correct code → green status "Connected · <PC name>"; code now invalid (try it again → rejected)
- [ ] Second phone (or same phone, second app instance) → "Another phone is already connected"
- [ ] Phone Disconnect → receiver logs disconnect and shows a **new** code
- [ ] Type `revoke` on the PC → phone shows "disconnected from the PC"; touching the pad does nothing
- [ ] Turn Wi-Fi off on the phone → status returns to disconnected within ~15 s

Mouse:
- [ ] One finger moves the cursor smoothly; speed slider changes speed
- [ ] Tap = left click; double tap = double click (open a folder)
- [ ] Tap, then press and move = drag a window/file; release drops it
- [ ] Two-finger tap = right click (context menu)
- [ ] Two fingers up/down scroll a long web page; left/right scrolls a wide page; natural-scroll toggle flips direction
- [ ] Add/remove a second finger while moving → no cursor jump; three fingers → nothing happens

Keyboard:
- [ ] Switch to Keyboard; soft keyboard appears; typing appears in Notepad on the PC
- [ ] Space, Enter, Backspace, Tab (strip), Esc (strip), arrows (strip)
- [ ] `é ü 世 😀` type correctly
- [ ] With the receiver stopped, typing shows "Not connected — nothing was sent."
- [ ] Notepad text is never echoed on the phone or in the receiver window

Limits:
- [ ] Input into an Administrator window is ignored (expected, see `WINDOWS_SETUP.md`)

## Running the automated tests yourself

```bat
cd windows
npm run check
npm test
```

Android unit tests (needs the Android SDK): `cd android && gradlew testDebugUnitTest`. The cloud workflow runs both.

# Security

PhoneTouch lets a device on your network move your mouse and type on your keyboard, so the design assumes that other
devices on the same Wi-Fi may be hostile. This document says exactly what is protected, how, and what is **not**.

## Summary

| Property | How it is done |
|---|---|
| Only a paired phone can control the PC | Every connection must pass pairing before any control message is accepted. Control messages before pairing close the connection. |
| Pairing code | 12 characters from a 31-symbol alphabet (about 59 bits), random, shown only in the receiver window, **valid 5 minutes, single use**. |
| The code is not sent over the network | The phone sends an HMAC-SHA256 proof, not the code. |
| Encrypted channel | TLS 1.2+ (WebSocket Secure). ECDSA P-256 certificate generated in memory at each receiver start, never written to disk, valid 7 days. |
| Man-in-the-middle detection | The proof is bound to the SHA-256 fingerprint of the certificate the phone received. A different certificate produces a proof the receiver rejects; the receiver also returns a proof the phone verifies before sending input. |
| Guess protection | Per-IP lockout after 3 wrong proofs (15 s, doubling up to 15 min); after 5 wrong proofs in total against one code, that code is destroyed, a new one is issued and pairing pauses 30 s. |
| One controller | A second phone is refused (`busy`) while one is connected. |
| Disconnect / revoke | Closing the app, tapping Disconnect, or typing `revoke` on the PC ends the session immediately; held buttons are released; a **new code** is required. Sessions also expire after 4 hours (configurable). |
| Input validation | Strict JSON schema per message type; integer ranges (move ±1000, scroll ±2400, text ≤ 256 UTF-16 units); keys limited to a fixed whitelist; text control characters removed; frame size limit 8 KiB. |
| Rate limiting | Token buckets for movement and text; a client that floods is disconnected. |
| No command execution | The phone can only cause: relative mouse move, button, wheel, whitelisted key press, or typing text. The PowerShell helper reads a fixed command grammar and passes text base64-encoded; nothing is ever evaluated or executed. |
| Network exposure | Binds only to this PC's private IPv4 addresses (+ loopback for the health check). Peers outside private/link-local/loopback ranges are dropped before TLS. |
| Logging | Keyboard text, pairing codes and movement are never logged. Logs contain only connect/disconnect events with the peer's LAN IP and device name. |
| Health endpoint | `GET /health` returns state and uptime only. It cannot control anything. |

## What this is **not**

- **Not CA-verified TLS.** The certificate is self-signed and ephemeral, so the phone cannot check it against a certificate authority. Identity is proven by the code-bound proof instead (above). This protects against passive eavesdropping and against a man-in-the-middle who does not know the code.
- **Not a PAKE.** An active attacker who intercepts the connection *during the 5-minute pairing window* learns a proof computed from the code and could try to brute-force the code offline. With about 59 bits of entropy and a code that is single-use and expires, this is impractical, but a password-authenticated key exchange (for example SPAKE2) would remove the concern. Not implemented.
- **A PIN alone is not encryption.** The code only authenticates; confidentiality comes from TLS.
- **Not safe on a hostile network.** Do not use it on public Wi-Fi. Anyone who can see the pairing code (shoulder-surfing the receiver window) during its 5 minutes can pair first.
- **No protection from malware on either device.** A compromised phone that is already paired can control the PC for the session.
- **Not audited.** This code has not had an independent security review.

## Safe-use rules

1. Use only on a network you trust, with the Windows network profile set to **Private**.
2. Allow the firewall for **Private networks only** (`scripts\add-firewall-rule.bat` does this and also restricts to the local subnet).
3. **Never** port-forward the receiver or expose it to the internet. **Never** turn the firewall off to make it work.
4. Pair only when you start the receiver yourself; type `revoke` or close the receiver when you are done.
5. Keep the receiver window closed when you are not using PhoneTouch.

## Windows limits

Windows blocks input from normal programs into elevated (administrator) windows, the UAC prompt and the lock screen. PhoneTouch does not try to bypass that.

## Reporting problems

If you find a security problem, do not post exploit details publicly; contact the person who gave you this project.

# Windows receiver setup

The receiver is a small Node.js program with **no third-party dependencies**. It must stay running (in its own window) while you use the phone.

## 1. Install Node.js

1. Go to <https://nodejs.org/> and install the **LTS** version (Node 22 or newer; the receiver refuses to start on older versions).
2. Close and reopen any Command Prompt windows afterwards.
3. Check: open **Command Prompt** and run `node -v` — it should print `v22.x.x` or higher.

## 2. Start the receiver

**Easiest:** double-click `scripts\start-receiver.bat`.

**Or from Command Prompt:**

```bat
cd C:\path\to\PhoneTouch\windows
npm install
npm start
```

(`npm install` does nothing because there are no dependencies, but it is harmless.)

The window shows something like:

```
  On your phone, enter:
      Address : 192.168.1.23
      Port    : 47820
      Code    : K7QM-X2TD-9FRA   (valid 5 min, one use)
```

**Keep this window open.** Closing it (or pressing Ctrl+C) stops the receiver and ends any session.

Commands you can type in that window: `status`, `new` (new pairing code), `revoke` (disconnect the phone), `quit`.

Options: `node server.js --help` (port, address, code lifetime, session length). Example: `npm start -- --port 50000`.

## 3. Stop the receiver

Type `quit` and press Enter, or press **Ctrl+C**, or close the window. A held mouse button is released on shutdown.

## 4. Health check

With the receiver running, in a **second** Command Prompt:

```bat
cd C:\path\to\PhoneTouch\windows
npm run health
```

It prints `{"ok":true,"app":"PhoneTouch",...}`. The health endpoint reveals no secrets and cannot control anything.

## 5. Firewall (Private networks only)

The first time the receiver listens, Windows may ask whether to allow Node.js through the firewall.
Choose **Private networks only** — **never** tick "Public networks".

If you did not get the prompt, or the phone cannot connect, add one narrow rule:

- Right-click `scripts\add-firewall-rule.bat` → **Run as administrator**.
  It allows inbound TCP 47820 for `node.exe`, on **Private** networks, from the **local subnet** only.
- Remove it later with `scripts\remove-firewall-rule.bat`.

Do **not** turn the firewall off, and do **not** forward this port on your router. The receiver is for your home/office LAN only.

If your Wi-Fi is classed as **Public**, the rule above will not apply. Change it in *Settings → Network & Internet → Wi-Fi → (your network) → Network profile type → Private* — only on a network you trust.

## 6. Troubleshooting

Run `scripts\diagnose.bat` — it prints your IP addresses, network profile, port usage, firewall rule and a health check.

| Symptom | Cause / fix |
|---|---|
| `port 47820 is already in use` | Another receiver (or program) uses it. Close it, or `npm start -- --port 50000` and enter the new port on the phone. Find the owner: `netstat -ano \| findstr :47820`. |
| Phone says "Timed out" or "Could not reach the PC" | Different Wi-Fi/subnet; firewall (see section 5); receiver not running; wrong address. |
| Works on this PC (`npm run health`) but never from the phone | Firewall, a **Public** network profile, or **client/AP isolation** on the router (common on guest Wi-Fi, hotels, campuses). Try another network or disable isolation for your own devices. |
| Several addresses listed | The PC has several network adapters. Use the one in the same range as the phone (usually `192.168.x.x`). Pick explicitly with `npm start -- --host 192.168.1.23`. |
| "Pairing code has expired" / wrong code | Use the newest code printed in the window (they last 5 minutes and work once). Type `new` for a fresh one. |
| "Too many attempts" | Wrong codes cause temporary lockouts (15 s, doubling). Wait, then use the current code. |
| Cursor moves but cannot click inside some windows | Windows does not let a normal program send input to **administrator** windows, the UAC prompt or the lock screen. Run the receiver as administrator if you really need that. |
| `The Windows input helper exited` | PowerShell could not compile the small input helper — usually antivirus or a restricted PowerShell. See the message printed after it. |

## 7. Network facts

- The receiver listens only on this PC's **private** IPv4 addresses (10.x, 172.16–31.x, 192.168.x) and on loopback (for the local health check). It never listens on all interfaces or on a public address.
- Connections from non-private addresses are dropped before any data is processed.

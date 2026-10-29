package com.phonetouch.app

import okhttp3.ConnectionSpec
import okhttp3.HttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.net.ConnectException
import java.net.NoRouteToHostException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import java.security.SecureRandom
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLException
import javax.net.ssl.X509TrustManager

enum class ConnState { DISCONNECTED, CONNECTING, CONNECTED }

/**
 * Connection to the PhoneTouch receiver: TLS WebSocket + pairing handshake.
 *
 * TLS note: the receiver's certificate is self-signed and regenerated at every start, so it cannot
 * be validated against a certificate authority. Instead this client records the SHA-256 fingerprint
 * of the certificate it was shown and binds the pairing proof to it (see [Pairing]). A
 * man-in-the-middle presenting a different certificate cannot produce a valid proof, and the phone
 * verifies the receiver's reply proof before it sends any input.
 *
 * Listener callbacks may arrive on any thread.
 */
class ReceiverClient(
    private val deviceName: String,
    private val listener: Listener,
) {
    interface Listener {
        fun onState(state: ConnState, message: String?, isError: Boolean, hostName: String?)
    }

    private class Attempt(val code: String) {
        @Volatile var socket: WebSocket? = null
        @Volatile var fingerprint: String? = null
        @Volatile var serverNonce: String = ""
        @Volatile var clientNonce: String = ""
        @Volatile var challengeSeen = false
        @Volatile var connected = false
        val finished = AtomicBoolean(false)
    }

    @Volatile private var current: Attempt? = null

    val state: ConnState
        get() = when {
            current?.connected == true -> ConnState.CONNECTED
            current != null -> ConnState.CONNECTING
            else -> ConnState.DISCONNECTED
        }

    private val timers = Executors.newSingleThreadScheduledExecutor { r ->
        Thread(r, "phonetouch-timer").apply { isDaemon = true }
    }
    private val random = SecureRandom()

    fun connect(host: String, port: Int, code: String) {
        disconnect(notify = false)
        val attempt = Attempt(Pairing.normalizeCode(code))
        current = attempt

        val url = try {
            HttpUrl.Builder().scheme("https").host(host).port(port).addPathSegment("ws").build()
        } catch (e: IllegalArgumentException) {
            current = null
            listener.onState(ConnState.DISCONNECTED, "That address is not valid.", true, null)
            return
        }
        listener.onState(ConnState.CONNECTING, "Connecting…", false, null)

        val trust = object : X509TrustManager {
            override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) {
                throw CertificateException("client certificates are not accepted")
            }

            override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {
                if (chain.isEmpty()) throw CertificateException("empty certificate chain")
                attempt.fingerprint = Pairing.fingerprintHex(chain[0].encoded)
            }

            override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
        }
        val ssl = SSLContext.getInstance("TLS")
        ssl.init(null, arrayOf(trust), random)

        val client = OkHttpClient.Builder()
            .sslSocketFactory(ssl.socketFactory, trust)
            .hostnameVerifier { _, _ -> true } // identity is proven by the pairing proof, not the hostname
            .connectionSpecs(listOf(ConnectionSpec.RESTRICTED_TLS))
            .connectTimeout(6, TimeUnit.SECONDS)
            .writeTimeout(10, TimeUnit.SECONDS)
            .readTimeout(0, TimeUnit.MILLISECONDS)
            .pingInterval(5, TimeUnit.SECONDS)
            .retryOnConnectionFailure(false)
            .build()

        val socket = client.newWebSocket(Request.Builder().url(url).build(), object : WebSocketListener() {
            override fun onMessage(webSocket: WebSocket, text: String) = handleMessage(attempt, webSocket, text)

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(code, reason)
                finish(attempt, closeMessage(code), isError = code != 1000 && code != 1001)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                finish(attempt, closeMessage(code), isError = code != 1000 && code != 1001)
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                finish(attempt, describeFailure(t), isError = true)
            }
        })
        attempt.socket = socket

        // The whole pairing handshake must finish quickly.
        timers.schedule(
            Runnable {
                if (!attempt.connected && !attempt.finished.get()) {
                    finish(attempt, "Pairing timed out. Check the address and that the receiver is running.", true)
                }
            },
            12,
            TimeUnit.SECONDS,
        )
    }

    /** Disconnect and revoke this phone's session on the PC. */
    fun disconnect(notify: Boolean = true) {
        val a = current ?: return
        current = null
        if (a.finished.compareAndSet(false, true)) {
            val s = a.socket
            if (a.connected) s?.send(Messages.BYE)
            s?.close(1000, "bye")
            // make sure the TCP connection really goes away even if the PC does not answer
            timers.schedule(Runnable { s?.cancel() }, 2, TimeUnit.SECONDS)
            a.connected = false
            if (notify) listener.onState(ConnState.DISCONNECTED, "Disconnected.", false, null)
        }
    }

    /** @return false if the message could not be sent (not connected or the socket refused it). */
    fun send(text: String, droppable: Boolean = false): Boolean {
        val a = current ?: return false
        if (!a.connected) return false
        val s = a.socket ?: return false
        if (droppable && s.queueSize() > MAX_QUEUE_BYTES) return true // Wi-Fi is stalling: skip stale movement
        return s.send(text)
    }

    fun sendMove(dx: Int, dy: Int): Boolean {
        var rx = dx
        var ry = dy
        while (rx != 0 || ry != 0) {
            val px = rx.coerceIn(-Messages.MAX_MOVE, Messages.MAX_MOVE)
            val py = ry.coerceIn(-Messages.MAX_MOVE, Messages.MAX_MOVE)
            rx -= px
            ry -= py
            if (!send(Messages.move(px, py), droppable = true)) return false
        }
        return true
    }

    fun sendScroll(dx: Int, dy: Int): Boolean =
        send(Messages.scroll(dx.coerceIn(-Messages.MAX_SCROLL, Messages.MAX_SCROLL), dy.coerceIn(-Messages.MAX_SCROLL, Messages.MAX_SCROLL)), droppable = true)

    fun sendGesture(action: String): Boolean = send(Messages.gesture(action))

    fun sendZoom(dy: Int): Boolean =
        send(Messages.zoom(dy.coerceIn(-Messages.MAX_SCROLL, Messages.MAX_SCROLL)), droppable = true)

    fun sendButton(button: Char, action: Char): Boolean = send(Messages.button(button, action))

    fun sendKey(name: String): Boolean = send(Messages.key(name))

    fun sendText(text: String): Boolean {
        for (chunk in Messages.chunkText(text)) if (!send(Messages.text(chunk))) return false
        return true
    }

    // ------------------------------------------------------------------ internals

    private fun handleMessage(a: Attempt, ws: WebSocket, text: String) {
        if (a.finished.get()) return
        val json = try {
            JSONObject(text)
        } catch (e: Exception) {
            return
        }
        when (json.optString("t")) {
            "challenge" -> {
                if (a.challengeSeen) return
                a.challengeSeen = true
                val fp = a.fingerprint
                val sn = json.optString("sn")
                if (fp == null || !Pairing.isHex(sn, 32)) {
                    finish(a, "The receiver sent an invalid challenge.", true)
                    return
                }
                val cnBytes = ByteArray(16).also { random.nextBytes(it) }
                val cn = Pairing.toHex(cnBytes)
                a.serverNonce = sn
                a.clientNonce = cn
                ws.send(Messages.pair(cn, Pairing.proof("client", a.code, sn, cn, fp), deviceName))
            }
            "paired" -> {
                val fp = a.fingerprint
                val expected = if (fp != null && a.challengeSeen) {
                    Pairing.proof("server", a.code, a.serverNonce, a.clientNonce, fp)
                } else {
                    null
                }
                if (expected == null || !Pairing.constantTimeEquals(expected, json.optString("proof"))) {
                    finish(a, "The receiver could not prove it knows the pairing code. Connection refused.", true)
                    return
                }
                a.connected = true
                listener.onState(ConnState.CONNECTED, "Connected", false, json.optString("host").ifEmpty { null })
            }
            "error" -> {
                val retry = json.optInt("retry", 0)
                val msg = json.optString("msg", "The receiver refused the connection.")
                finish(a, if (retry > 0) "$msg (retry in $retry s)" else msg, true)
            }
            else -> Unit // "pong" and anything unknown
        }
    }

    private fun finish(a: Attempt, message: String, isError: Boolean) {
        if (!a.finished.compareAndSet(false, true)) return
        if (current === a) current = null
        a.connected = false
        a.socket?.cancel()
        listener.onState(ConnState.DISCONNECTED, message, isError, null)
    }

    private fun closeMessage(code: Int): String = when (code) {
        1000 -> "Disconnected."
        1001 -> "The receiver was stopped on the PC."
        4000 -> "Pairing timed out."
        4001 -> "Pairing was rejected."
        4002 -> "Another phone is already connected to this PC."
        4004 -> "This phone was disconnected from the PC."
        4008 -> "The session expired. Pair again with the new code."
        4009 -> "Disconnected: too much input was sent too fast."
        4010 -> "The PC could not apply input. Check the receiver window."
        else -> "Connection closed (code $code)."
    }

    private fun describeFailure(t: Throwable): String = when (t) {
        is SocketTimeoutException ->
            "Timed out. Make sure the PC and phone are on the same Wi-Fi and the receiver is running."
        is ConnectException, is NoRouteToHostException ->
            "Could not reach the PC. Check the address and port, that the receiver is running, and Windows Firewall."
        is UnknownHostException -> "Unknown address. Enter the IPv4 address shown by the receiver."
        is SSLException -> "Secure connection failed. Is that address really the PhoneTouch receiver?"
        else -> "Connection lost" + (t.message?.let { " ($it)" } ?: ".")
    }

    companion object {
        private const val MAX_QUEUE_BYTES = 128L * 1024L
    }
}

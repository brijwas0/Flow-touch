package com.phonetouch.app

import java.security.MessageDigest
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * Pairing proofs. Pure JVM code (no Android classes) so it can be unit-tested.
 *
 * The pairing code is never sent over the network. The phone proves it knows the code with
 *   HMAC-SHA256(key = code, "PT1|<role>|<serverNonce>|<clientNonce>|<certFingerprint>")
 * where certFingerprint is the SHA-256 of the TLS certificate this phone actually received.
 * Must stay byte-for-byte compatible with windows/src/pairing.js.
 */
object Pairing {
    const val ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
    const val CODE_LENGTH = 12

    private const val HEX = "0123456789abcdef"

    /** Uppercase and drop everything that is not a letter or digit (spaces, dashes). */
    fun normalizeCode(input: String): String =
        input.uppercase().filter { it in 'A'..'Z' || it in '0'..'9' }

    fun isValidCode(normalized: String): Boolean =
        normalized.length == CODE_LENGTH && normalized.all { it in ALPHABET }

    fun proof(
        role: String,
        code: String,
        serverNonce: String,
        clientNonce: String,
        fingerprintHex: String,
    ): String {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(normalizeCode(code).toByteArray(Charsets.UTF_8), "HmacSHA256"))
        val msg = "PT1|$role|$serverNonce|$clientNonce|$fingerprintHex"
        return toHex(mac.doFinal(msg.toByteArray(Charsets.UTF_8)))
    }

    fun fingerprintHex(certificateDer: ByteArray): String =
        toHex(MessageDigest.getInstance("SHA-256").digest(certificateDer))

    fun toHex(bytes: ByteArray): String {
        val sb = StringBuilder(bytes.size * 2)
        for (b in bytes) {
            val v = b.toInt() and 0xff
            sb.append(HEX[v shr 4]).append(HEX[v and 0x0f])
        }
        return sb.toString()
    }

    fun isHex(s: String, length: Int): Boolean =
        s.length == length && s.all { it in '0'..'9' || it in 'a'..'f' }

    fun constantTimeEquals(a: String, b: String): Boolean =
        MessageDigest.isEqual(a.toByteArray(Charsets.UTF_8), b.toByteArray(Charsets.UTF_8))

    fun parsePairingUri(uriString: String): PairingInfo? {
        val clean = uriString.trim()
        if (!clean.startsWith("phonetouch://", ignoreCase = true)) return null
        val qIdx = clean.indexOf('?')
        if (qIdx < 0) return null
        val query = clean.substring(qIdx + 1)
        var host = ""
        var port = 47820
        var code = ""
        var name: String? = null

        for (part in query.split('&')) {
            val eq = part.indexOf('=')
            if (eq < 0) continue
            val k = part.substring(0, eq).trim().lowercase()
            val rawVal = part.substring(eq + 1).trim()
            val v = try {
                java.net.URLDecoder.decode(rawVal, "UTF-8")
            } catch (e: Exception) {
                rawVal
            }
            when (k) {
                "h", "host" -> host = v
                "p", "port" -> port = v.toIntOrNull() ?: 47820
                "c", "code" -> code = normalizeCode(v)
                "n", "name" -> name = v.ifBlank { null }
            }
        }

        if (host.isBlank() || port !in 1024..65535 || !isValidCode(code)) return null
        return PairingInfo(host, port, code, name)
    }
}

data class PairingInfo(
    val host: String,
    val port: Int,
    val code: String,
    val name: String?,
)

package com.phonetouch.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PairingTest {
    private val fp = "ac978e63f273ba9ee1132bfecc103c767c52512fd5b065cc0ee224f9ec49d6a2"
    private val sn = "00112233445566778899aabbccddeeff"
    private val cn = "ffeeddccbbaa99887766554433221100"

    @Test
    fun fingerprintMatchesReceiverTestVector() {
        assertEquals(fp, Pairing.fingerprintHex("test-cert".toByteArray()))
    }

    // These two vectors are asserted identically in windows/test/pairing.test.js.
    @Test
    fun clientProofMatchesReceiver() {
        assertEquals(
            "f0a847480defde8fdd0d4bf693c9ffa0e92c5d19e5c80ba47e7856997bcdd9c7",
            Pairing.proof("client", "K7QM-X2TD-9FRA", sn, cn, fp),
        )
    }

    @Test
    fun serverProofMatchesReceiverAndCodeIsNormalized() {
        assertEquals(
            "9e4d7765473728217eb4ea1d49176b47a1839be7e40bd00c5fbd98781213033e",
            Pairing.proof("server", "k7qm x2td 9fra", sn, cn, fp),
        )
    }

    @Test
    fun codeNormalizationAndValidation() {
        assertEquals("K7QMX2TD9FRA", Pairing.normalizeCode(" k7qm-x2td 9fra "))
        assertTrue(Pairing.isValidCode("K7QMX2TD9FRA"))
        assertFalse(Pairing.isValidCode("K7QMX2TD9FR")) // too short
        assertFalse(Pairing.isValidCode("K7QMX2TD9FRO")) // O is not in the alphabet
        assertFalse(Pairing.isValidCode("K7QMX2TD9FR1")) // 1 is not in the alphabet
    }

    @Test
    fun hexAndConstantTimeCompare() {
        assertTrue(Pairing.constantTimeEquals("abc", "abc"))
        assertFalse(Pairing.constantTimeEquals("abc", "abd"))
    }

    @Test
    fun parsePairingUriValidAndInvalid() {
        val uri = "phonetouch://pair?h=192.168.1.15&p=47820&c=K7QM-X2TD-9FRA&n=DesktopPC"
        val info = Pairing.parsePairingUri(uri)
        assertTrue(info != null)
        assertEquals("192.168.1.15", info?.host)
        assertEquals(47820, info?.port)
        assertEquals("K7QMX2TD9FRA", info?.code)
        assertEquals("DesktopPC", info?.name)

        // Invalid scheme or code
        assertTrue(Pairing.parsePairingUri("https://google.com") == null)
        assertTrue(Pairing.parsePairingUri("phonetouch://pair?h=1.2.3.4&p=47820&c=BAD") == null)
    }
}

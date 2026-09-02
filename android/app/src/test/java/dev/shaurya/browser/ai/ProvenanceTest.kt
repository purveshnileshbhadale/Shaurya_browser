package dev.shaurya.browser.ai

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Where inference runs.
 *
 * The badge this drives is the difference between "the page text stayed on
 * the phone" and "the page text was posted to someone's server". Getting it
 * backwards would be a privacy claim that is simply false, so the cases are
 * enumerated rather than guessed at from a loose substring.
 */
class ProvenanceTest {

    @Test
    fun `loopback is on this device`() {
        for (e in listOf(
            "http://localhost:11434",
            "http://127.0.0.1:11434/api",
            "http://127.5.6.7/api",
            "http://[::1]:11434",
            "HTTP://LOCALHOST:11434",
            "  http://localhost  ",
        )) {
            assertEquals(e, "On this device", AiClient.providerLabel(e))
            assertTrue(e, AiClient.isLocal(e))
        }
    }

    @Test
    fun `private ranges are the network, not the device`() {
        // A model served from 192.168.1.40 is running on another machine.
        // It never reaches the public internet, which is worth saying — but
        // it is not this phone, and the badge must not claim it is.
        for (e in listOf(
            "http://192.168.1.40:11434",
            "http://10.0.0.5:11434",
            "http://172.16.0.9/api",
            "http://172.31.255.1/api",
            "http://169.254.4.4/api",
        )) {
            assertEquals(e, "On your network", AiClient.providerLabel(e))
            assertFalse(e, AiClient.isLocal(e))
        }
    }

    @Test
    fun `172 is only private in the 16 to 31 block`() {
        assertEquals("Hosted · 172.15.0.1", AiClient.providerLabel("http://172.15.0.1/v1"))
        assertEquals("Hosted · 172.32.0.1", AiClient.providerLabel("http://172.32.0.1/v1"))
    }

    @Test
    fun `anything else is hosted, and named`() {
        assertEquals(
            "Hosted · api.anthropic.com",
            AiClient.providerLabel("https://api.anthropic.com"),
        )
        assertEquals("Hosted · example.com", AiClient.providerLabel("https://example.com/v1"))
        assertFalse(AiClient.isLocal("https://api.anthropic.com"))
    }

    @Test
    fun `a host that merely begins with localhost is not local`() {
        // The failure a startsWith("http://localhost") check produces: an
        // attacker-controlled domain badged as running on your phone. Both
        // schemes, because only one of them was ever tested before.
        for (e in listOf("http://localhost.evil.com/v1", "https://localhost.evil.com/v1")) {
            assertEquals(e, "Hosted · localhost.evil.com", AiClient.providerLabel(e))
            assertFalse(e, AiClient.isLocal(e))
        }
    }

    @Test
    fun `credentials in the URL do not disguise the host`() {
        // "http://localhost@evil.com" reads as localhost and resolves to
        // evil.com. The host is what after the last '@', not before it.
        assertEquals(
            "Hosted · evil.com",
            AiClient.providerLabel("http://localhost@evil.com/v1"),
        )
        assertFalse(AiClient.isLocal("http://localhost@evil.com/v1"))
    }

    @Test
    fun `a hosted service is not local just for having ollama in its name`() {
        // The old check matched the substring "ollama" anywhere in the URL,
        // which made a real hosted domain read as on-device.
        assertEquals("Hosted · ollama.com", AiClient.providerLabel("https://ollama.com/api"))
        assertFalse(AiClient.isLocal("https://ollama.com/api"))
    }

    @Test
    fun `a near-miss dotted quad is a hostname, not an address`() {
        // "10.a.b.c" has four parts and starts with 10; it is still a name.
        assertEquals("Hosted · 10.a.b.c", AiClient.providerLabel("https://10.a.b.c/v1"))
        assertEquals("Hosted · 10.0.0.999", AiClient.providerLabel("https://10.0.0.999/v1"))
    }

    @Test
    fun `an unset endpoint says so rather than guessing`() {
        for (e in listOf("", "   ")) assertEquals(e, "Not configured", AiClient.providerLabel(e))
    }
}

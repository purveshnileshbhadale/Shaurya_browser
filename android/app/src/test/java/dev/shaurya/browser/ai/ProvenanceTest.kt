package dev.shaurya.browser.ai

import org.junit.Assert.assertEquals
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
    fun `loopback and LAN addresses are local`() {
        for (e in listOf(
            "http://localhost:11434",
            "http://127.0.0.1:11434/api",
            "http://[::1]:11434",
            "http://192.168.1.40:11434",
            "http://10.0.0.5:11434",
            "https://my-ollama.internal/api",
        )) assertEquals(e, "On this device", AiClient.providerLabel(e))
    }

    @Test
    fun `anything else is hosted`() {
        for (e in listOf("https://api.anthropic.com", "https://example.com/v1", "", "   ")) {
            assertEquals(e, "Hosted endpoint", AiClient.providerLabel(e))
        }
    }

    @Test
    fun `a remote host that merely mentions localhost is not local`() {
        // The failure a naive contains("localhost") would produce: an
        // attacker-controlled domain badged as running on your phone.
        assertEquals("Hosted endpoint", AiClient.providerLabel("https://localhost.evil.com/v1"))
    }

    @Test
    fun `case and whitespace do not change the verdict`() {
        assertEquals("On this device", AiClient.providerLabel("  HTTP://LOCALHOST:11434  "))
    }
}

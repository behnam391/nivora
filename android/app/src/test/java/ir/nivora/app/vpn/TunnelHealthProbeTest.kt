package ir.nivora.app.vpn

import java.net.ServerSocket
import kotlin.concurrent.thread
import org.junit.Assert.*
import org.junit.Test

class TunnelHealthProbeTest {
    @Test fun refusesAnUnauthenticatedLocalProxy() {
        ServerSocket(0).use { server ->
            val worker=thread(isDaemon=true){server.accept().use { socket ->
                val greeting=ByteArray(3);java.io.DataInputStream(socket.getInputStream()).readFully(greeting)
                socket.getOutputStream().write(byteArrayOf(5,0))
            }}
            assertNull(TunnelHealthProbe.measure(HealthProxy(server.localPort,"user","password"),listOf("https://example.invalid/generate_204"),1_000))
            worker.join(1_000)
        }
    }
    @Test fun boundsAnUnresponsiveProxy() {
        ServerSocket(0).use { server ->
            val worker=thread(isDaemon=true){server.accept().use { socket -> Thread.sleep(700) }}
            val started=System.nanoTime()
            assertNull(TunnelHealthProbe.measure(HealthProxy(server.localPort,"user","password"),listOf("https://example.invalid/generate_204"),200))
            assertTrue((System.nanoTime()-started)/1_000_000<1_000)
            worker.join(1_000)
        }
    }
}

package ir.nivora.app.vpn

import java.io.DataInputStream
import java.net.InetSocketAddress
import java.net.Socket
import java.net.URI
import java.util.Collections
import java.util.concurrent.Callable
import java.util.concurrent.ExecutorCompletionService
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import javax.net.ssl.SNIHostName
import javax.net.ssl.SSLSocket
import javax.net.ssl.SSLSocketFactory

internal data class HealthProxy(val port:Int,val user:String,val password:String)

/** HTTPS through the running Xray outbound, never a direct connectivity probe.
 * SOCKS authentication is per-run; this is not an open proxy for other apps. */
internal object TunnelHealthProbe {
    fun measure(proxy:HealthProxy, targets:List<String>, budgetMs:Long=3_500):Long? {
        val sockets=Collections.synchronizedList(mutableListOf<Socket>())
        val pool=Executors.newFixedThreadPool(targets.size.coerceIn(1,3)) { task -> Thread(task,"nivora-health").apply { isDaemon=true } }
        val completions=ExecutorCompletionService<Long?>(pool)
        val deadline=System.nanoTime()+TimeUnit.MILLISECONDS.toNanos(budgetMs)
        targets.take(3).forEach { target -> completions.submit(Callable { runCatching { probe(proxy,target,sockets) }.getOrNull() }) }
        return try {
            repeat(targets.size.coerceAtMost(3)) {
                val remaining=deadline-System.nanoTime()
                if(remaining<=0)return null
                val future=completions.poll(remaining,TimeUnit.NANOSECONDS)?:return null
                future.get()?.let { return it }
            }
            null
        } finally {
            synchronized(sockets) { sockets.forEach { runCatching { it.close() } } }
            pool.shutdownNow()
        }
    }

    private fun probe(proxy:HealthProxy,target:String,sockets:MutableList<Socket>):Long {
        val uri=URI(target);require(uri.scheme=="https" && uri.host!=null)
        val started=System.nanoTime()
        Socket().use { socket ->
            sockets.add(socket);socket.soTimeout=1_800
            socket.connect(InetSocketAddress("127.0.0.1",proxy.port),700)
            val input=DataInputStream(socket.getInputStream());val output=socket.getOutputStream()
            output.write(byteArrayOf(5,1,2));output.flush()
            require(input.readUnsignedByte()==5 && input.readUnsignedByte()==2)
            val user=proxy.user.toByteArray();val password=proxy.password.toByteArray()
            output.write(byteArrayOf(1,user.size.toByte())+user+byteArrayOf(password.size.toByte())+password);output.flush()
            require(input.readUnsignedByte()==1 && input.readUnsignedByte()==0)
            val host=uri.host.toByteArray(Charsets.US_ASCII);val port=if(uri.port>0)uri.port else 443
            output.write(byteArrayOf(5,1,0,3,host.size.toByte())+host+byteArrayOf((port shr 8).toByte(),port.toByte()));output.flush()
            require(input.readUnsignedByte()==5 && input.readUnsignedByte()==0);input.readUnsignedByte()
            val count=when(input.readUnsignedByte()){1->4;4->16;3->input.readUnsignedByte();else->error("BAD_PROXY_RESPONSE")}
            input.readFully(ByteArray(count+2))
            val tls=(SSLSocketFactory.getDefault() as SSLSocketFactory).createSocket(socket,uri.host,port,true) as SSLSocket
            tls.use {
                it.soTimeout=1_800
                it.sslParameters=it.sslParameters.apply { endpointIdentificationAlgorithm="HTTPS";serverNames=listOf(SNIHostName(uri.host)) }
                it.startHandshake()
                val path=uri.rawPath.ifBlank { "/" }+(uri.rawQuery?.let { q->"?$q" }?:"")
                it.outputStream.write("GET $path HTTP/1.1\r\nHost: ${uri.host}\r\nConnection: close\r\nCache-Control: no-cache\r\n\r\n".toByteArray());it.outputStream.flush()
                val stream=it.inputStream;val line=StringBuilder()
                while(line.length<256){val c=stream.read();if(c<0)error("EMPTY_RESPONSE");if(c==10)break;line.append(c.toChar())}
                require(Regex("^HTTP/1\\.[01] 204(?: |\\r|$)").containsMatchIn(line))
                return TimeUnit.NANOSECONDS.toMillis(System.nanoTime()-started)
            }
        }
    }
}

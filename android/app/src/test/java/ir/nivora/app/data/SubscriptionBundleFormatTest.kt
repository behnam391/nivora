package ir.nivora.app.data
import java.util.Base64
import org.junit.Assert.*
import org.junit.Test
class SubscriptionBundleFormatTest {
    private val route="vless://test@example.invalid:443?security=reality#test"
    @Test fun acceptsRawAndBase64(){assertEquals(route,SubscriptionBundleFormat.normalize(route));assertEquals(route,SubscriptionBundleFormat.normalize(Base64.getEncoder().encodeToString(route.toByteArray())))}
    @Test fun refusesHtmlAndOrdinaryUrls(){assertNull(SubscriptionBundleFormat.normalize("<html>https://example.invalid</html>"));assertNull(SubscriptionBundleFormat.normalize("https://example.invalid"))}
    @Test fun rejectsMixedContent(){assertNull(SubscriptionBundleFormat.normalize(route+"\n<html>error</html>"))}
}

package ir.nivora.app.vpn

import android.app.PendingIntent
import android.content.Intent
import android.net.VpnService
import android.os.Build
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService
import androidx.core.content.ContextCompat
import ir.nivora.app.MainActivity
import ir.nivora.app.data.QuickConnectionStore
import ir.nivora.app.data.SecureSessionStore

class NivoraQuickTileService : TileService() {
    override fun onStartListening() {
        super.onStartListening()
        refreshTile()
    }

    override fun onClick() {
        super.onClick()
        if (NivoraVpnService.isCoreRunning() || getSharedPreferences("vpn", MODE_PRIVATE).getString("state", "disconnected") in setOf("connected", "connecting")) {
            startService(Intent(this, NivoraVpnService::class.java).setAction(NivoraVpnService.ACTION_STOP))
            qsTile?.state = Tile.STATE_INACTIVE
            qsTile?.label = "Nivora خاموش"
            qsTile?.updateTile()
            return
        }
        val session=SecureSessionStore(this)
        val route=QuickConnectionStore(this).read()
        val token=session.token()
        val deviceId=getSharedPreferences("nivora_device",MODE_PRIVATE).getString("id",null)
        if(route!=null&&token!=null&&deviceId!=null&&session.isRecentlyValidated()&&VpnService.prepare(this)==null){
            ContextCompat.startForegroundService(this,Intent(this,NivoraVpnService::class.java)
                .putExtra(NivoraVpnService.EXTRA_URL,route.url)
                .putExtra(NivoraVpnService.EXTRA_SUBSCRIPTION_ID,route.subscriptionId)
                .putExtra(NivoraVpnService.EXTRA_SESSION_TOKEN,token)
                .putExtra(NivoraVpnService.EXTRA_DEVICE_ID,deviceId)
                .putExtra(NivoraVpnService.EXTRA_LABEL,route.label))
            qsTile?.state=Tile.STATE_ACTIVE
            qsTile?.label="Nivora روشن"
            qsTile?.updateTile()
            return
        }
        val launch = Intent(this, MainActivity::class.java).setAction(MainActivity.ACTION_QUICK_CONNECT).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        if (Build.VERSION.SDK_INT >= 34) startActivityAndCollapse(PendingIntent.getActivity(this, 92, launch, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
        else {
            @Suppress("DEPRECATION")
            startActivityAndCollapse(launch)
        }
    }

    private fun refreshTile() {
        val active = NivoraVpnService.isCoreRunning() || getSharedPreferences("vpn", MODE_PRIVATE).getString("state", "disconnected") == "connected"
        qsTile?.state = if (active) Tile.STATE_ACTIVE else Tile.STATE_INACTIVE
        qsTile?.label = if (active) "Nivora روشن" else "Nivora خاموش"
        qsTile?.updateTile()
    }
}

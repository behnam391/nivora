package ir.nivora.app.data
data class Plan(val id:String,val name:String,val priceToman:Int,val trafficGb:Int,val durationDays:Int,val deviceLimit:Int)
data class Subscription(val id:String,val planName:String,val status:String,val url:String?,val usedBytes:Long,val totalBytes:Long,val remainingBytes:Long,val usagePercent:Double,val remainingDays:Int,val expiryTime:Long?,val startsOnFirstUse:Boolean,val locationName:String?)
data class Account(val name:String,val phone:String,val balanceToman:Int,val subscriptions:List<Subscription>)
data class Session(val token:String,val name:String)
data class PaymentCard(val number:String,val holder:String,val bank:String?)

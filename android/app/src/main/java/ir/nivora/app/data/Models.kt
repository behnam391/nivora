package ir.nivora.app.data
data class Plan(val id:String,val name:String,val priceToman:Int,val trafficGb:Int,val durationDays:Int,val deviceLimit:Int)
data class Subscription(val id:String,val planName:String,val status:String,val url:String?)
data class Account(val name:String,val phone:String,val balanceToman:Int,val subscriptions:List<Subscription>)
data class Session(val token:String,val name:String)

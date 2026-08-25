package ir.nivora.app.data

object ResellerPolicy {
    fun matchesCustomer(name: String, phone: String, query: String): Boolean {
        val normalized = query.trim()
        return normalized.isBlank() ||
            name.contains(normalized, ignoreCase = true) ||
            phone.contains(normalized)
    }

    fun canControl(order: ResellerOrder): Boolean =
        order.orderKind == "purchase" && order.status !in setOf("failed", "expired", "deleted")

    fun canRenew(order: ResellerOrder): Boolean =
        order.orderKind == "purchase" && order.effectiveStatus == "active"

    fun profit(salePriceToman: Int, resellerCostToman: Int): Int =
        salePriceToman - resellerCostToman

    fun validTransfer(amountToman: Int, resellerBalanceToman: Int): Boolean =
        amountToman > 0 && amountToman <= resellerBalanceToman

    fun validDebt(amountToman: Int, note: String): Boolean =
        amountToman > 0 && note.trim().length >= 3
}

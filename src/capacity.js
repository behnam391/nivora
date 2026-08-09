export function selectLocationForPlan(db, planId) {
  const rows=db.prepare(`SELECT l.*,(SELECT COUNT(*) FROM orders o LEFT JOIN subscriptions s ON s.order_id=o.id WHERE o.location_id=l.id AND o.order_kind='purchase' AND o.status='approved' AND COALESCE(s.status,'pending_provision') IN ('pending_provision','active')) used_capacity FROM service_locations l JOIN plan_locations pl ON pl.location_id=l.id WHERE pl.plan_id=? AND l.active=1 ORDER BY CASE WHEN l.capacity=0 THEN 0.0 ELSE (1.0*(SELECT COUNT(*) FROM orders o2 WHERE o2.location_id=l.id AND o2.order_kind='purchase')/l.capacity) END,l.created_at`).all(planId);
  if(!rows.length)return {id:null,name:'Default',panel_inbound_id:null,capacity:0,used_capacity:0};
  return rows.find(l=>l.capacity===0||l.used_capacity<l.capacity)||null;
}

import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export function openDatabase(path = process.env.DATABASE_PATH || './data/nivora.db') {
  const filename = path === ':memory:' ? path : resolve(path);
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS plans (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      price_irr INTEGER NOT NULL CHECK(price_irr >= 0),
      traffic_gb INTEGER NOT NULL CHECK(traffic_gb > 0),
      duration_days INTEGER NOT NULL CHECK(duration_days > 0),
      device_limit INTEGER NOT NULL DEFAULT 1 CHECK(device_limit > 0),
      sort_order INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      customer_name TEXT NOT NULL,
      phone TEXT NOT NULL,
      plan_id TEXT NOT NULL REFERENCES plans(id),
      status TEXT NOT NULL CHECK(status IN ('awaiting_receipt','under_review','approved','rejected')),
      amount_transferred_irr INTEGER,
      receipt_reference TEXT,
      receipt_image_url TEXT,
      review_note TEXT,
      reviewed_by TEXT,
      created_at TEXT NOT NULL,
      reviewed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS subscriptions (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL UNIQUE REFERENCES orders(id),
      status TEXT NOT NULL CHECK(status IN ('pending_provision','active','failed','expired')),
      panel_client_id TEXT,
      subscription_url TEXT,
      provision_error TEXT,
      created_at TEXT NOT NULL,
      activated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      details TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS payment_cards (
      id TEXT PRIMARY KEY,
      card_number TEXT NOT NULL,
      card_holder TEXT NOT NULL,
      bank_name TEXT NOT NULL DEFAULT '',
      sort_order INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      phone TEXT UNIQUE,
      name TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('customer','reseller','staff','admin')),
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','suspended')),
      default_discount_percent INTEGER NOT NULL DEFAULT 0 CHECK(default_discount_percent BETWEEN 0 AND 100),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS wallet_accounts (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL UNIQUE REFERENCES accounts(id),
      balance_toman INTEGER NOT NULL DEFAULT 0 CHECK(balance_toman >= 0),
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS wallet_transactions (
      id TEXT PRIMARY KEY,
      wallet_id TEXT NOT NULL REFERENCES wallet_accounts(id),
      amount_toman INTEGER NOT NULL CHECK(amount_toman <> 0),
      balance_after_toman INTEGER NOT NULL CHECK(balance_after_toman >= 0),
      type TEXT NOT NULL CHECK(type IN ('manual_credit','manual_debit','purchase','refund','transfer_in','transfer_out','commission')),
      reference TEXT NOT NULL UNIQUE,
      actor TEXT NOT NULL,
      note TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS reseller_plan_prices (
      reseller_id TEXT NOT NULL REFERENCES accounts(id),
      plan_id TEXT NOT NULL REFERENCES plans(id),
      price_toman INTEGER NOT NULL CHECK(price_toman >= 0),
      active INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(reseller_id,plan_id)
    );
    CREATE TABLE IF NOT EXISTS reseller_customers (
      id TEXT PRIMARY KEY,
      reseller_id TEXT NOT NULL REFERENCES accounts(id),
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(reseller_id,phone)
    );
    CREATE TABLE IF NOT EXISTS service_locations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      country_code TEXT NOT NULL,
      city TEXT NOT NULL DEFAULT '',
      provider TEXT NOT NULL DEFAULT '',
      panel_type TEXT NOT NULL DEFAULT '3x-ui',
      panel_inbound_id INTEGER,
      panel_cdn_inbound_id INTEGER,
      capacity INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS plan_locations (
      plan_id TEXT NOT NULL REFERENCES plans(id),
      location_id TEXT NOT NULL REFERENCES service_locations(id),
      PRIMARY KEY(plan_id,location_id)
    );
    CREATE TABLE IF NOT EXISTS location_endpoints (
      id TEXT PRIMARY KEY,
      location_id TEXT NOT NULL REFERENCES service_locations(id) ON DELETE CASCADE,
      label TEXT NOT NULL,
      host TEXT NOT NULL,
      port INTEGER NOT NULL DEFAULT 443 CHECK(port BETWEEN 1 AND 65535),
      mode TEXT NOT NULL DEFAULT 'direct' CHECK(mode IN ('direct','cloudflare')),
      server_name TEXT,
      source_url TEXT,
      priority INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      health_status TEXT NOT NULL DEFAULT 'unknown' CHECK(health_status IN ('unknown','online','offline')),
      last_latency_ms INTEGER,
      last_checked_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(location_id,host,port)
    );
    CREATE TABLE IF NOT EXISTS account_sessions (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id),
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS password_reset_requests (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id),
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','resolved','dismissed')),
      requested_at TEXT NOT NULL,
      resolved_at TEXT,
      resolved_by TEXT
    );
    CREATE TABLE IF NOT EXISTS wallet_topups (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id),
      amount_toman INTEGER NOT NULL CHECK(amount_toman > 0),
      receipt_reference TEXT,
      receipt_image_url TEXT,
      status TEXT NOT NULL DEFAULT 'under_review' CHECK(status IN ('under_review','approved','rejected')),
      review_note TEXT,
      reviewed_by TEXT,
      created_at TEXT NOT NULL,
      reviewed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS discount_codes (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      percent INTEGER NOT NULL CHECK(percent BETWEEN 1 AND 100),
      max_uses INTEGER NOT NULL DEFAULT 0 CHECK(max_uses >= 0),
      per_customer_limit INTEGER NOT NULL DEFAULT 1 CHECK(per_customer_limit > 0),
      expires_at TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS discount_redemptions (
      id TEXT PRIMARY KEY,
      discount_id TEXT NOT NULL REFERENCES discount_codes(id),
      account_id TEXT NOT NULL REFERENCES accounts(id),
      order_id TEXT NOT NULL UNIQUE REFERENCES orders(id),
      discount_toman INTEGER NOT NULL CHECK(discount_toman >= 0),
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS support_tickets (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id),
      subject TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','answered','closed')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ticket_messages (
      id TEXT PRIMARY KEY,
      ticket_id TEXT NOT NULL REFERENCES support_tickets(id),
      sender_role TEXT NOT NULL CHECK(sender_role IN ('customer','admin')),
      body TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id),
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      read_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS password_reset_codes (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id),
      code_hash TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      consumed_at TEXT,
      created_at TEXT NOT NULL
    );
  `);
  const orderColumns = db.prepare('PRAGMA table_info(orders)').all().map(c => c.name);
  if (!orderColumns.includes('tracking_token')) db.exec('ALTER TABLE orders ADD COLUMN tracking_token TEXT');
  if (!orderColumns.includes('account_id')) db.exec('ALTER TABLE orders ADD COLUMN account_id TEXT REFERENCES accounts(id)');
  if (!orderColumns.includes('reseller_id')) db.exec('ALTER TABLE orders ADD COLUMN reseller_id TEXT REFERENCES accounts(id)');
  if (!orderColumns.includes('location_id')) db.exec('ALTER TABLE orders ADD COLUMN location_id TEXT REFERENCES service_locations(id)');
  if (!orderColumns.includes('order_kind')) db.exec("ALTER TABLE orders ADD COLUMN order_kind TEXT NOT NULL DEFAULT 'purchase'");
  if (!orderColumns.includes('parent_order_id')) db.exec('ALTER TABLE orders ADD COLUMN parent_order_id TEXT REFERENCES orders(id)');
  if (!orderColumns.includes('reseller_customer_id')) db.exec('ALTER TABLE orders ADD COLUMN reseller_customer_id TEXT REFERENCES reseller_customers(id)');
  if (!orderColumns.includes('reseller_sale_price_toman')) db.exec('ALTER TABLE orders ADD COLUMN reseller_sale_price_toman INTEGER');
  const subscriptionColumns = db.prepare('PRAGMA table_info(subscriptions)').all().map(c => c.name);
  if (!subscriptionColumns.includes('upstream_subscription_url')) db.exec('ALTER TABLE subscriptions ADD COLUMN upstream_subscription_url TEXT');
  if (!subscriptionColumns.includes('access_token')) db.exec('ALTER TABLE subscriptions ADD COLUMN access_token TEXT');
  if (!subscriptionColumns.includes('suspension_reason')) db.exec('ALTER TABLE subscriptions ADD COLUMN suspension_reason TEXT');
  if (!subscriptionColumns.includes('suspended_at')) db.exec('ALTER TABLE subscriptions ADD COLUMN suspended_at TEXT');
  if (!subscriptionColumns.includes('deleted_at')) db.exec('ALTER TABLE subscriptions ADD COLUMN deleted_at TEXT');
  if (!subscriptionColumns.includes('control_status')) db.exec("ALTER TABLE subscriptions ADD COLUMN control_status TEXT NOT NULL DEFAULT 'active'");
  const locationColumns = db.prepare('PRAGMA table_info(service_locations)').all().map(c => c.name);
  if (!locationColumns.includes('panel_cdn_inbound_id')) db.exec('ALTER TABLE service_locations ADD COLUMN panel_cdn_inbound_id INTEGER');
  const endpointColumns = db.prepare('PRAGMA table_info(location_endpoints)').all().map(c => c.name);
  if (!endpointColumns.includes('mode')) db.exec("ALTER TABLE location_endpoints ADD COLUMN mode TEXT NOT NULL DEFAULT 'direct' CHECK(mode IN ('direct','cloudflare'))");
  if (!endpointColumns.includes('server_name')) db.exec('ALTER TABLE location_endpoints ADD COLUMN server_name TEXT');
  if (!endpointColumns.includes('source_url')) db.exec('ALTER TABLE location_endpoints ADD COLUMN source_url TEXT');
  const accountColumns = db.prepare('PRAGMA table_info(accounts)').all().map(c => c.name);
  if (!accountColumns.includes('password_hash')) db.exec('ALTER TABLE accounts ADD COLUMN password_hash TEXT');
  if (!accountColumns.includes('password_salt')) db.exec('ALTER TABLE accounts ADD COLUMN password_salt TEXT');
  if (!accountColumns.includes('managed_by_reseller_id')) db.exec('ALTER TABLE accounts ADD COLUMN managed_by_reseller_id TEXT REFERENCES accounts(id)');
  const resellerCustomerColumns = db.prepare('PRAGMA table_info(reseller_customers)').all().map(c => c.name);
  if (!resellerCustomerColumns.includes('account_id')) db.exec('ALTER TABLE reseller_customers ADD COLUMN account_id TEXT REFERENCES accounts(id)');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_tracking_token ON orders(tracking_token)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_wallet_topups_account ON wallet_topups(account_id,created_at DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_tickets_account ON support_tickets(account_id,updated_at DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_notifications_account ON notifications(account_id,created_at DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_password_resets_status ON password_reset_requests(status,requested_at DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_password_reset_codes_account ON password_reset_codes(account_id,created_at DESC)');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_reseller_customers_account ON reseller_customers(account_id) WHERE account_id IS NOT NULL');
  db.exec(`CREATE TABLE IF NOT EXISTS telegram_recovery_sessions (chat_id TEXT PRIMARY KEY,account_id TEXT REFERENCES accounts(id),verified_phone TEXT,state TEXT NOT NULL DEFAULT 'waiting_contact',expires_at TEXT NOT NULL,created_at TEXT NOT NULL)`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_reseller_customers_owner ON reseller_customers(reseller_id,status,updated_at DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_location_endpoints_location ON location_endpoints(location_id,active,priority)');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_access_token ON subscriptions(access_token) WHERE access_token IS NOT NULL');
  db.exec('UPDATE subscriptions SET upstream_subscription_url=subscription_url WHERE upstream_subscription_url IS NULL AND subscription_url IS NOT NULL');
  const subscriptionsWithoutToken = db.prepare("SELECT s.id FROM subscriptions s JOIN orders o ON o.id=s.order_id WHERE s.access_token IS NULL AND o.order_kind='purchase'").all();
  const addSubscriptionToken = db.prepare('UPDATE subscriptions SET access_token=? WHERE id=?');
  for (const subscription of subscriptionsWithoutToken) addSubscriptionToken.run(randomUUID().replace(/-/g,''),subscription.id);
  const legacyCustomers = db.prepare(`SELECT reseller_id,phone,MAX(customer_name) name,MIN(created_at) created_at,MAX(created_at) updated_at FROM orders WHERE reseller_id IS NOT NULL AND phone IS NOT NULL GROUP BY reseller_id,phone`).all();
  const insertLegacyCustomer = db.prepare(`INSERT OR IGNORE INTO reseller_customers(id,reseller_id,name,phone,note,status,created_at,updated_at) VALUES(?,?,?,?,?,'active',?,?)`);
  for (const customer of legacyCustomers) insertLegacyCustomer.run(randomUUID(),customer.reseller_id,customer.name,customer.phone,'',customer.created_at,customer.updated_at);
  db.exec(`UPDATE orders SET reseller_customer_id=(SELECT rc.id FROM reseller_customers rc WHERE rc.reseller_id=orders.reseller_id AND rc.phone=orders.phone) WHERE reseller_id IS NOT NULL AND reseller_customer_id IS NULL`);
  db.exec(`UPDATE orders SET reseller_sale_price_toman=(SELECT CAST(p.price_irr/10 AS INTEGER) FROM plans p WHERE p.id=orders.plan_id) WHERE reseller_id IS NOT NULL AND reseller_sale_price_toman IS NULL`);
  db.exec(`
    CREATE TABLE IF NOT EXISTS bank_transactions (
      id TEXT PRIMARY KEY,
      amount_rial INTEGER NOT NULL DEFAULT 0,
      tracking_code TEXT,
      card_last4 TEXT,
      bank TEXT NOT NULL DEFAULT '',
      direction TEXT NOT NULL DEFAULT 'credit' CHECK(direction IN ('credit','debit','unknown')),
      raw_message TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'sms',
      status TEXT NOT NULL DEFAULT 'unmatched' CHECK(status IN ('unmatched','matched','ignored')),
      matched_order_id TEXT REFERENCES orders(id),
      received_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      dedupe_key TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_bank_tx_dedupe ON bank_transactions(dedupe_key);
    CREATE INDEX IF NOT EXISTS idx_bank_tx_match ON bank_transactions(status,direction,amount_rial,received_at);
    CREATE TABLE IF NOT EXISTS order_reviews (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL REFERENCES orders(id),
      decision TEXT NOT NULL CHECK(decision IN ('approved','rejected','manual')),
      confidence INTEGER NOT NULL DEFAULT 0,
      reason TEXT NOT NULL DEFAULT '',
      matched_bank_tx_id TEXT REFERENCES bank_transactions(id),
      ocr_amount_rial INTEGER,
      ocr_tracking_code TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_order_reviews_order ON order_reviews(order_id,created_at DESC);
  `);
  return db;
}

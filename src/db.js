import { DatabaseSync } from 'node:sqlite';
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
    CREATE TABLE IF NOT EXISTS service_locations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      country_code TEXT NOT NULL,
      city TEXT NOT NULL DEFAULT '',
      provider TEXT NOT NULL DEFAULT '',
      panel_type TEXT NOT NULL DEFAULT '3x-ui',
      panel_inbound_id INTEGER,
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
    CREATE TABLE IF NOT EXISTS account_sessions (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id),
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
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
  `);
  const orderColumns = db.prepare('PRAGMA table_info(orders)').all().map(c => c.name);
  if (!orderColumns.includes('tracking_token')) db.exec('ALTER TABLE orders ADD COLUMN tracking_token TEXT');
  if (!orderColumns.includes('account_id')) db.exec('ALTER TABLE orders ADD COLUMN account_id TEXT REFERENCES accounts(id)');
  if (!orderColumns.includes('reseller_id')) db.exec('ALTER TABLE orders ADD COLUMN reseller_id TEXT REFERENCES accounts(id)');
  if (!orderColumns.includes('location_id')) db.exec('ALTER TABLE orders ADD COLUMN location_id TEXT REFERENCES service_locations(id)');
  if (!orderColumns.includes('order_kind')) db.exec("ALTER TABLE orders ADD COLUMN order_kind TEXT NOT NULL DEFAULT 'purchase'");
  if (!orderColumns.includes('parent_order_id')) db.exec('ALTER TABLE orders ADD COLUMN parent_order_id TEXT REFERENCES orders(id)');
  const accountColumns = db.prepare('PRAGMA table_info(accounts)').all().map(c => c.name);
  if (!accountColumns.includes('password_hash')) db.exec('ALTER TABLE accounts ADD COLUMN password_hash TEXT');
  if (!accountColumns.includes('password_salt')) db.exec('ALTER TABLE accounts ADD COLUMN password_salt TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_tracking_token ON orders(tracking_token)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_wallet_topups_account ON wallet_topups(account_id,created_at DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_tickets_account ON support_tickets(account_id,updated_at DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_notifications_account ON notifications(account_id,created_at DESC)');
  return db;
}

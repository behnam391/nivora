import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export function openDatabase(path = process.env.DATABASE_PATH || './data/nivora.db') {
  const filename = path === ':memory:' ? path : resolve(path);
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA secure_delete = ON;');
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
      device_limit_override INTEGER CHECK(device_limit_override IS NULL OR device_limit_override BETWEEN 1 AND 10),
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
      flag_emoji TEXT NOT NULL DEFAULT '',
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
    CREATE TABLE IF NOT EXISTS panel_nodes (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT '',
      panel_type TEXT NOT NULL DEFAULT '3x-ui',
      base_url TEXT NOT NULL DEFAULT '',
      subscription_base_url TEXT NOT NULL DEFAULT '',
      vision_inbound_ids TEXT NOT NULL DEFAULT '',
      cdn_inbound_ids TEXT NOT NULL DEFAULT '',
      api_token_encrypted TEXT NOT NULL DEFAULT '',
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
      device_id TEXT REFERENCES account_devices(id),
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS account_devices (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      device_hash TEXT NOT NULL,
      label TEXT NOT NULL DEFAULT '',
      platform TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','revoked')),
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      revoked_at TEXT,
      revoked_by TEXT,
      UNIQUE(account_id,device_hash)
    );
    CREATE TABLE IF NOT EXISTS subscription_import_tokens (
      id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
      device_id TEXT NOT NULL REFERENCES account_devices(id) ON DELETE CASCADE,
      platform TEXT NOT NULL DEFAULT 'ios',
      expires_at TEXT NOT NULL,
      max_fetches INTEGER NOT NULL DEFAULT 3 CHECK(max_fetches BETWEEN 1 AND 10),
      fetch_count INTEGER NOT NULL DEFAULT 0 CHECK(fetch_count >= 0),
      created_at TEXT NOT NULL,
      last_fetched_at TEXT,
      revoked_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_subscription_import_tokens_lookup
      ON subscription_import_tokens(token_hash,expires_at);
    CREATE INDEX IF NOT EXISTS idx_subscription_import_tokens_account
      ON subscription_import_tokens(account_id,created_at);
    CREATE TABLE IF NOT EXISTS hysteria_nodes (
      id TEXT PRIMARY KEY,
      location_id TEXT NOT NULL REFERENCES service_locations(id) ON DELETE CASCADE,
      public_host TEXT NOT NULL,
      public_port INTEGER NOT NULL CHECK(public_port BETWEEN 1 AND 65535),
      sni TEXT NOT NULL DEFAULT '',
      obfs_type TEXT NOT NULL DEFAULT '',
      obfs_password_encrypted TEXT NOT NULL DEFAULT '',
      pin_sha256 TEXT NOT NULL DEFAULT '',
      priority INTEGER NOT NULL DEFAULT 100,
      node_secret_hash TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS hysteria_tickets (
      id TEXT PRIMARY KEY,
      subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
      node_id TEXT NOT NULL REFERENCES hysteria_nodes(id) ON DELETE CASCADE,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      device_binding_hash TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      client_id TEXT,
      expires_at TEXT NOT NULL,
      consumed_at TEXT,
      revoked_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS hysteria_usage_counters (
      node_id TEXT NOT NULL REFERENCES hysteria_nodes(id) ON DELETE CASCADE,
      client_id TEXT NOT NULL,
      last_tx_bytes INTEGER NOT NULL DEFAULT 0,
      last_rx_bytes INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(node_id, client_id)
    );
    CREATE TABLE IF NOT EXISTS password_reset_requests (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id),
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','resolved','dismissed')),
      requested_at TEXT NOT NULL,
      resolved_at TEXT,
      resolved_by TEXT
    );
    CREATE TABLE IF NOT EXISTS device_recovery_requests (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      requested_device_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','expired')),
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
    CREATE TABLE IF NOT EXISTS receipt_uploads (
      filename TEXT PRIMARY KEY,
      account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
      access_token_hash TEXT NOT NULL,
      mime_type TEXT NOT NULL CHECK(mime_type IN ('image/jpeg','image/png','image/webp')),
      byte_size INTEGER NOT NULL CHECK(byte_size BETWEEN 1 AND 4194304),
      created_at TEXT NOT NULL,
      linked_entity_type TEXT CHECK(linked_entity_type IN ('order','wallet_topup')),
      linked_entity_id TEXT,
      linked_at TEXT,
      CHECK((linked_entity_type IS NULL AND linked_entity_id IS NULL AND linked_at IS NULL) OR
            (linked_entity_type IS NOT NULL AND linked_entity_id IS NOT NULL AND linked_at IS NOT NULL))
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
      owner_archived_at TEXT,
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
      dismissed_at TEXT,
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
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS telegram_account_links (telegram_user_id TEXT PRIMARY KEY,chat_id TEXT NOT NULL,account_id TEXT NOT NULL REFERENCES accounts(id),phone TEXT NOT NULL,linked_at TEXT NOT NULL,last_seen_at TEXT NOT NULL);
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
  if (!subscriptionColumns.includes('hysteria_started_at')) db.exec('ALTER TABLE subscriptions ADD COLUMN hysteria_started_at TEXT');
  if (!subscriptionColumns.includes('hysteria_expires_at')) db.exec('ALTER TABLE subscriptions ADD COLUMN hysteria_expires_at TEXT');
  if (!subscriptionColumns.includes('hysteria_duration_days')) db.exec('ALTER TABLE subscriptions ADD COLUMN hysteria_duration_days INTEGER NOT NULL DEFAULT 0');
  if (!subscriptionColumns.includes('hysteria_traffic_limit_bytes')) db.exec('ALTER TABLE subscriptions ADD COLUMN hysteria_traffic_limit_bytes INTEGER NOT NULL DEFAULT 0');
  if (!subscriptionColumns.includes('hysteria_used_bytes')) db.exec('ALTER TABLE subscriptions ADD COLUMN hysteria_used_bytes INTEGER NOT NULL DEFAULT 0');
  const hysteriaNodeColumns = db.prepare('PRAGMA table_info(hysteria_nodes)').all().map(c => c.name);
  if (!hysteriaNodeColumns.includes('obfs_type')) db.exec("ALTER TABLE hysteria_nodes ADD COLUMN obfs_type TEXT NOT NULL DEFAULT ''");
  if (!hysteriaNodeColumns.includes('obfs_password_encrypted')) db.exec("ALTER TABLE hysteria_nodes ADD COLUMN obfs_password_encrypted TEXT NOT NULL DEFAULT ''");
  if (!hysteriaNodeColumns.includes('pin_sha256')) db.exec("ALTER TABLE hysteria_nodes ADD COLUMN pin_sha256 TEXT NOT NULL DEFAULT ''");
  if (!hysteriaNodeColumns.includes('priority')) db.exec('ALTER TABLE hysteria_nodes ADD COLUMN priority INTEGER NOT NULL DEFAULT 100');
  const locationColumns = db.prepare('PRAGMA table_info(service_locations)').all().map(c => c.name);
  if (!locationColumns.includes('flag_emoji')) db.exec("ALTER TABLE service_locations ADD COLUMN flag_emoji TEXT NOT NULL DEFAULT ''");
  if (!locationColumns.includes('panel_cdn_inbound_id')) db.exec('ALTER TABLE service_locations ADD COLUMN panel_cdn_inbound_id INTEGER');
  if (!locationColumns.includes('panel_node_id')) db.exec('ALTER TABLE service_locations ADD COLUMN panel_node_id TEXT REFERENCES panel_nodes(id)');
  const nodeColumns = db.prepare('PRAGMA table_info(panel_nodes)').all().map(c => c.name);
  if (!nodeColumns.includes('subscription_base_url')) db.exec("ALTER TABLE panel_nodes ADD COLUMN subscription_base_url TEXT NOT NULL DEFAULT ''");
  if (!nodeColumns.includes('vision_inbound_ids')) db.exec("ALTER TABLE panel_nodes ADD COLUMN vision_inbound_ids TEXT NOT NULL DEFAULT ''");
  if (!nodeColumns.includes('cdn_inbound_ids')) db.exec("ALTER TABLE panel_nodes ADD COLUMN cdn_inbound_ids TEXT NOT NULL DEFAULT ''");
  const endpointColumns = db.prepare('PRAGMA table_info(location_endpoints)').all().map(c => c.name);
  if (!endpointColumns.includes('mode')) db.exec("ALTER TABLE location_endpoints ADD COLUMN mode TEXT NOT NULL DEFAULT 'direct' CHECK(mode IN ('direct','cloudflare'))");
  if (!endpointColumns.includes('server_name')) db.exec('ALTER TABLE location_endpoints ADD COLUMN server_name TEXT');
  if (!endpointColumns.includes('source_url')) db.exec('ALTER TABLE location_endpoints ADD COLUMN source_url TEXT');
  const accountColumns = db.prepare('PRAGMA table_info(accounts)').all().map(c => c.name);
  if (!accountColumns.includes('password_hash')) db.exec('ALTER TABLE accounts ADD COLUMN password_hash TEXT');
  if (!accountColumns.includes('password_salt')) db.exec('ALTER TABLE accounts ADD COLUMN password_salt TEXT');
  if (!accountColumns.includes('device_binding_hash')) db.exec('ALTER TABLE accounts ADD COLUMN device_binding_hash TEXT');
  if (!accountColumns.includes('device_bound_at')) db.exec('ALTER TABLE accounts ADD COLUMN device_bound_at TEXT');
  if (!accountColumns.includes('device_limit_override')) {
    // NULL inherits the largest active plan, including for existing accounts.
    db.exec('ALTER TABLE accounts ADD COLUMN device_limit_override INTEGER CHECK(device_limit_override IS NULL OR device_limit_override BETWEEN 1 AND 10)');
  }
  if (!accountColumns.includes('managed_by_reseller_id')) db.exec('ALTER TABLE accounts ADD COLUMN managed_by_reseller_id TEXT REFERENCES accounts(id)');
  const sessionColumns = db.prepare('PRAGMA table_info(account_sessions)').all().map(c => c.name);
  if (!sessionColumns.includes('device_id')) db.exec('ALTER TABLE account_sessions ADD COLUMN device_id TEXT REFERENCES account_devices(id)');
  const resellerCustomerColumns = db.prepare('PRAGMA table_info(reseller_customers)').all().map(c => c.name);
  if (!resellerCustomerColumns.includes('account_id')) db.exec('ALTER TABLE reseller_customers ADD COLUMN account_id TEXT REFERENCES accounts(id)');
  const ticketColumns = db.prepare('PRAGMA table_info(support_tickets)').all().map(c => c.name);
  if (!ticketColumns.includes('owner_archived_at')) db.exec('ALTER TABLE support_tickets ADD COLUMN owner_archived_at TEXT');
  const notificationColumns = db.prepare('PRAGMA table_info(notifications)').all().map(c => c.name);
  if (!notificationColumns.includes('dismissed_at')) db.exec('ALTER TABLE notifications ADD COLUMN dismissed_at TEXT');
  // Early development builds created receipt_uploads.account_id as NOT NULL.
  // Rebuild that small metadata table once so the rate-limited public store can
  // keep guest checkout while authenticated uploads still retain ownership.
  const receiptTableColumns=db.prepare('PRAGMA table_info(receipt_uploads)').all(),receiptAccountColumn=receiptTableColumns.find(column=>column.name==='account_id');
  const receiptForeignKey=db.prepare('PRAGMA foreign_key_list(receipt_uploads)').all().find(key=>key.from==='account_id');
  const rebuildReceiptUploads=Boolean(receiptAccountColumn?.notnull||String(receiptForeignKey?.on_delete||'').toUpperCase()!=='SET NULL');
  if(rebuildReceiptUploads){
    const hadReceiptLinks=receiptTableColumns.some(column=>column.name==='linked_entity_type');
    const legacyLinkSelect=hadReceiptLinks
      ? "CASE WHEN linked_entity_type IN ('order','wallet_topup') AND linked_entity_id IS NOT NULL AND linked_at IS NOT NULL THEN linked_entity_type END,CASE WHEN linked_entity_type IN ('order','wallet_topup') AND linked_entity_id IS NOT NULL AND linked_at IS NOT NULL THEN linked_entity_id END,CASE WHEN linked_entity_type IN ('order','wallet_topup') AND linked_entity_id IS NOT NULL AND linked_at IS NOT NULL THEN linked_at END"
      : 'NULL,NULL,NULL';
    db.exec('PRAGMA foreign_keys = OFF');
    try{
      db.exec(`BEGIN IMMEDIATE;
        ALTER TABLE receipt_uploads RENAME TO receipt_uploads_legacy;
        CREATE TABLE receipt_uploads (
          filename TEXT PRIMARY KEY,
          account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
          access_token_hash TEXT NOT NULL,
          mime_type TEXT NOT NULL CHECK(mime_type IN ('image/jpeg','image/png','image/webp')),
          byte_size INTEGER NOT NULL CHECK(byte_size BETWEEN 1 AND 4194304),
          created_at TEXT NOT NULL,
          linked_entity_type TEXT CHECK(linked_entity_type IN ('order','wallet_topup')),
          linked_entity_id TEXT,
          linked_at TEXT,
          CHECK((linked_entity_type IS NULL AND linked_entity_id IS NULL AND linked_at IS NULL) OR
                (linked_entity_type IS NOT NULL AND linked_entity_id IS NOT NULL AND linked_at IS NOT NULL))
        );
        INSERT INTO receipt_uploads(filename,account_id,access_token_hash,mime_type,byte_size,created_at,linked_entity_type,linked_entity_id,linked_at)
          SELECT filename,account_id,access_token_hash,mime_type,byte_size,created_at,${legacyLinkSelect} FROM receipt_uploads_legacy;
        DROP TABLE receipt_uploads_legacy;
        COMMIT;`);
    }catch(error){try{db.exec('ROLLBACK')}catch{}throw error}
    finally{db.exec('PRAGMA foreign_keys = ON')}
  }
  const receiptColumns=db.prepare('PRAGMA table_info(receipt_uploads)').all().map(column=>column.name);
  if(!receiptColumns.includes('linked_entity_type'))db.exec("ALTER TABLE receipt_uploads ADD COLUMN linked_entity_type TEXT CHECK(linked_entity_type IN ('order','wallet_topup'))");
  if(!receiptColumns.includes('linked_entity_id'))db.exec('ALTER TABLE receipt_uploads ADD COLUMN linked_entity_id TEXT');
  if(!receiptColumns.includes('linked_at'))db.exec('ALTER TABLE receipt_uploads ADD COLUMN linked_at TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_tracking_token ON orders(tracking_token)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_wallet_topups_account ON wallet_topups(account_id,created_at DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_receipt_uploads_account ON receipt_uploads(account_id,created_at DESC)');
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_receipt_uploads_linked_entity
    ON receipt_uploads(linked_entity_type,linked_entity_id)
    WHERE linked_entity_type IS NOT NULL AND linked_entity_id IS NOT NULL`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_receipt_uploads_orphans ON receipt_uploads(linked_entity_type,created_at)');
  // Upload metadata predates one-time receipt linking.  Preserve legitimate
  // historical capabilities by attaching each known upload to at most one
  // existing payment.  Files without metadata intentionally remain denied.
  const receiptFilename=value=>{
    if(typeof value!=='string'||value.length>600)return null;
    try{return new URL(value,'http://localhost').pathname.match(/^\/receipts\/([a-f0-9-]+\.(?:jpg|jpeg|png|webp))$/i)?.[1]||null}catch{return null}
  };
  const legacyReceiptLinks=[
    ...db.prepare(`SELECT id,account_id,receipt_image_url,created_at,'wallet_topup' entity_type FROM wallet_topups WHERE receipt_image_url IS NOT NULL`).all(),
    ...db.prepare(`SELECT id,NULL account_id,receipt_image_url,created_at,'order' entity_type FROM orders WHERE receipt_image_url IS NOT NULL`).all()
  ].sort((left,right)=>String(left.created_at).localeCompare(String(right.created_at)));
  const findReceiptUpload=db.prepare('SELECT account_id,linked_entity_type,linked_entity_id FROM receipt_uploads WHERE filename=?');
  const linkLegacyReceipt=db.prepare(`UPDATE receipt_uploads SET linked_entity_type=?,linked_entity_id=?,linked_at=?
    WHERE filename=? AND linked_entity_type IS NULL AND linked_entity_id IS NULL`);
  for(const entity of legacyReceiptLinks){
    const filename=receiptFilename(entity.receipt_image_url);if(!filename)continue;
    const upload=findReceiptUpload.get(filename);if(!upload||upload.linked_entity_type||upload.linked_entity_id)continue;
    if(entity.entity_type==='wallet_topup'?upload.account_id!==entity.account_id:upload.account_id!==null)continue;
    linkLegacyReceipt.run(entity.entity_type,entity.id,entity.created_at||new Date().toISOString(),filename);
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_tickets_account ON support_tickets(account_id,updated_at DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_notifications_account ON notifications(account_id,created_at DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_account_devices_account ON account_devices(account_id,status,last_seen_at DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_password_resets_status ON password_reset_requests(status,requested_at DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_device_recovery_status ON device_recovery_requests(status,requested_at DESC)');
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_device_recovery_pending_device ON device_recovery_requests(account_id,requested_device_hash) WHERE status='pending'");
  db.exec('CREATE INDEX IF NOT EXISTS idx_password_reset_codes_account ON password_reset_codes(account_id,created_at DESC)');
  // A customer can buy from more than one reseller.  Keep one private address-
  // book row per reseller instead of globally locking the account to its creator.
  db.exec('DROP INDEX IF EXISTS idx_reseller_customers_account');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_reseller_customers_account_owner ON reseller_customers(reseller_id,account_id) WHERE account_id IS NOT NULL');
  db.exec(`CREATE TABLE IF NOT EXISTS telegram_recovery_sessions (chat_id TEXT PRIMARY KEY,account_id TEXT REFERENCES accounts(id),verified_phone TEXT,state TEXT NOT NULL DEFAULT 'waiting_contact',expires_at TEXT NOT NULL,created_at TEXT NOT NULL)`);
  db.exec(`CREATE TABLE IF NOT EXISTS reseller_debts (
    id TEXT PRIMARY KEY,
    reseller_id TEXT NOT NULL REFERENCES accounts(id),
    customer_account_id TEXT NOT NULL REFERENCES accounts(id),
    amount_toman INTEGER NOT NULL CHECK(amount_toman > 0),
    note TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','payment_reported','settled','cancelled')),
    created_at TEXT NOT NULL,
    payment_reported_at TEXT,
    settled_at TEXT,
    settled_by TEXT,
    updated_at TEXT NOT NULL
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS reseller_wallet_transfers (
    id TEXT PRIMARY KEY,
    reseller_id TEXT NOT NULL REFERENCES accounts(id),
    customer_account_id TEXT NOT NULL REFERENCES accounts(id),
    amount_toman INTEGER NOT NULL CHECK(amount_toman > 0),
    reversed_amount_toman INTEGER NOT NULL DEFAULT 0 CHECK(reversed_amount_toman >= 0 AND reversed_amount_toman <= amount_toman),
    note TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','partially_reversed','reversed')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_reseller_debts_customer ON reseller_debts(customer_account_id,status,created_at DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_reseller_debts_reseller ON reseller_debts(reseller_id,status,created_at DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_reseller_wallet_transfers_owner ON reseller_wallet_transfers(reseller_id,customer_account_id,created_at DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_reseller_customers_owner ON reseller_customers(reseller_id,status,updated_at DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_location_endpoints_location ON location_endpoints(location_id,active,priority)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_service_locations_node ON service_locations(panel_node_id)');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_access_token ON subscriptions(access_token) WHERE access_token IS NOT NULL');
  db.exec('CREATE INDEX IF NOT EXISTS idx_hysteria_nodes_location ON hysteria_nodes(location_id,active)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_hysteria_tickets_subscription ON hysteria_tickets(subscription_id,node_id,expires_at)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_hysteria_tickets_account ON hysteria_tickets(account_id,expires_at)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_hysteria_tickets_client ON hysteria_tickets(node_id,client_id,created_at)');
  // Import the previous singleton binding without deleting it. The legacy
  // columns remain a compatibility shadow for one release and are updated by
  // the new device service.
  const legacyDevices = db.prepare(`SELECT id,device_binding_hash,COALESCE(device_bound_at,updated_at,created_at) bound_at
    FROM accounts WHERE role='customer' AND device_binding_hash IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM account_devices d WHERE d.account_id=accounts.id AND d.device_hash=accounts.device_binding_hash)`).all();
  const importLegacyDevice = db.prepare(`INSERT OR IGNORE INTO account_devices(id,account_id,device_hash,label,platform,status,first_seen_at,last_seen_at)
    VALUES(?,?,?,'دستگاه قدیمی','','active',?,?)`);
  for (const account of legacyDevices) importLegacyDevice.run(randomUUID(),account.id,account.device_binding_hash,account.bound_at,account.bound_at);
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
      destination_card_last4 TEXT,
      bank TEXT NOT NULL DEFAULT '',
      direction TEXT NOT NULL DEFAULT 'credit' CHECK(direction IN ('credit','debit','unknown')),
      raw_message TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'sms',
      status TEXT NOT NULL DEFAULT 'unmatched' CHECK(status IN ('unmatched','matched','ignored')),
      matched_order_id TEXT REFERENCES orders(id),
      matched_topup_id TEXT REFERENCES wallet_topups(id),
      provider_event_id TEXT,
      provider_message_id TEXT,
      destination TEXT,
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
  const bankTransactionColumns = db.prepare('PRAGMA table_info(bank_transactions)').all().map(c => c.name);
  if (!bankTransactionColumns.includes('destination_card_last4')) db.exec('ALTER TABLE bank_transactions ADD COLUMN destination_card_last4 TEXT');
  if (!bankTransactionColumns.includes('matched_topup_id')) db.exec('ALTER TABLE bank_transactions ADD COLUMN matched_topup_id TEXT REFERENCES wallet_topups(id)');
  if (!bankTransactionColumns.includes('provider_event_id')) db.exec('ALTER TABLE bank_transactions ADD COLUMN provider_event_id TEXT');
  if (!bankTransactionColumns.includes('provider_message_id')) db.exec('ALTER TABLE bank_transactions ADD COLUMN provider_message_id TEXT');
  if (!bankTransactionColumns.includes('destination')) db.exec('ALTER TABLE bank_transactions ADD COLUMN destination TEXT');
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_bank_tx_provider_event
      ON bank_transactions(source,provider_event_id) WHERE provider_event_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_bank_tx_provider_message
      ON bank_transactions(source,provider_message_id) WHERE provider_message_id IS NOT NULL;
    CREATE TABLE IF NOT EXISTS wallet_topup_reviews (
      id TEXT PRIMARY KEY,
      topup_id TEXT NOT NULL REFERENCES wallet_topups(id),
      decision TEXT NOT NULL CHECK(decision IN ('approved','rejected','manual')),
      confidence INTEGER NOT NULL DEFAULT 0,
      reason TEXT NOT NULL DEFAULT '',
      matched_bank_tx_id TEXT REFERENCES bank_transactions(id),
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_wallet_topup_reviews_topup
      ON wallet_topup_reviews(topup_id,created_at DESC);
  `);
  const redactLegacyBankMessage=db.prepare('UPDATE bank_transactions SET raw_message=? WHERE id=?');
  let redactedLegacyMessages=0;
  for(const row of db.prepare('SELECT id,raw_message,direction,bank,amount_rial,tracking_code,card_last4 FROM bank_transactions').all()){
    let alreadyRedacted=false;
    try{alreadyRedacted=JSON.parse(row.raw_message)?.redacted===true}catch{}
    if(!alreadyRedacted){redactLegacyBankMessage.run(JSON.stringify({redacted:true,legacy:true,direction:row.direction,bank:row.bank,amountRial:row.amount_rial||0,trackingSuffix:row.tracking_code?String(row.tracking_code).slice(-4):null,cardLast4:row.card_last4||null}),row.id);redactedLegacyMessages++}
  }
  // secure_delete scrubs database pages; truncate the WAL after one-time
  // plaintext redaction so old messages are not retained in that sidecar.
  if(redactedLegacyMessages&&filename!==':memory:')try{db.exec('PRAGMA wal_checkpoint(TRUNCATE)')}catch{}
  return db;
}

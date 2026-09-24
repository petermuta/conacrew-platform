import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// DATA_DIR lets a host (e.g. Render, with a persistent Disk mounted outside the
// deployed code folder) point the database somewhere that survives redeploys.
// Local runs default to server/data, same as before.
const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(dataDir, { recursive: true });
const dbPath = path.join(dataDir, 'conacrew.db');

export const db = new DatabaseSync(dbPath);
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','dispatcher','sugarcane_manager','passion_fruit_manager','driver')),
  operation_id INTEGER, -- for sugarcane_manager: which operation they run; for driver: not used
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sugarcane_operations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS passion_fruit_blocks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS fleet_trucks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plate_no TEXT NOT NULL UNIQUE,
  driver_id INTEGER REFERENCES users(id),
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS fleet_loads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  truck_id INTEGER REFERENCES fleet_trucks(id),
  driver_id INTEGER REFERENCES users(id),
  created_by INTEGER REFERENCES users(id),
  self_sourced INTEGER NOT NULL DEFAULT 0,
  origin TEXT,
  destination TEXT,
  cargo TEXT,
  rate REAL,
  status TEXT NOT NULL DEFAULT 'assigned' CHECK (status IN ('assigned','in_transit','delivered','cancelled')),
  load_date TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS fleet_load_costs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  load_id INTEGER NOT NULL REFERENCES fleet_loads(id),
  category TEXT NOT NULL,
  amount REAL NOT NULL,
  note TEXT,
  cost_date TEXT NOT NULL DEFAULT (datetime('now')),
  created_by INTEGER REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS fleet_issues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  driver_id INTEGER NOT NULL REFERENCES users(id),
  truck_id INTEGER REFERENCES fleet_trucks(id),
  kind TEXT NOT NULL CHECK (kind IN ('text','voice')),
  message TEXT,
  voice_path TEXT,
  voice_seconds REAL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT,
  resolved_by INTEGER REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS maintenance_schedules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  truck_id INTEGER NOT NULL REFERENCES fleet_trucks(id),
  service_name TEXT NOT NULL,
  interval_km REAL,
  interval_days INTEGER,
  last_service_km REAL,
  last_service_date TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS maintenance_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  truck_id INTEGER NOT NULL REFERENCES fleet_trucks(id),
  schedule_id INTEGER REFERENCES maintenance_schedules(id),
  service_name TEXT NOT NULL,
  odometer_km REAL,
  cost REAL,
  performed_by TEXT,
  notes TEXT,
  service_date TEXT NOT NULL DEFAULT (datetime('now')),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS vehicle_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  truck_id INTEGER NOT NULL REFERENCES fleet_trucks(id),
  doc_type TEXT NOT NULL CHECK (doc_type IN ('insurance','road_license','inspection','other')),
  doc_number TEXT,
  issued_date TEXT,
  expiry_date TEXT,
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS fuel_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  truck_id INTEGER NOT NULL REFERENCES fleet_trucks(id),
  driver_id INTEGER REFERENCES users(id),
  odometer_km REAL,
  liters REAL,
  amount REAL NOT NULL,
  station TEXT,
  fuel_date TEXT NOT NULL DEFAULT (datetime('now')),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS expense_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  submitted_by INTEGER NOT NULL REFERENCES users(id),
  venture TEXT NOT NULL DEFAULT 'fleet',
  category TEXT NOT NULL,
  amount REAL NOT NULL,
  description TEXT,
  truck_id INTEGER REFERENCES fleet_trucks(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','declined','settled')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  decided_by INTEGER REFERENCES users(id),
  decided_at TEXT,
  settled_at TEXT
);

CREATE TABLE IF NOT EXISTS sugarcane_deals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_id INTEGER NOT NULL REFERENCES sugarcane_operations(id),
  deal_type TEXT NOT NULL CHECK (deal_type IN ('acreage','trips')),
  farmer_name TEXT NOT NULL,
  location TEXT,
  acreage_size REAL,
  estimated_trips INTEGER,
  rate REAL NOT NULL,
  deal_date TEXT NOT NULL DEFAULT (datetime('now')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  notes TEXT,
  created_by INTEGER REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS sugarcane_deal_costs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  deal_id INTEGER NOT NULL REFERENCES sugarcane_deals(id),
  category TEXT NOT NULL CHECK (category IN ('truck','fuel','driver','loaders','cutters','farmer_payment','other')),
  amount REAL NOT NULL,
  note TEXT,
  cost_date TEXT NOT NULL DEFAULT (datetime('now')),
  created_by INTEGER REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS sugarcane_sales (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_id INTEGER NOT NULL REFERENCES sugarcane_operations(id),
  deal_id INTEGER REFERENCES sugarcane_deals(id),
  tonnage REAL NOT NULL,
  rate_per_ton REAL NOT NULL,
  buyer TEXT,
  sale_date TEXT NOT NULL DEFAULT (datetime('now')),
  created_by INTEGER REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS passion_fruit_harvests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  block_id INTEGER NOT NULL REFERENCES passion_fruit_blocks(id),
  kg REAL NOT NULL,
  harvest_date TEXT NOT NULL DEFAULT (datetime('now')),
  notes TEXT,
  created_by INTEGER REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS passion_fruit_sales (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kg REAL NOT NULL,
  rate_per_kg REAL NOT NULL,
  buyer TEXT,
  sale_date TEXT NOT NULL DEFAULT (datetime('now')),
  created_by INTEGER REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS passion_fruit_activities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  block_id INTEGER REFERENCES passion_fruit_blocks(id),
  activity_type TEXT NOT NULL CHECK (activity_type IN ('planting','weeding','pruning','spraying','fertilizer_purchase','pesticide_purchase','other')),
  volume REAL,
  unit TEXT,
  cost REAL,
  activity_date TEXT NOT NULL DEFAULT (datetime('now')),
  notes TEXT,
  created_by INTEGER REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  venture TEXT NOT NULL,
  operation_id INTEGER,
  ref_table TEXT,
  ref_id INTEGER,
  file_name TEXT NOT NULL,
  file_path TEXT NOT NULL,
  mime_type TEXT,
  uploaded_by INTEGER REFERENCES users(id),
  uploaded_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ledger_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  venture TEXT NOT NULL CHECK (venture IN ('fleet','sugarcane','passion_fruit','overhead')),
  operation_id INTEGER,
  entry_type TEXT NOT NULL CHECK (entry_type IN ('revenue','expense')),
  category TEXT NOT NULL,
  amount REAL NOT NULL,
  entry_date TEXT NOT NULL DEFAULT (datetime('now')),
  source_table TEXT,
  source_id INTEGER,
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS locations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_locations_user_time ON locations(user_id, recorded_at);
CREATE INDEX IF NOT EXISTS idx_ledger_venture ON ledger_transactions(venture, entry_date);
CREATE INDEX IF NOT EXISTS idx_maint_schedules_truck ON maintenance_schedules(truck_id);
CREATE INDEX IF NOT EXISTS idx_maint_logs_truck ON maintenance_logs(truck_id, service_date);
CREATE INDEX IF NOT EXISTS idx_vehicle_docs_truck ON vehicle_documents(truck_id, doc_type);
CREATE INDEX IF NOT EXISTS idx_fuel_logs_truck ON fuel_logs(truck_id, fuel_date);
`);

// Migrations for columns added after the initial release. Safe to re-run:
// each ALTER is wrapped so an "already exists" error is silently ignored.
for (const stmt of [
  "ALTER TABLE fleet_trucks ADD COLUMN make TEXT DEFAULT 'Sinotruk'",
  "ALTER TABLE fleet_trucks ADD COLUMN model TEXT DEFAULT 'HOWO'",
  "ALTER TABLE fleet_trucks ADD COLUMN current_km REAL DEFAULT 0",
]) {
  try { db.exec(stmt); } catch (e) { /* column already exists */ }
}

export function postLedgerEntry({ venture, operation_id = null, entry_type, category, amount, entry_date, source_table = null, source_id = null, notes = null, created_by }) {
  const stmt = db.prepare(`INSERT INTO ledger_transactions
    (venture, operation_id, entry_type, category, amount, entry_date, source_table, source_id, notes, created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);
  stmt.run(venture, operation_id, entry_type, category, amount, entry_date || new Date().toISOString(), source_table, source_id, notes, created_by ?? null);
}

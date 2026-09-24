import fs from 'node:fs';
import { db, postLedgerEntry } from '../db.js';
import { sendJson, sendError } from '../util.js';
import { requireAuth, requireRole, ROLES } from '../context.js';
import { saveBase64File } from '../files.js';

const CAN_SEE_ALL_FLEET = [ROLES.ADMIN, ROLES.DISPATCHER];

// Typical factory service intervals for a Sinotruk HOWO. Applied to every new
// truck as a starting point; each item can be edited or deactivated per truck afterward.
const DEFAULT_SINOTRUK_SCHEDULE = [
  { service_name: 'Engine oil & filter change', interval_km: 10000, interval_days: 90 },
  { service_name: 'Air filter', interval_km: 20000, interval_days: 180 },
  { service_name: 'Fuel filter', interval_km: 20000, interval_days: 180 },
  { service_name: 'Tire rotation & pressure check', interval_km: 10000, interval_days: 60 },
  { service_name: 'Brake inspection', interval_km: 20000, interval_days: 90 },
  { service_name: 'Transmission oil change', interval_km: 60000, interval_days: 365 },
  { service_name: 'Differential/axle oil change', interval_km: 60000, interval_days: 365 },
  { service_name: 'Full/major service', interval_km: 40000, interval_days: 365 },
  { service_name: 'Coolant system check', interval_km: 40000, interval_days: 365 },
  { service_name: 'Battery & electrical check', interval_km: 20000, interval_days: 180 },
];

function seedDefaultSchedule(truckId, startKm) {
  const today = new Date().toISOString().slice(0, 10);
  const stmt = db.prepare(`INSERT INTO maintenance_schedules
    (truck_id, service_name, interval_km, interval_days, last_service_km, last_service_date)
    VALUES (?,?,?,?,?,?)`);
  for (const item of DEFAULT_SINOTRUK_SCHEDULE) {
    stmt.run(truckId, item.service_name, item.interval_km, item.interval_days, startKm || 0, today);
  }
}

// Computes a due status from an interval + last-done point, whichever (km or date) comes first.
function computeDueStatus(currentKm, sched) {
  let dueKm = null, dueDate = null, kmRemaining = null, daysRemaining = null;
  if (sched.interval_km && sched.last_service_km != null) {
    dueKm = sched.last_service_km + sched.interval_km;
    kmRemaining = dueKm - (currentKm || 0);
  }
  if (sched.interval_days && sched.last_service_date) {
    const due = new Date(sched.last_service_date);
    due.setDate(due.getDate() + sched.interval_days);
    dueDate = due.toISOString().slice(0, 10);
    daysRemaining = Math.round((due.getTime() - Date.now()) / 86400000);
  }
  const overdue = (kmRemaining !== null && kmRemaining <= 0) || (daysRemaining !== null && daysRemaining <= 0);
  const dueSoon = (kmRemaining !== null && kmRemaining <= 1000) || (daysRemaining !== null && daysRemaining <= 14);
  const status = overdue ? 'overdue' : (dueSoon ? 'due_soon' : 'ok');
  return { due_km: dueKm, due_date: dueDate, km_remaining: kmRemaining, days_remaining: daysRemaining, status };
}

export function registerFleetRoutes(router) {
  // ---- Trucks ----
  router.get('/api/fleet/trucks', async (req, res) => {
    const user = requireAuth(req, res, sendError);
    if (!user) return;
    const trucks = db.prepare(`SELECT t.id, t.plate_no, t.active, t.driver_id, t.make, t.model, t.current_km, u.name as driver_name
      FROM fleet_trucks t LEFT JOIN users u ON u.id = t.driver_id ORDER BY t.plate_no`).all();
    sendJson(res, 200, { trucks });
  });

  router.post('/api/fleet/trucks', async (req, res, params, body) => {
    const user = requireAuth(req, res, sendError);
    if (!user) return;
    if (!requireRole(user, CAN_SEE_ALL_FLEET, res, sendError)) return;
    const { plate_no, driver_id, make, model, current_km } = body || {};
    if (!plate_no) return sendError(res, 400, 'plate_no is required');
    try {
      const info = db.prepare('INSERT INTO fleet_trucks (plate_no, driver_id, make, model, current_km) VALUES (?,?,?,?,?)')
        .run(plate_no, driver_id || null, make || 'Sinotruk', model || 'HOWO', current_km || 0);
      seedDefaultSchedule(info.lastInsertRowid, current_km || 0);
      sendJson(res, 201, { id: info.lastInsertRowid });
    } catch (e) {
      sendError(res, 400, e.message.includes('UNIQUE') ? 'Plate number already exists' : e.message);
    }
  });

  router.patch('/api/fleet/trucks/:id', async (req, res, params, body) => {
    const user = requireAuth(req, res, sendError);
    if (!user) return;
    if (!requireRole(user, CAN_SEE_ALL_FLEET, res, sendError)) return;
    const truck = db.prepare('SELECT * FROM fleet_trucks WHERE id = ?').get(params.id);
    if (!truck) return sendError(res, 404, 'Truck not found');
    const fields = [];
    const values = [];
    if (body.plate_no !== undefined) { fields.push('plate_no = ?'); values.push(body.plate_no); }
    if (body.driver_id !== undefined) { fields.push('driver_id = ?'); values.push(body.driver_id || null); }
    if (body.make !== undefined) { fields.push('make = ?'); values.push(body.make); }
    if (body.model !== undefined) { fields.push('model = ?'); values.push(body.model); }
    if (body.current_km !== undefined) { fields.push('current_km = ?'); values.push(Number(body.current_km)); }
    if (typeof body.active === 'boolean') { fields.push('active = ?'); values.push(body.active ? 1 : 0); }
    if (!fields.length) return sendError(res, 400, 'Nothing to update');
    values.push(params.id);
    db.prepare(`UPDATE fleet_trucks SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    sendJson(res, 200, { ok: true });
  });

  // ---- Loads ----
  router.get('/api/fleet/loads', async (req, res) => {
    const user = requireAuth(req, res, sendError);
    if (!user) return;
    let rows;
    if (CAN_SEE_ALL_FLEET.includes(user.role)) {
      rows = db.prepare(`SELECT l.*, u.name as driver_name, t.plate_no
        FROM fleet_loads l LEFT JOIN users u ON u.id = l.driver_id
        LEFT JOIN fleet_trucks t ON t.id = l.truck_id
        ORDER BY l.created_at DESC`).all();
    } else if (user.role === ROLES.DRIVER) {
      rows = db.prepare(`SELECT l.*, u.name as driver_name, t.plate_no
        FROM fleet_loads l LEFT JOIN users u ON u.id = l.driver_id
        LEFT JOIN fleet_trucks t ON t.id = l.truck_id
        WHERE l.driver_id = ? ORDER BY l.created_at DESC`).all(user.id);
    } else {
      return sendError(res, 403, 'Not permitted');
    }
    sendJson(res, 200, { loads: rows });
  });

  router.post('/api/fleet/loads', async (req, res, params, body) => {
    const user = requireAuth(req, res, sendError);
    if (!user) return;
    if (!CAN_SEE_ALL_FLEET.includes(user.role) && user.role !== ROLES.DRIVER) {
      return sendError(res, 403, 'Not permitted');
    }
    const { truck_id, driver_id, origin, destination, cargo, rate, load_date, notes } = body || {};
    let finalDriverId = driver_id;
    let selfSourced = 0;
    let createdBy = user.id;
    if (user.role === ROLES.DRIVER) {
      finalDriverId = user.id; // drivers can only create their own loads
      selfSourced = 1;
    }
    if (!finalDriverId) return sendError(res, 400, 'driver_id is required');
    if (!origin || !destination) return sendError(res, 400, 'origin and destination are required');
    const info = db.prepare(`INSERT INTO fleet_loads
      (truck_id, driver_id, created_by, self_sourced, origin, destination, cargo, rate, load_date, notes)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
      truck_id || null, finalDriverId, createdBy, selfSourced, origin, destination, cargo || null,
      rate ?? null, load_date || new Date().toISOString(), notes || null
    );
    if (rate) {
      postLedgerEntry({
        venture: 'fleet', entry_type: 'revenue', category: selfSourced ? 'self_sourced_load' : 'dispatched_load',
        amount: rate, entry_date: load_date || new Date().toISOString(),
        source_table: 'fleet_loads', source_id: info.lastInsertRowid, created_by: user.id,
        notes: `${origin} -> ${destination}`,
      });
    }
    sendJson(res, 201, { id: info.lastInsertRowid });
  });

  router.patch('/api/fleet/loads/:id', async (req, res, params, body) => {
    const user = requireAuth(req, res, sendError);
    if (!user) return;
    const load = db.prepare('SELECT * FROM fleet_loads WHERE id = ?').get(params.id);
    if (!load) return sendError(res, 404, 'Load not found');
    const isOwnerDriver = user.role === ROLES.DRIVER && load.driver_id === user.id;
    if (!CAN_SEE_ALL_FLEET.includes(user.role) && !isOwnerDriver) return sendError(res, 403, 'Not permitted');
    const fields = [];
    const values = [];
    if (body.status) { fields.push('status = ?'); values.push(body.status); }
    if (body.truck_id !== undefined && !isOwnerDriver) { fields.push('truck_id = ?'); values.push(body.truck_id); }
    if (body.notes !== undefined) { fields.push('notes = ?'); values.push(body.notes); }
    if (!fields.length) return sendError(res, 400, 'Nothing to update');
    values.push(params.id);
    db.prepare(`UPDATE fleet_loads SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    sendJson(res, 200, { ok: true });
  });

  // ---- Load costs (dispatch/admin only) ----
  router.post('/api/fleet/loads/:id/costs', async (req, res, params, body) => {
    const user = requireAuth(req, res, sendError);
    if (!user) return;
    if (!requireRole(user, CAN_SEE_ALL_FLEET, res, sendError)) return;
    const load = db.prepare('SELECT * FROM fleet_loads WHERE id = ?').get(params.id);
    if (!load) return sendError(res, 404, 'Load not found');
    const { category, amount, note, cost_date } = body || {};
    if (!category || !amount) return sendError(res, 400, 'category and amount are required');
    const info = db.prepare(`INSERT INTO fleet_load_costs (load_id, category, amount, note, cost_date, created_by)
      VALUES (?,?,?,?,?,?)`).run(params.id, category, amount, note || null, cost_date || new Date().toISOString(), user.id);
    postLedgerEntry({
      venture: 'fleet', entry_type: 'expense', category, amount,
      entry_date: cost_date || new Date().toISOString(), source_table: 'fleet_load_costs',
      source_id: info.lastInsertRowid, created_by: user.id, notes: note || `Load #${params.id}`,
    });
    sendJson(res, 201, { id: info.lastInsertRowid });
  });

  router.get('/api/fleet/loads/:id/costs', async (req, res, params) => {
    const user = requireAuth(req, res, sendError);
    if (!user) return;
    if (!requireRole(user, CAN_SEE_ALL_FLEET, res, sendError)) return;
    const costs = db.prepare('SELECT * FROM fleet_load_costs WHERE load_id = ? ORDER BY cost_date DESC').all(params.id);
    sendJson(res, 200, { costs });
  });

  // ---- Issue reports (text or voice note <=3min) ----
  router.get('/api/fleet/issues', async (req, res) => {
    const user = requireAuth(req, res, sendError);
    if (!user) return;
    let rows;
    if (CAN_SEE_ALL_FLEET.includes(user.role)) {
      rows = db.prepare(`SELECT i.*, u.name as driver_name, t.plate_no FROM fleet_issues i
        LEFT JOIN users u ON u.id = i.driver_id LEFT JOIN fleet_trucks t ON t.id = i.truck_id
        ORDER BY i.created_at DESC`).all();
    } else if (user.role === ROLES.DRIVER) {
      rows = db.prepare(`SELECT i.*, u.name as driver_name, t.plate_no FROM fleet_issues i
        LEFT JOIN users u ON u.id = i.driver_id LEFT JOIN fleet_trucks t ON t.id = i.truck_id
        WHERE i.driver_id = ? ORDER BY i.created_at DESC`).all(user.id);
    } else {
      return sendError(res, 403, 'Not permitted');
    }
    sendJson(res, 200, { issues: rows });
  });

  router.post('/api/fleet/issues', async (req, res, params, body) => {
    const user = requireAuth(req, res, sendError);
    if (!user) return;
    if (!requireRole(user, [ROLES.DRIVER], res, sendError)) return;
    const { kind, message, truck_id, voice_base64, voice_seconds, mime_type } = body || {};
    if (kind === 'text') {
      if (!message || !message.trim()) return sendError(res, 400, 'message is required for a text issue');
      const info = db.prepare(`INSERT INTO fleet_issues (driver_id, truck_id, kind, message) VALUES (?,?,?,?)`)
        .run(user.id, truck_id || null, 'text', message.trim());
      return sendJson(res, 201, { id: info.lastInsertRowid });
    } else if (kind === 'voice') {
      if (!voice_base64) return sendError(res, 400, 'voice_base64 is required for a voice issue');
      if (voice_seconds && voice_seconds > 180) return sendError(res, 400, 'Voice note must be under 3 minutes');
      const filePath = saveBase64File('voice', voice_base64, mime_type || 'audio/webm');
      const info = db.prepare(`INSERT INTO fleet_issues (driver_id, truck_id, kind, voice_path, voice_seconds) VALUES (?,?,?,?,?)`)
        .run(user.id, truck_id || null, 'voice', filePath, voice_seconds || null);
      return sendJson(res, 201, { id: info.lastInsertRowid });
    }
    sendError(res, 400, "kind must be 'text' or 'voice'");
  });

  router.patch('/api/fleet/issues/:id', async (req, res, params, body) => {
    const user = requireAuth(req, res, sendError);
    if (!user) return;
    if (!requireRole(user, CAN_SEE_ALL_FLEET, res, sendError)) return;
    if (body.status !== 'resolved' && body.status !== 'open') return sendError(res, 400, 'Invalid status');
    db.prepare(`UPDATE fleet_issues SET status = ?, resolved_at = CASE WHEN ? = 'resolved' THEN datetime('now') ELSE NULL END, resolved_by = ? WHERE id = ?`)
      .run(body.status, body.status, user.id, params.id);
    sendJson(res, 200, { ok: true });
  });

  router.get('/api/fleet/issues/:id/voice', async (req, res, params) => {
    const user = requireAuth(req, res, sendError);
    if (!user) return;
    const issue = db.prepare('SELECT * FROM fleet_issues WHERE id = ?').get(params.id);
    if (!issue || !issue.voice_path) return sendError(res, 404, 'Not found');
    const isOwner = user.role === ROLES.DRIVER && issue.driver_id === user.id;
    if (!CAN_SEE_ALL_FLEET.includes(user.role) && !isOwner) return sendError(res, 403, 'Not permitted');
    res.writeHead(200, { 'Content-Type': 'audio/webm', 'Access-Control-Allow-Origin': '*' });
    res.end(fs.readFileSync(issue.voice_path));
  });

  // ---- Maintenance schedules (per-truck service items, e.g. oil change every 10,000km) ----
  router.get('/api/fleet/maintenance/schedules', async (req, res, params, body, query) => {
    const user = requireAuth(req, res, sendError);
    if (!user) return;
    if (!requireRole(user, CAN_SEE_ALL_FLEET, res, sendError)) return;
    let sql = `SELECT s.*, t.plate_no, t.current_km FROM maintenance_schedules s
      JOIN fleet_trucks t ON t.id = s.truck_id WHERE s.active = 1`;
    const args = [];
    if (query.truck_id) { sql += ' AND s.truck_id = ?'; args.push(query.truck_id); }
    sql += ' ORDER BY t.plate_no, s.service_name';
    const rows = db.prepare(sql).all(...args);
    const schedules = rows.map((s) => ({ ...s, ...computeDueStatus(s.current_km, s) }));
    sendJson(res, 200, { schedules });
  });

  router.post('/api/fleet/maintenance/schedules', async (req, res, params, body) => {
    const user = requireAuth(req, res, sendError);
    if (!user) return;
    if (!requireRole(user, CAN_SEE_ALL_FLEET, res, sendError)) return;
    const { truck_id, service_name, interval_km, interval_days } = body || {};
    if (!truck_id || !service_name) return sendError(res, 400, 'truck_id and service_name are required');
    if (!interval_km && !interval_days) return sendError(res, 400, 'Set an interval in km, days, or both');
    const truck = db.prepare('SELECT * FROM fleet_trucks WHERE id = ?').get(truck_id);
    if (!truck) return sendError(res, 404, 'Truck not found');
    const today = new Date().toISOString().slice(0, 10);
    const info = db.prepare(`INSERT INTO maintenance_schedules
      (truck_id, service_name, interval_km, interval_days, last_service_km, last_service_date)
      VALUES (?,?,?,?,?,?)`).run(truck_id, service_name, interval_km || null, interval_days || null, truck.current_km || 0, today);
    sendJson(res, 201, { id: info.lastInsertRowid });
  });

  router.patch('/api/fleet/maintenance/schedules/:id', async (req, res, params, body) => {
    const user = requireAuth(req, res, sendError);
    if (!user) return;
    if (!requireRole(user, CAN_SEE_ALL_FLEET, res, sendError)) return;
    const sched = db.prepare('SELECT * FROM maintenance_schedules WHERE id = ?').get(params.id);
    if (!sched) return sendError(res, 404, 'Not found');
    const fields = [];
    const values = [];
    if (body.interval_km !== undefined) { fields.push('interval_km = ?'); values.push(body.interval_km || null); }
    if (body.interval_days !== undefined) { fields.push('interval_days = ?'); values.push(body.interval_days || null); }
    if (typeof body.active === 'boolean') { fields.push('active = ?'); values.push(body.active ? 1 : 0); }
    if (!fields.length) return sendError(res, 400, 'Nothing to update');
    values.push(params.id);
    db.prepare(`UPDATE maintenance_schedules SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    sendJson(res, 200, { ok: true });
  });

  // ---- Maintenance logs (service history; also bumps the schedule + truck odometer + ledger) ----
  router.get('/api/fleet/maintenance/logs', async (req, res, params, body, query) => {
    const user = requireAuth(req, res, sendError);
    if (!user) return;
    if (!requireRole(user, CAN_SEE_ALL_FLEET, res, sendError)) return;
    let sql = `SELECT l.*, t.plate_no, u.name as logged_by_name FROM maintenance_logs l
      JOIN fleet_trucks t ON t.id = l.truck_id LEFT JOIN users u ON u.id = l.created_by WHERE 1=1`;
    const args = [];
    if (query.truck_id) { sql += ' AND l.truck_id = ?'; args.push(query.truck_id); }
    sql += ' ORDER BY l.service_date DESC';
    const logs = db.prepare(sql).all(...args);
    sendJson(res, 200, { logs });
  });

  router.post('/api/fleet/maintenance/logs', async (req, res, params, body) => {
    const user = requireAuth(req, res, sendError);
    if (!user) return;
    if (!requireRole(user, CAN_SEE_ALL_FLEET, res, sendError)) return;
    const { truck_id, schedule_id, service_name, odometer_km, cost, performed_by, notes, service_date } = body || {};
    if (!truck_id || !service_name) return sendError(res, 400, 'truck_id and service_name are required');
    const truck = db.prepare('SELECT * FROM fleet_trucks WHERE id = ?').get(truck_id);
    if (!truck) return sendError(res, 404, 'Truck not found');
    const date = service_date || new Date().toISOString().slice(0, 10);
    const info = db.prepare(`INSERT INTO maintenance_logs
      (truck_id, schedule_id, service_name, odometer_km, cost, performed_by, notes, service_date, created_by)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(
      truck_id, schedule_id || null, service_name, odometer_km ?? null, cost ?? null,
      performed_by || null, notes || null, date, user.id
    );
    if (odometer_km && odometer_km > (truck.current_km || 0)) {
      db.prepare('UPDATE fleet_trucks SET current_km = ? WHERE id = ?').run(odometer_km, truck_id);
    }
    if (schedule_id) {
      db.prepare(`UPDATE maintenance_schedules SET last_service_km = ?, last_service_date = ? WHERE id = ?`)
        .run(odometer_km || truck.current_km || 0, date, schedule_id);
    }
    if (cost) {
      postLedgerEntry({
        venture: 'fleet', entry_type: 'expense', category: 'maintenance', amount: cost,
        entry_date: date, source_table: 'maintenance_logs', source_id: info.lastInsertRowid,
        created_by: user.id, notes: `${service_name} - ${truck.plate_no}`,
      });
    }
    sendJson(res, 201, { id: info.lastInsertRowid });
  });

  // ---- Vehicle documents (insurance, road license, inspection - with expiry tracking) ----
  router.get('/api/fleet/vehicle-documents', async (req, res, params, body, query) => {
    const user = requireAuth(req, res, sendError);
    if (!user) return;
    if (!requireRole(user, CAN_SEE_ALL_FLEET, res, sendError)) return;
    let sql = `SELECT d.*, t.plate_no FROM vehicle_documents d JOIN fleet_trucks t ON t.id = d.truck_id WHERE 1=1`;
    const args = [];
    if (query.truck_id) { sql += ' AND d.truck_id = ?'; args.push(query.truck_id); }
    sql += ' ORDER BY d.expiry_date IS NULL, d.expiry_date DESC';
    const rows = db.prepare(sql).all(...args);
    const today = new Date().toISOString().slice(0, 10);
    const documents = rows.map((d) => {
      let status = 'valid';
      if (d.expiry_date) {
        const daysLeft = Math.round((new Date(d.expiry_date).getTime() - new Date(today).getTime()) / 86400000);
        status = daysLeft <= 0 ? 'expired' : (daysLeft <= 30 ? 'expiring_soon' : 'valid');
      }
      return { ...d, status };
    });
    sendJson(res, 200, { documents });
  });

  router.post('/api/fleet/vehicle-documents', async (req, res, params, body) => {
    const user = requireAuth(req, res, sendError);
    if (!user) return;
    if (!requireRole(user, CAN_SEE_ALL_FLEET, res, sendError)) return;
    const { truck_id, doc_type, doc_number, issued_date, expiry_date, notes, file_base64, file_name, mime_type } = body || {};
    if (!truck_id || !doc_type) return sendError(res, 400, 'truck_id and doc_type are required');
    const truck = db.prepare('SELECT * FROM fleet_trucks WHERE id = ?').get(truck_id);
    if (!truck) return sendError(res, 404, 'Truck not found');
    const info = db.prepare(`INSERT INTO vehicle_documents (truck_id, doc_type, doc_number, issued_date, expiry_date, notes, created_by)
      VALUES (?,?,?,?,?,?,?)`).run(truck_id, doc_type, doc_number || null, issued_date || null, expiry_date || null, notes || null, user.id);
    if (file_base64 && file_name) {
      const filePath = saveBase64File('documents', file_base64, mime_type || 'application/octet-stream');
      db.prepare(`INSERT INTO documents (venture, ref_table, ref_id, file_name, file_path, mime_type, uploaded_by)
        VALUES ('fleet','vehicle_documents',?,?,?,?,?)`).run(info.lastInsertRowid, file_name, filePath, mime_type || null, user.id);
    }
    sendJson(res, 201, { id: info.lastInsertRowid });
  });

  // ---- Fuel logs (fill-ups; tracks cost + bumps the truck's odometer) ----
  router.get('/api/fleet/fuel-logs', async (req, res, params, body, query) => {
    const user = requireAuth(req, res, sendError);
    if (!user) return;
    if (!requireRole(user, CAN_SEE_ALL_FLEET, res, sendError)) return;
    let sql = `SELECT f.*, t.plate_no, u.name as driver_name FROM fuel_logs f
      JOIN fleet_trucks t ON t.id = f.truck_id LEFT JOIN users u ON u.id = f.driver_id WHERE 1=1`;
    const args = [];
    if (query.truck_id) { sql += ' AND f.truck_id = ?'; args.push(query.truck_id); }
    sql += ' ORDER BY f.fuel_date DESC';
    const logs = db.prepare(sql).all(...args);
    sendJson(res, 200, { logs });
  });

  router.post('/api/fleet/fuel-logs', async (req, res, params, body) => {
    const user = requireAuth(req, res, sendError);
    if (!user) return;
    if (!requireRole(user, CAN_SEE_ALL_FLEET, res, sendError)) return;
    const { truck_id, driver_id, odometer_km, liters, amount, station, fuel_date } = body || {};
    if (!truck_id || !amount) return sendError(res, 400, 'truck_id and amount are required');
    const truck = db.prepare('SELECT * FROM fleet_trucks WHERE id = ?').get(truck_id);
    if (!truck) return sendError(res, 404, 'Truck not found');
    const date = fuel_date || new Date().toISOString().slice(0, 10);
    const info = db.prepare(`INSERT INTO fuel_logs (truck_id, driver_id, odometer_km, liters, amount, station, fuel_date, created_by)
      VALUES (?,?,?,?,?,?,?,?)`).run(truck_id, driver_id || truck.driver_id || null, odometer_km ?? null, liters ?? null, amount, station || null, date, user.id);
    if (odometer_km && odometer_km > (truck.current_km || 0)) {
      db.prepare('UPDATE fleet_trucks SET current_km = ? WHERE id = ?').run(odometer_km, truck_id);
    }
    postLedgerEntry({
      venture: 'fleet', entry_type: 'expense', category: 'fuel', amount,
      entry_date: date, source_table: 'fuel_logs', source_id: info.lastInsertRowid,
      created_by: user.id, notes: `Fuel - ${truck.plate_no}${station ? ' @ ' + station : ''}`,
    });
    sendJson(res, 201, { id: info.lastInsertRowid });
  });

  // ---- Expense requests (driver submits -> admin/dispatch accepts -> driver settles) ----
  router.get('/api/fleet/expense-requests', async (req, res) => {
    const user = requireAuth(req, res, sendError);
    if (!user) return;
    let rows;
    if (CAN_SEE_ALL_FLEET.includes(user.role)) {
      rows = db.prepare(`SELECT e.*, u.name as submitted_by_name, t.plate_no FROM expense_requests e
        LEFT JOIN users u ON u.id = e.submitted_by LEFT JOIN fleet_trucks t ON t.id = e.truck_id
        ORDER BY e.created_at DESC`).all();
    } else if (user.role === ROLES.DRIVER) {
      rows = db.prepare(`SELECT e.*, u.name as submitted_by_name, t.plate_no FROM expense_requests e
        LEFT JOIN users u ON u.id = e.submitted_by LEFT JOIN fleet_trucks t ON t.id = e.truck_id
        WHERE e.submitted_by = ? ORDER BY e.created_at DESC`).all(user.id);
    } else {
      return sendError(res, 403, 'Not permitted');
    }
    sendJson(res, 200, { requests: rows });
  });

  router.post('/api/fleet/expense-requests', async (req, res, params, body) => {
    const user = requireAuth(req, res, sendError);
    if (!user) return;
    if (!requireRole(user, [ROLES.DRIVER], res, sendError)) return;
    const { category, amount, description, truck_id } = body || {};
    if (!category || !amount) return sendError(res, 400, 'category and amount are required');
    const info = db.prepare(`INSERT INTO expense_requests (submitted_by, venture, category, amount, description, truck_id)
      VALUES (?, 'fleet', ?, ?, ?, ?)`).run(user.id, category, amount, description || null, truck_id || null);
    sendJson(res, 201, { id: info.lastInsertRowid });
  });

  router.patch('/api/fleet/expense-requests/:id', async (req, res, params, body) => {
    const user = requireAuth(req, res, sendError);
    if (!user) return;
    const reqRow = db.prepare('SELECT * FROM expense_requests WHERE id = ?').get(params.id);
    if (!reqRow) return sendError(res, 404, 'Not found');
    const { status } = body || {};
    if (['accepted', 'declined'].includes(status)) {
      if (!requireRole(user, CAN_SEE_ALL_FLEET, res, sendError)) return;
      if (reqRow.status !== 'pending') return sendError(res, 400, 'Only a pending request can be accepted/declined');
      db.prepare(`UPDATE expense_requests SET status = ?, decided_by = ?, decided_at = datetime('now') WHERE id = ?`)
        .run(status, user.id, params.id);
      return sendJson(res, 200, { ok: true });
    }
    if (status === 'settled') {
      const isOwnerDriver = user.role === ROLES.DRIVER && reqRow.submitted_by === user.id;
      if (!isOwnerDriver && !CAN_SEE_ALL_FLEET.includes(user.role)) return sendError(res, 403, 'Not permitted');
      if (reqRow.status !== 'accepted') return sendError(res, 400, 'Only an accepted request can be settled');
      db.prepare(`UPDATE expense_requests SET status = 'settled', settled_at = datetime('now') WHERE id = ?`).run(params.id);
      postLedgerEntry({
        venture: 'fleet', entry_type: 'expense', category: reqRow.category, amount: reqRow.amount,
        source_table: 'expense_requests', source_id: reqRow.id, created_by: user.id,
        notes: reqRow.description || `Expense request #${reqRow.id}`,
      });
      return sendJson(res, 200, { ok: true });
    }
    sendError(res, 400, 'Invalid status transition');
  });
}

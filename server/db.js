import { DatabaseSync } from "node:sqlite";
import bcrypt from "bcryptjs";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import { createMockPixCharge } from "./pixProvider.js";
import { computeRouteMetricsInCurrentOrder } from "./routeOptimizer.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, "data");
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const dbFile = process.env.DB_PATH || path.join(dataDir, "rotas.db");
const db = new DatabaseSync(dbFile);

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    full_name TEXT NOT NULL DEFAULT 'Gestor de Operacoes',
    role TEXT NOT NULL DEFAULT 'admin'
  );
  CREATE TABLE IF NOT EXISTS couriers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    phone TEXT NOT NULL,
    vehicle_type TEXT NOT NULL CHECK (vehicle_type IN ('motorcycle', 'utility_van', 'cargo_bike')),
    vehicle_plate TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'on_route', 'offline')),
    current_lat REAL NOT NULL DEFAULT -22.3145,
    current_lng REAL NOT NULL DEFAULT -49.0606,
    last_ping_at TEXT NOT NULL DEFAULT (datetime('now')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS delivery_routes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    route_code TEXT UNIQUE NOT NULL,
    title TEXT NOT NULL,
    courier_id INTEGER NOT NULL REFERENCES couriers(id),
    origin_name TEXT NOT NULL DEFAULT 'CD Central Bauru — Av. Rodrigues Alves, 1200',
    origin_lat REAL NOT NULL DEFAULT -22.3145,
    origin_lng REAL NOT NULL DEFAULT -49.0606,
    status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'in_progress', 'completed', 'cancelled')),
    original_distance_km REAL NOT NULL DEFAULT 0 CHECK (original_distance_km >= 0),
    total_distance_km REAL NOT NULL DEFAULT 0 CHECK (total_distance_km >= 0),
    saved_distance_km REAL NOT NULL DEFAULT 0 CHECK (saved_distance_km >= 0),
    estimated_duration_min INTEGER NOT NULL DEFAULT 0 CHECK (estimated_duration_min >= 0),
    saved_duration_min INTEGER NOT NULL DEFAULT 0 CHECK (saved_duration_min >= 0),
    optimization_count INTEGER NOT NULL DEFAULT 1,
    started_at TEXT,
    completed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS deliveries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    route_id INTEGER NOT NULL REFERENCES delivery_routes(id) ON DELETE CASCADE,
    tracking_code TEXT UNIQUE NOT NULL,
    order_ref TEXT NOT NULL,
    customer_name TEXT NOT NULL,
    customer_phone TEXT NOT NULL,
    recipient_document TEXT NOT NULL,
    address_line TEXT NOT NULL,
    neighborhood TEXT NOT NULL,
    city TEXT NOT NULL DEFAULT 'Bauru/SP',
    lat REAL NOT NULL,
    lng REAL NOT NULL,
    priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal', 'express', 'fragile_cold')),
    items_summary TEXT NOT NULL,
    amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
    delivery_fee_cents INTEGER NOT NULL DEFAULT 0 CHECK (delivery_fee_cents >= 0),
    payment_status TEXT NOT NULL DEFAULT 'paid_online' CHECK (payment_status IN ('paid_online', 'pending_pix', 'paid_pix')),
    pix_charge_id TEXT,
    pix_copy_paste TEXT,
    pix_qr_svg TEXT,
    stop_order INTEGER NOT NULL DEFAULT 1 CHECK (stop_order >= 1),
    distance_from_prev_km REAL NOT NULL DEFAULT 0,
    eta_minutes INTEGER NOT NULL DEFAULT 10,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_transit', 'arriving', 'delivered', 'failed')),
    confirmation_pin TEXT NOT NULL,
    recipient_signature_name TEXT,
    proof_notes TEXT,
    delivered_at TEXT,
    paid_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS tracking_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    delivery_id INTEGER REFERENCES deliveries(id) ON DELETE CASCADE,
    route_id INTEGER REFERENCES delivery_routes(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    lat REAL,
    lng REAL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

function logTrackingEvent({ deliveryId, routeId, eventType, title, description, lat, lng }) {
  db.prepare(
    `INSERT INTO tracking_events (delivery_id, route_id, event_type, title, description, lat, lng)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(deliveryId ?? null, routeId ?? null, eventType, title, description, lat ?? null, lng ?? null);
}

function seedIfEmpty() {
  const count = db.prepare("SELECT COUNT(*) AS n FROM delivery_routes").get().n;
  if (count > 0) return;

  const hash = bcrypt.hashSync("admin123", 10);
  db.prepare(`INSERT INTO users (username, password_hash, full_name, role) VALUES (?, ?, ?, 'admin')`).run(
    "admin",
    hash,
    "Rafael Oliveira — Coordenador de Logistica"
  );

  db.prepare(
    `INSERT INTO couriers (name, phone, vehicle_type, vehicle_plate, status, current_lat, current_lng) VALUES
    (?, ?, 'motorcycle', 'FGH-4B29', 'on_route', -22.3248, -49.0582),
    (?, ?, 'utility_van', 'BXZ-9A81', 'available', -22.3145, -49.0606),
    (?, ?, 'motorcycle', 'DKP-7C14', 'available', -22.3145, -49.0606)`
  ).run(
    "Marcos Vinicius Santos",
    "14991234567",
    "Lucas Ferreira Lima",
    "14992345678",
    "Henrique Alves Souza",
    "14993456789"
  );

  const courier1 = 1;
  const courier2 = 2;

  const r1 = db
    .prepare(
      `INSERT INTO delivery_routes (route_code, title, courier_id, status, started_at) VALUES (?, ?, ?, 'in_progress', datetime('now'))`
    )
    .run("ROTA-2026-101", "Rota Manha — Centro, Universitaria & Zona Sul", courier1);
  const route1Id = r1.lastInsertRowid;

  const pix2 = createMockPixCharge({
    trackingCode: "ENT-2026-1002",
    customerName: "Clinica Odontologica Sorriso Pleno",
    amountCents: 34900,
  });

  const pix4 = createMockPixCharge({
    trackingCode: "ENT-2026-1004",
    customerName: "Condominio Residencial Villaggio Sul — Mariana Ribeiro",
    amountCents: 14800,
  });

  const deliveriesR1 = [
    {
      tracking_code: "ENT-2026-1001",
      order_ref: "PED-8841",
      customer_name: "Farmacia & Manipulacao BioFormula Ltda",
      customer_phone: "1432221100",
      recipient_document: "12345678000190",
      address_line: "Rua Batista de Carvalho, 640",
      neighborhood: "Centro",
      lat: -22.3182,
      lng: -49.0695,
      priority: "normal",
      items_summary: "2x Frasco Manipulado + 1x Vitamina",
      amount_cents: 18500,
      payment_status: "paid_online",
      stop_order: 1,
      status: "delivered",
      confirmation_pin: "3419",
      recipient_signature_name: "Juliana Costa",
      delivered_at: datetimeNow(),
    },
    {
      tracking_code: "ENT-2026-1002",
      order_ref: "PED-8842",
      customer_name: "Clinica Odontologica Sorriso Pleno",
      customer_phone: "1433334455",
      recipient_document: "45678912000155",
      address_line: "Rua Dr. Fuas de Matos Sabino, 415",
      neighborhood: "Jardim America",
      lat: -22.3324,
      lng: -49.0548,
      priority: "fragile_cold",
      items_summary: "1x Kit Anestesico Refrigerado",
      amount_cents: 34900,
      payment_status: "pending_pix",
      stop_order: 2,
      status: "arriving",
      confirmation_pin: "4821",
      pix: pix2,
    },
    {
      tracking_code: "ENT-2026-1003",
      order_ref: "PED-8843",
      customer_name: "Emporio & Padaria Grao Real",
      customer_phone: "1434445566",
      recipient_document: "98765432000110",
      address_line: "Av. Nacoes Unidas, 2850",
      neighborhood: "Vila Universitaria",
      lat: -22.3385,
      lng: -49.0481,
      priority: "normal",
      items_summary: "2x Fardo Farinha + 1x Bandeja Paes",
      amount_cents: 22000,
      payment_status: "paid_online",
      stop_order: 3,
      status: "in_transit",
      confirmation_pin: "7750",
    },
    {
      tracking_code: "ENT-2026-1004",
      order_ref: "PED-8844",
      customer_name: "Condominio Residencial Villaggio Sul — Mariana Ribeiro",
      customer_phone: "14999887766",
      recipient_document: "32165498700",
      address_line: "Av. Affonso Jose Aiello, 1400",
      neighborhood: "Vila Aviacao",
      lat: -22.354,
      lng: -49.0365,
      priority: "express",
      items_summary: "1x Caixa Organizadora Express",
      amount_cents: 14800,
      payment_status: "pending_pix",
      stop_order: 4,
      status: "in_transit",
      confirmation_pin: "9164",
      pix: pix4,
    },
  ];

  for (const d of deliveriesR1) {
    insertDelivery(route1Id, d);
  }

  const r2 = db
    .prepare(`INSERT INTO delivery_routes (route_code, title, courier_id, status) VALUES (?, ?, ?, 'planned')`)
    .run("ROTA-2026-102", "Rota Tarde — Zona Leste & Parque Vista Alegre", courier2);
  const route2Id = r2.lastInsertRowid;

  insertDelivery(route2Id, {
    tracking_code: "ENT-2026-1005",
    order_ref: "PED-8845",
    customer_name: "Supermercado Bom Preco Parque",
    customer_phone: "1435556677",
    recipient_document: "23456789000188",
    address_line: "Av. Nuno de Assis, 1920",
    neighborhood: "Jardim Bela Vista",
    lat: -22.3025,
    lng: -49.051,
    priority: "normal",
    items_summary: "3x Caixa Bebidas + 2x Fardo Arroz",
    amount_cents: 54000,
    payment_status: "paid_online",
    stop_order: 1,
    status: "pending",
    confirmation_pin: "5512",
  });

  const pix6 = createMockPixCharge({
    trackingCode: "ENT-2026-1006",
    customerName: "Deposito & Mercearia Avenida",
    amountCents: 29500,
  });

  insertDelivery(route2Id, {
    tracking_code: "ENT-2026-1006",
    order_ref: "PED-8846",
    customer_name: "Deposito & Mercearia Avenida",
    customer_phone: "1436667788",
    recipient_document: "67890123000144",
    address_line: "Av. Marcos de Paula Raphael, 810",
    neighborhood: "Mary Dota",
    lat: -22.288,
    lng: -49.0245,
    priority: "normal",
    items_summary: "1x Fardo Refrigerante Lata",
    amount_cents: 29500,
    payment_status: "pending_pix",
    stop_order: 2,
    status: "pending",
    confirmation_pin: "6038",
    pix: pix6,
  });

  applyRouteMetrics(route1Id);
  applyRouteMetrics(route2Id);

  logTrackingEvent({
    routeId: route1Id,
    deliveryId: 1,
    eventType: "created",
    title: "Rota iniciada",
    description: "Romaneio ROTA-2026-101 liberado para entrega.",
    lat: -22.3145,
    lng: -49.0606,
  });
  logTrackingEvent({
    routeId: route1Id,
    deliveryId: 2,
    eventType: "arriving",
    title: "Motoboy chegando",
    description: "Entregador a caminho da Clinica Sorriso Pleno.",
    lat: -22.3248,
    lng: -49.0582,
  });
}

function datetimeNow() {
  return db.prepare("SELECT datetime('now') AS t").get().t;
}

function insertDelivery(routeId, d) {
  const pix = d.pix || null;
  db.prepare(
    `INSERT INTO deliveries (
      route_id, tracking_code, order_ref, customer_name, customer_phone, recipient_document,
      address_line, neighborhood, lat, lng, priority, items_summary, amount_cents, delivery_fee_cents,
      payment_status, pix_charge_id, pix_copy_paste, pix_qr_svg, stop_order, status, confirmation_pin,
      recipient_signature_name, delivered_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    routeId,
    d.tracking_code,
    d.order_ref,
    d.customer_name,
    d.customer_phone,
    d.recipient_document,
    d.address_line,
    d.neighborhood,
    d.lat,
    d.lng,
    d.priority,
    d.items_summary,
    d.amount_cents,
    d.payment_status,
    pix?.pix_charge_id ?? null,
    pix?.pix_copy_paste ?? null,
    pix?.pix_qr_svg ?? null,
    d.stop_order,
    d.status,
    d.confirmation_pin,
    d.recipient_signature_name ?? null,
    d.delivered_at ?? null
  );
}

export function applyRouteMetrics(routeId) {
  const route = db.prepare("SELECT * FROM delivery_routes WHERE id = ?").get(routeId);
  if (!route) return;
  const stops = db
    .prepare("SELECT * FROM deliveries WHERE route_id = ? ORDER BY stop_order")
    .all(routeId)
    .map((row) => ({ ...row }));
  const origin = { lat: route.origin_lat, lng: route.origin_lng };
  const result = computeRouteMetricsInCurrentOrder(origin, stops);
  for (const s of result.enrichedStops) {
    db.prepare(`UPDATE deliveries SET distance_from_prev_km = ?, eta_minutes = ? WHERE id = ?`).run(
      s.distance_from_prev_km,
      s.eta_minutes,
      s.id
    );
  }
  db.prepare(`UPDATE delivery_routes SET total_distance_km = ?, estimated_duration_min = ? WHERE id = ?`).run(
    result.total_distance_km,
    result.estimated_duration_min,
    routeId
  );
}

export function logTrackingEventExport(params) {
  logTrackingEvent(params);
}

seedIfEmpty();

export function closeDb() {
  db.close();
}

export default db;

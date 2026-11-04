import express from "express";
import cors from "cors";
import bcrypt from "bcryptjs";
import path from "path";
import { fileURLToPath } from "url";
import db, { applyRouteMetrics, logTrackingEventExport } from "./db.js";
import { authMiddleware, signToken } from "./auth.js";
import { loginRateLimit } from "./loginRateLimit.js";
import { getMapMode, geocodeBauruAddress, optimizeStopsSequence, calculateHaversineKm } from "./routeOptimizer.js";
import { createPixChargeForDelivery, getPixMode } from "./pixProvider.js";
import { generateRouteManifestPdfBuffer } from "./pdfGenerator.js";
import {
  attachLiveTracking,
  broadcastLiveEvent,
  getLiveSummary,
  handleSseStream,
} from "./liveTracker.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const corsOrigin = process.env.CORS_ORIGIN || "http://localhost:5173";

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  next();
});
app.use(cors({ origin: corsOrigin }));
app.use(express.json({ limit: "2mb" }));

const clientDist = path.join(__dirname, "..", "client", "dist");
app.use(express.static(clientDist));

function validateDocumentDigits(doc) {
  const digits = String(doc || "").replace(/\D/g, "");
  return digits.length === 11 || digits.length === 14;
}

function getUserByUsername(username) {
  return db.prepare("SELECT * FROM users WHERE username = ?").get(String(username).trim());
}

function getDeliveryByTracking(code) {
  return db.prepare("SELECT * FROM deliveries WHERE tracking_code = ?").get(String(code).trim());
}

function getRouteById(id) {
  return db.prepare("SELECT * FROM delivery_routes WHERE id = ?").get(Number(id));
}

function getRouteByCode(code) {
  return db.prepare("SELECT * FROM delivery_routes WHERE route_code = ?").get(String(code).trim());
}

function routeDeliveries(routeId) {
  return db.prepare("SELECT * FROM deliveries WHERE route_id = ? ORDER BY stop_order, id").all(routeId);
}

function routeCourier(courierId) {
  return db.prepare("SELECT * FROM couriers WHERE id = ?").get(courierId);
}

function deliveryEvents(deliveryId) {
  return db
    .prepare(
      "SELECT * FROM tracking_events WHERE delivery_id = ? OR route_id = (SELECT route_id FROM deliveries WHERE id = ?) ORDER BY created_at, id"
    )
    .all(deliveryId, deliveryId);
}

function nextTrackingCode() {
  const row = db.prepare("SELECT tracking_code FROM deliveries ORDER BY id DESC LIMIT 1").get();
  if (!row) return "ENT-2026-1001";
  const num = Number(String(row.tracking_code).replace(/\D/g, "")) + 1;
  return `ENT-2026-${num}`;
}

function nextRouteCode() {
  const row = db.prepare("SELECT route_code FROM delivery_routes ORDER BY id DESC LIMIT 1").get();
  if (!row) return "ROTA-2026-101";
  const num = Number(String(row.route_code).replace(/\D/g, "")) + 1;
  return `ROTA-2026-${num}`;
}

function randomPin() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

function buildPolylineForRoute(route) {
  const stops = routeDeliveries(route.id);
  const pts = [{ lat: route.origin_lat, lng: route.origin_lng }];
  for (const s of stops) pts.push({ lat: s.lat, lng: s.lng });
  return pts;
}

function stopsAhead(routeId, stopOrder) {
  return db
    .prepare(
      `SELECT COUNT(*) AS n FROM deliveries WHERE route_id = ? AND stop_order < ? AND status NOT IN ('delivered', 'failed')`
    )
    .get(routeId, stopOrder).n;
}

function remainingKmToStop(courier, delivery) {
  return calculateHaversineKm(courier.current_lat, courier.current_lng, delivery.lat, delivery.lng);
}

function runSimulateRouteStep(routeId, body = {}) {
  const route = getRouteById(routeId);
  if (!route) return null;
  const courier = routeCourier(route.courier_id);
  if (route.status === "planned") {
    db.prepare(`UPDATE delivery_routes SET status = 'in_progress', started_at = datetime('now') WHERE id = ?`).run(
      route.id
    );
    db.prepare(`UPDATE couriers SET status = 'on_route' WHERE id = ?`).run(route.courier_id);
    const deliveries = routeDeliveries(route.id);
    for (const d of deliveries) {
      if (d.status !== "delivered") {
        db.prepare(`UPDATE deliveries SET status = 'in_transit' WHERE id = ?`).run(d.id);
      }
    }
    const first = deliveries.find((d) => d.status !== "delivered");
    if (first) db.prepare(`UPDATE deliveries SET status = 'arriving' WHERE id = ?`).run(first.id);
  }
  let target = db
    .prepare(
      `SELECT * FROM deliveries WHERE route_id = ? AND status IN ('arriving', 'in_transit', 'pending') ORDER BY stop_order LIMIT 1`
    )
    .get(route.id);
  if (body.lat != null && body.lng != null) {
    db.prepare(
      `UPDATE couriers SET current_lat = ?, current_lng = ?, last_ping_at = datetime('now') WHERE id = ?`
    ).run(Number(body.lat), Number(body.lng), route.courier_id);
  } else if (target) {
    db.prepare(
      `UPDATE couriers SET current_lat = ?, current_lng = ?, last_ping_at = datetime('now') WHERE id = ?`
    ).run(target.lat, target.lng, route.courier_id);
    if (target.status === "in_transit" || target.status === "pending") {
      db.prepare(`UPDATE deliveries SET status = 'arriving' WHERE id = ?`).run(target.id);
    }
  }
  logTrackingEventExport({
    routeId: route.id,
    deliveryId: target?.id,
    eventType: "gps_updated",
    title: "Telemetria atualizada",
    description: "Posicao do entregador atualizada no mapa.",
    lat: body.lat ?? target?.lat ?? courier.current_lat,
    lng: body.lng ?? target?.lng ?? courier.current_lng,
  });
  broadcastLiveEvent({ type: "gps_updated", route_id: route.id, courier_id: route.courier_id });
  return {
    route: getRouteById(route.id),
    courier: routeCourier(route.courier_id),
    deliveries: routeDeliveries(route.id),
  };
}

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    service: "rota-entregas",
    mapMode: getMapMode(),
    pixMode: getPixMode(),
    realtime: "ws+sse",
  });
});

app.get("/api/tracking/:trackingCode", (req, res) => {
  const delivery = getDeliveryByTracking(req.params.trackingCode);
  if (!delivery) return res.status(404).json({ error: "Entrega nao encontrada" });
  const route = getRouteById(delivery.route_id);
  const courier = routeCourier(route.courier_id);
  const events = db
    .prepare(
      `SELECT * FROM tracking_events WHERE delivery_id = ? OR route_id = ? ORDER BY created_at, id`
    )
    .all(delivery.id, route.id);
  const preview = routeDeliveries(route.id).map((d) => ({
    stop_order: d.stop_order,
    tracking_code: d.tracking_code,
    lat: d.lat,
    lng: d.lng,
    status: d.status,
    highlight: d.id === delivery.id,
  }));
  res.json({
    ...delivery,
    route_code: route.route_code,
    title: route.title,
    origin_name: route.origin_name,
    origin_lat: route.origin_lat,
    origin_lng: route.origin_lng,
    route_status: route.status,
    courier_name: courier.name,
    courier_phone: courier.phone,
    vehicle_type: courier.vehicle_type,
    vehicle_plate: courier.vehicle_plate,
    current_lat: courier.current_lat,
    current_lng: courier.current_lng,
    stops_ahead: stopsAhead(route.id, delivery.stop_order),
    remaining_km: remainingKmToStop(courier, delivery),
    route_stops_preview: preview,
    events,
  });
});

app.post("/api/tracking/:trackingCode/confirm", (req, res) => {
  const delivery = getDeliveryByTracking(req.params.trackingCode);
  if (!delivery) return res.status(404).json({ error: "Entrega nao encontrada" });
  if (delivery.status === "delivered") return res.status(409).json({ error: "Entrega ja concluida" });
  const { pin, recipient_name, proof_notes } = req.body || {};
  if (!recipient_name || !String(recipient_name).trim()) {
    return res.status(400).json({ error: "Informe o nome de quem recebeu" });
  }
  if (String(pin) !== String(delivery.confirmation_pin)) {
    return res.status(400).json({ error: "PIN incorreto" });
  }
  const route = getRouteById(delivery.route_id);
  db.prepare(
    `UPDATE deliveries SET status = 'delivered', recipient_signature_name = ?, proof_notes = ?, delivered_at = datetime('now') WHERE id = ?`
  ).run(String(recipient_name).trim(), proof_notes || "", delivery.id);
  db.prepare(`UPDATE couriers SET current_lat = ?, current_lng = ?, last_ping_at = datetime('now') WHERE id = ?`).run(
    delivery.lat,
    delivery.lng,
    route.courier_id
  );
  const nextStop = db
    .prepare(
      `SELECT * FROM deliveries WHERE route_id = ? AND status NOT IN ('delivered', 'failed') ORDER BY stop_order LIMIT 1`
    )
    .get(route.id);
  if (nextStop && nextStop.id !== delivery.id) {
    db.prepare(`UPDATE deliveries SET status = 'arriving' WHERE id = ?`).run(nextStop.id);
  }
  const pending = db
    .prepare(`SELECT COUNT(*) AS n FROM deliveries WHERE route_id = ? AND status NOT IN ('delivered', 'failed')`)
    .get(route.id).n;
  if (pending === 0) {
    db.prepare(`UPDATE delivery_routes SET status = 'completed', completed_at = datetime('now') WHERE id = ?`).run(
      route.id
    );
  }
  logTrackingEventExport({
    deliveryId: delivery.id,
    routeId: route.id,
    eventType: "delivered",
    title: "Entrega confirmada",
    description: `Recebido por ${recipient_name}`,
    lat: delivery.lat,
    lng: delivery.lng,
  });
  broadcastLiveEvent({ type: "delivery_completed", tracking_code: delivery.tracking_code, route_id: route.id });
  const updated = getDeliveryByTracking(delivery.tracking_code);
  res.json(updated);
});

app.post("/api/tracking/:trackingCode/simulate-courier", (req, res) => {
  const delivery = getDeliveryByTracking(req.params.trackingCode);
  if (!delivery) return res.status(404).json({ error: "Entrega nao encontrada" });
  const result = runSimulateRouteStep(delivery.route_id, req.body || {});
  if (!result) return res.status(404).json({ error: "Rota nao encontrada" });
  res.json(result);
});

app.post("/api/webhooks/pix", (req, res) => {
  const { tracking_code, pix_charge_id } = req.body || {};
  let delivery = null;
  if (tracking_code) delivery = getDeliveryByTracking(tracking_code);
  else if (pix_charge_id) {
    delivery = db.prepare("SELECT * FROM deliveries WHERE pix_charge_id = ?").get(String(pix_charge_id));
  }
  if (!delivery) return res.status(404).json({ error: "Cobranca nao encontrada" });
  db.prepare(
    `UPDATE deliveries SET payment_status = 'paid_pix', paid_at = datetime('now') WHERE id = ?`
  ).run(delivery.id);
  logTrackingEventExport({
    deliveryId: delivery.id,
    routeId: delivery.route_id,
    eventType: "pix_paid",
    title: "Pix confirmado",
    description: `Pagamento recebido para ${delivery.tracking_code}`,
    lat: null,
    lng: null,
  });
  broadcastLiveEvent({ type: "pix_paid", tracking_code: delivery.tracking_code });
  const updated = db.prepare("SELECT * FROM deliveries WHERE id = ?").get(delivery.id);
  res.json(updated);
});

app.get("/api/routes/:routeCode/manifest.pdf", (req, res) => {
  const route = getRouteByCode(req.params.routeCode);
  if (!route) return res.status(404).json({ error: "Rota nao encontrada" });
  const courier = routeCourier(route.courier_id);
  const deliveries = routeDeliveries(route.id);
  const buf = generateRouteManifestPdfBuffer(route, courier, deliveries);
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="romaneio-${route.route_code}.pdf"`
  );
  res.send(buf);
});

app.get("/api/live/events", (req, res) => {
  res.json(getLiveSummary(db));
});

app.get("/api/live/stream", (req, res) => {
  handleSseStream(req, res);
});

app.post("/api/auth/login", loginRateLimit, (req, res) => {
  const { username, password } = req.body || {};
  const user = getUserByUsername(username);
  if (!user || !bcrypt.compareSync(String(password || ""), user.password_hash)) {
    return res.status(401).json({ error: "Credenciais invalidas" });
  }
  res.json({ token: signToken(user), username: user.username, fullName: user.full_name });
});

app.get("/api/auth/me", authMiddleware, (req, res) => {
  const user = db.prepare("SELECT username, full_name FROM users WHERE id = ?").get(req.user.sub);
  if (!user) return res.status(401).json({ error: "Nao autenticado" });
  res.json({ username: user.username, fullName: user.full_name });
});

app.get("/api/admin/dashboard", authMiddleware, (req, res) => {
  const total_routes = db.prepare("SELECT COUNT(*) AS n FROM delivery_routes").get().n;
  const active_routes_count = db
    .prepare("SELECT COUNT(*) AS n FROM delivery_routes WHERE status = 'in_progress'")
    .get().n;
  const total_deliveries = db.prepare("SELECT COUNT(*) AS n FROM deliveries").get().n;
  const delivered_count = db.prepare("SELECT COUNT(*) AS n FROM deliveries WHERE status = 'delivered'").get().n;
  const in_transit_or_arriving_count = db
    .prepare("SELECT COUNT(*) AS n FROM deliveries WHERE status IN ('in_transit', 'arriving')")
    .get().n;
  const pending_count = db.prepare("SELECT COUNT(*) AS n FROM deliveries WHERE status = 'pending'").get().n;
  const failed_count = db.prepare("SELECT COUNT(*) AS n FROM deliveries WHERE status = 'failed'").get().n;
  const kmRow = db
    .prepare(
      "SELECT COALESCE(SUM(total_distance_km),0) AS km, COALESCE(SUM(saved_distance_km),0) AS saved, COALESCE(SUM(saved_duration_min),0) AS mins FROM delivery_routes"
    )
    .get();
  const pixPending = db
    .prepare("SELECT COALESCE(SUM(amount_cents),0) AS c FROM deliveries WHERE payment_status = 'pending_pix'")
    .get().c;
  const pixReceived = db
    .prepare("SELECT COALESCE(SUM(amount_cents),0) AS c FROM deliveries WHERE payment_status = 'paid_pix'")
    .get().c;
  const couriers = db.prepare("SELECT * FROM couriers ORDER BY id").all();
  res.json({
    total_routes,
    active_routes_count,
    total_deliveries,
    delivered_count,
    in_transit_or_arriving_count,
    pending_count,
    failed_count,
    total_km_planned: kmRow.km,
    total_km_saved: kmRow.saved,
    total_minutes_saved: kmRow.mins,
    cod_pix_pending_cents: pixPending,
    cod_pix_received_cents: pixReceived,
    couriers,
  });
});

function mapRouteList(statusFilter) {
  let sql = "SELECT * FROM delivery_routes";
  const params = [];
  if (statusFilter) {
    sql += " WHERE status = ?";
    params.push(statusFilter);
  }
  sql += " ORDER BY id DESC";
  const routes = db.prepare(sql).all(...params);
  return routes.map((route) => {
    const courier = routeCourier(route.courier_id);
    const deliveries = routeDeliveries(route.id);
    return { ...route, courier, deliveries, polyline: buildPolylineForRoute(route) };
  });
}

app.get("/api/admin/routes", authMiddleware, (req, res) => {
  res.json(mapRouteList(req.query.status));
});

app.get("/api/admin/routes/:id", authMiddleware, (req, res) => {
  const route = getRouteById(req.params.id);
  if (!route) return res.status(404).json({ error: "Rota nao encontrada" });
  const courier = routeCourier(route.courier_id);
  const deliveries = routeDeliveries(route.id);
  const events = db
    .prepare("SELECT * FROM tracking_events WHERE route_id = ? ORDER BY created_at, id")
    .all(route.id);
  res.json({ ...route, courier, deliveries, polyline: buildPolylineForRoute(route), events });
});

app.post("/api/admin/routes", authMiddleware, (req, res) => {
  const b = req.body || {};
  const courier_id = Number(b.courier_id);
  if (!courier_id || !routeCourier(courier_id)) {
    return res.status(400).json({ error: "Entregador invalido" });
  }
  const route_code = nextRouteCode();
  const r = db
    .prepare(
      `INSERT INTO delivery_routes (route_code, title, courier_id, origin_name, origin_lat, origin_lng) VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      route_code,
      b.title || `Rota ${route_code}`,
      courier_id,
      b.origin_name || "CD Central Bauru — Av. Rodrigues Alves, 1200",
      Number(b.origin_lat) || -22.3145,
      Number(b.origin_lng) || -49.0606
    );
  const route = getRouteById(r.lastInsertRowid);
  applyRouteMetrics(route.id);
  res.status(201).json(getRouteById(route.id));
});

app.post("/api/admin/routes/:id/deliveries", authMiddleware, async (req, res) => {
  const route = getRouteById(req.params.id);
  if (!route) return res.status(404).json({ error: "Rota nao encontrada" });
  const b = req.body || {};
  if (!validateDocumentDigits(b.recipient_document)) {
    return res.status(400).json({ error: "CPF ou CNPJ invalido" });
  }
  let lat = Number(b.lat);
  let lng = Number(b.lng);
  if (!lat || !lng) {
    const geo = geocodeBauruAddress(b.address_line, b.neighborhood);
    lat = geo.lat;
    lng = geo.lng;
  }
  const tracking_code = nextTrackingCode();
  const confirmation_pin = randomPin();
  const payment_status = b.payment_status === "pending_pix" ? "pending_pix" : "paid_online";
  const draft = {
    tracking_code,
    customer_name: b.customer_name,
    amount_cents: Number(b.amount_cents) || 0,
    delivery_fee_cents: Number(b.delivery_fee_cents) || 0,
    payment_status,
  };
  let pixFields = { pix_charge_id: null, pix_copy_paste: null, pix_qr_svg: null };
  if (payment_status === "pending_pix") {
    pixFields = await createPixChargeForDelivery(draft);
  }
  const maxOrder =
    db.prepare("SELECT COALESCE(MAX(stop_order),0) AS m FROM deliveries WHERE route_id = ?").get(route.id).m + 1;
  const ins = db
    .prepare(
      `INSERT INTO deliveries (
        route_id, tracking_code, order_ref, customer_name, customer_phone, recipient_document,
        address_line, neighborhood, lat, lng, priority, items_summary, amount_cents, delivery_fee_cents,
        payment_status, pix_charge_id, pix_copy_paste, pix_qr_svg, stop_order, confirmation_pin
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      route.id,
      tracking_code,
      b.order_ref || `PED-${Date.now().toString().slice(-4)}`,
      b.customer_name,
      b.customer_phone,
      String(b.recipient_document).replace(/\D/g, ""),
      b.address_line,
      b.neighborhood,
      lat,
      lng,
      b.priority || "normal",
      b.items_summary || "Pedido avulso",
      Number(b.amount_cents) || 0,
      Number(b.delivery_fee_cents) || 0,
      payment_status,
      pixFields.pix_charge_id,
      pixFields.pix_copy_paste,
      pixFields.pix_qr_svg,
      maxOrder,
      confirmation_pin
    );
  applyRouteMetrics(route.id);
  const created = db.prepare("SELECT * FROM deliveries WHERE id = ?").get(ins.lastInsertRowid);
  res.status(201).json(created);
});

app.post("/api/admin/routes/:id/optimize", authMiddleware, (req, res) => {
  const route = getRouteById(req.params.id);
  if (!route) return res.status(404).json({ error: "Rota nao encontrada" });
  const stops = routeDeliveries(route.id);
  const origin = { lat: route.origin_lat, lng: route.origin_lng };
  const result = optimizeStopsSequence(origin, stops, {
    prioritizeExpress: req.body?.prioritize_express !== false,
  });
  for (const s of result.optimizedStops) {
    db.prepare(
      `UPDATE deliveries SET stop_order = ?, distance_from_prev_km = ?, eta_minutes = ? WHERE id = ?`
    ).run(s.stop_order, s.distance_from_prev_km, s.eta_minutes, s.id);
  }
  db.prepare(
    `UPDATE delivery_routes SET original_distance_km = ?, total_distance_km = ?, saved_distance_km = ?,
     estimated_duration_min = ?, saved_duration_min = ?, optimization_count = optimization_count + 1 WHERE id = ?`
  ).run(
    result.original_distance_km,
    result.total_distance_km,
    result.saved_distance_km,
    result.estimated_duration_min,
    result.saved_duration_min,
    route.id
  );
  logTrackingEventExport({
    routeId: route.id,
    eventType: "route_optimized",
    title: "Rota otimizada",
    description: `Economia de ${result.saved_distance_km} km`,
    lat: route.origin_lat,
    lng: route.origin_lng,
  });
  broadcastLiveEvent({ type: "route_optimized", route_id: route.id, saved_km: result.saved_distance_km });
  const updated = getRouteById(route.id);
  res.json({ ...updated, deliveries: routeDeliveries(route.id), optimization: result });
});

app.post("/api/admin/routes/:id/simulate-step", authMiddleware, (req, res) => {
  const route = getRouteById(req.params.id);
  if (!route) return res.status(404).json({ error: "Rota nao encontrada" });
  const result = runSimulateRouteStep(route.id, req.body || {});
  res.json(result);
});

app.patch("/api/admin/deliveries/:id/status", authMiddleware, (req, res) => {
  const id = Number(req.params.id);
  const delivery = db.prepare("SELECT * FROM deliveries WHERE id = ?").get(id);
  if (!delivery) return res.status(404).json({ error: "Entrega nao encontrada" });
  const { status, proof_notes, recipient_signature_name } = req.body || {};
  const allowed = ["pending", "in_transit", "arriving", "delivered", "failed"];
  if (!allowed.includes(status)) return res.status(400).json({ error: "Status invalido" });
  db.prepare(
    `UPDATE deliveries SET status = ?, proof_notes = COALESCE(?, proof_notes), recipient_signature_name = COALESCE(?, recipient_signature_name),
     delivered_at = CASE WHEN ? = 'delivered' THEN datetime('now') ELSE delivered_at END WHERE id = ?`
  ).run(status, proof_notes ?? null, recipient_signature_name ?? null, status, id);
  const route = getRouteById(delivery.route_id);
  db.prepare(`UPDATE couriers SET current_lat = ?, current_lng = ? WHERE id = ?`).run(
    delivery.lat,
    delivery.lng,
    route.courier_id
  );
  const evType = status === "failed" ? "delivery_failed" : "status_changed";
  logTrackingEventExport({
    deliveryId: id,
    routeId: route.id,
    eventType: evType,
    title: "Status atualizado",
    description: proof_notes || `Status ${status}`,
    lat: delivery.lat,
    lng: delivery.lng,
  });
  broadcastLiveEvent({ type: "status_changed", delivery_id: id, status });
  res.json(db.prepare("SELECT * FROM deliveries WHERE id = ?").get(id));
});

app.get("/", (req, res) => {
  res.json({ ok: true, service: "rota-entregas", docs: "/api/health" });
});

app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api") || req.path.startsWith("/ws")) return next();
  res.sendFile(path.join(clientDist, "index.html"), (err) => {
    if (err) next();
  });
});

const _listen = app.listen.bind(app);
app.listen = (...args) => {
  const server = _listen(...args);
  attachLiveTracking(server);
  return server;
};

export default app;

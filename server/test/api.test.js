import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import http from "http";

process.env.JWT_SECRET = "test-secret-rota-entregas";
process.env.PIX_MODE = "mock";
process.env.MAP_MODE = "mock";
const dbFile = path.join(os.tmpdir(), `rota-entregas-api-test-${process.pid}.db`);
process.env.DB_PATH = dbFile;

const { default: app } = await import("../app.js");
const { default: db, closeDb } = await import("../db.js");
const { calculateHaversineKm, optimizeStopsSequence } = await import("../routeOptimizer.js");
const { verifyWebSocketAccept } = await import("../liveTracker.js");

let server;
let base;
let token;

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  const { port } = server.address();
  base = `http://127.0.0.1:${port}`;

  const loginRes = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "admin123" }),
  });
  token = (await loginRes.json()).token;
});

after(() => {
  server.close();
  closeDb();
  if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile);
});

function authHeaders(extra = {}) {
  return { Authorization: `Bearer ${token}`, ...extra };
}

describe("API rota entregas", () => {
  it("GET /api/health → 200 e ok", async () => {
    const res = await fetch(`${base}/api/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.service, "rota-entregas");
    assert.equal(body.mapMode, "mock");
    assert.equal(body.pixMode, "mock");
  });

  it("GET /api/tracking/:trackingCode → 200 ENT-2026-1002 e 404", async () => {
    const ok = await fetch(`${base}/api/tracking/ENT-2026-1002`);
    assert.equal(ok.status, 200);
    const data = await ok.json();
    assert.equal(data.tracking_code, "ENT-2026-1002");
    assert.ok(data.current_lat);
    assert.ok(data.pix_copy_paste.startsWith("000201"));
    assert.ok(data.pix_qr_svg.includes("<svg"));
    assert.ok(Array.isArray(data.events));
    assert.ok(Array.isArray(data.route_stops_preview));

    const missing = await fetch(`${base}/api/tracking/ENT-9999-9999`);
    assert.equal(missing.status, 404);
  });

  it("GET manifest.pdf → PDF 1.4 valido", async () => {
    const res = await fetch(`${base}/api/routes/ROTA-2026-101/manifest.pdf`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /application\/pdf/);
    const buf = Buffer.from(await res.arrayBuffer());
    const text = buf.toString("utf8");
    assert.ok(text.startsWith("%PDF-1.4"));
    assert.ok(text.includes("%%EOF"));
    assert.ok(text.includes("ROTA-2026-101"));
  });

  it("POST confirm → PIN, entrega e 409", async () => {
    const badPin = await fetch(`${base}/api/tracking/ENT-2026-1002/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin: "0000", recipient_name: "Teste" }),
    });
    assert.equal(badPin.status, 400);

    const ok = await fetch(`${base}/api/tracking/ENT-2026-1002/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin: "4821", recipient_name: "Dr. Henrique Alves", proof_notes: "Recebido na portaria" }),
    });
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.equal(body.status, "delivered");
    const courier = db.prepare("SELECT current_lat, current_lng FROM couriers WHERE id = 1").get();
    assert.equal(courier.current_lat, body.lat);

    const again = await fetch(`${base}/api/tracking/ENT-2026-1002/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin: "4821", recipient_name: "Outro" }),
    });
    assert.equal(again.status, 409);
  });

  it("POST /api/webhooks/pix → paid_pix ENT-2026-1004", async () => {
    const res = await fetch(`${base}/api/webhooks/pix`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tracking_code: "ENT-2026-1004" }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.payment_status, "paid_pix");
    assert.ok(body.paid_at);
    const ev = db
      .prepare("SELECT * FROM tracking_events WHERE event_type = 'pix_paid' AND delivery_id = ?")
      .get(body.id);
    assert.ok(ev);
  });

  it("POST /api/auth/login → 401 e 200", async () => {
    const bad = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "wrong" }),
    });
    assert.equal(bad.status, 401);

    const ok = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "admin123" }),
    });
    assert.equal(ok.status, 200);
    assert.ok((await ok.json()).token);
  });

  it("GET /api/auth/me e dashboard → 401 e KPIs", async () => {
    const noAuth = await fetch(`${base}/api/admin/dashboard`);
    assert.equal(noAuth.status, 401);

    const dash = await fetch(`${base}/api/admin/dashboard`, { headers: authHeaders() });
    assert.equal(dash.status, 200);
    const data = await dash.json();
    assert.ok(data.total_routes >= 2);
    assert.ok(data.total_deliveries >= 6);
    assert.ok(data.total_km_saved >= 0);
    assert.ok(Array.isArray(data.couriers));

    const me = await fetch(`${base}/api/auth/me`, { headers: authHeaders() });
    assert.equal(me.status, 200);
    assert.equal((await me.json()).username, "admin");
  });

  it("GET /api/admin/routes e /:id → polyline", async () => {
    const list = await fetch(`${base}/api/admin/routes`, { headers: authHeaders() });
    assert.equal(list.status, 200);
    const routes = await list.json();
    assert.ok(routes[0].deliveries.length >= 1);
    assert.ok(Array.isArray(routes[0].polyline));

    const detail = await fetch(`${base}/api/admin/routes/1`, { headers: authHeaders() });
    assert.equal(detail.status, 200);
    const one = await detail.json();
    assert.ok(one.polyline.length >= 2);
  });

  it("POST /api/admin/routes → 201", async () => {
    const res = await fetch(`${base}/api/admin/routes`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ title: "Rota Teste Noite", courier_id: 3 }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.ok(body.route_code.startsWith("ROTA-"));
  });

  it("POST deliveries → geocode, pix e 400 documento", async () => {
    const bad = await fetch(`${base}/api/admin/routes/2/deliveries`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        customer_name: "Cliente X",
        customer_phone: "14999999999",
        recipient_document: "123",
        address_line: "Rua A, 10",
        neighborhood: "Centro",
        items_summary: "Teste",
        amount_cents: 1000,
        payment_status: "paid_online",
      }),
    });
    assert.equal(bad.status, 400);

    const ok = await fetch(`${base}/api/admin/routes/2/deliveries`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        customer_name: "Loja Estoril Demo",
        customer_phone: "14988887777",
        recipient_document: "52998224725",
        address_line: "Rua das Palmeiras, 500",
        neighborhood: "Jardim Estoril",
        items_summary: "1x Caixa",
        amount_cents: 8900,
        payment_status: "pending_pix",
      }),
    });
    assert.equal(ok.status, 201);
    const created = await ok.json();
    assert.ok(created.tracking_code.startsWith("ENT-"));
    assert.match(created.confirmation_pin, /^\d{4}$/);
    assert.ok(created.lat);
    assert.ok(created.pix_copy_paste.startsWith("000201"));
  });

  it("POST optimize → reordena e economiza", async () => {
    const routeRow = db.prepare("SELECT id FROM delivery_routes WHERE route_code = 'ROTA-2026-102'").get();
    await fetch(`${base}/api/admin/routes/${routeRow.id}/deliveries`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        customer_name: "Parada Mary Dota",
        customer_phone: "14977776666",
        recipient_document: "39053344705",
        address_line: "Av. Teste, 100",
        neighborhood: "Mary Dota",
        lat: -22.288,
        lng: -49.0245,
        items_summary: "Carga pesada",
        amount_cents: 5000,
        payment_status: "paid_online",
        stop_order: 99,
      }),
    });
    await fetch(`${base}/api/admin/routes/${routeRow.id}/deliveries`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        customer_name: "Parada Centro",
        customer_phone: "14966665555",
        recipient_document: "11222333000181",
        address_line: "Rua Centro, 50",
        neighborhood: "Centro",
        lat: -22.3182,
        lng: -49.0695,
        items_summary: "Carga leve",
        amount_cents: 3000,
        payment_status: "paid_online",
      }),
    });
    await fetch(`${base}/api/admin/routes/${routeRow.id}/deliveries`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        customer_name: "Parada Vila Aviacao",
        customer_phone: "14955554444",
        recipient_document: "23456789000188",
        address_line: "Av. Aviacao, 200",
        neighborhood: "Vila Aviacao",
        lat: -22.354,
        lng: -49.0365,
        items_summary: "Express",
        amount_cents: 4000,
        priority: "express",
        payment_status: "paid_online",
      }),
    });

    const res = await fetch(`${base}/api/admin/routes/${routeRow.id}/optimize`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ prioritize_express: true }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.total_distance_km <= body.original_distance_km + 0.01);
    assert.ok(body.saved_distance_km >= 0);
  });

  it("POST simulate-step → GPS e evento", async () => {
    const routeRow = db.prepare("SELECT id FROM delivery_routes WHERE route_code = 'ROTA-2026-102'").get();
    const before = db.prepare("SELECT current_lat FROM couriers WHERE id = 2").get();
    const res = await fetch(`${base}/api/admin/routes/${routeRow.id}/simulate-step`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.route.status, "in_progress");
    const after = db.prepare("SELECT current_lat FROM couriers WHERE id = 2").get();
    assert.notEqual(before.current_lat, after.current_lat);
    const ev = db.prepare("SELECT * FROM tracking_events WHERE route_id = ? AND event_type = 'gps_updated'").get(routeRow.id);
    assert.ok(ev);
  });

  it("PATCH delivery status → failed ou delivered", async () => {
    let target = db
      .prepare("SELECT id FROM deliveries WHERE status NOT IN ('delivered', 'failed') ORDER BY id LIMIT 1")
      .get();
    if (!target) {
      const routeRow = db.prepare("SELECT id FROM delivery_routes ORDER BY id LIMIT 1").get();
      const ins = db
        .prepare(
          `INSERT INTO deliveries (route_id, tracking_code, order_ref, customer_name, customer_phone, recipient_document,
           address_line, neighborhood, lat, lng, priority, items_summary, amount_cents, payment_status, stop_order, confirmation_pin, status)
           VALUES (?, 'ENT-2026-9998', 'PED-T', 'Teste Patch', '14999990000', '52998224725', 'Rua T, 1', 'Centro', -22.3182, -49.0695,
           'normal', 'Item', 1000, 'paid_online', 99, '1111', 'pending')`
        )
        .run(routeRow.id);
      target = { id: ins.lastInsertRowid };
    }
    const fail = await fetch(`${base}/api/admin/deliveries/${target.id}/status`, {
      method: "PATCH",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ status: "failed", proof_notes: "Cliente ausente" }),
    });
    assert.equal(fail.status, 200);
    assert.equal((await fail.json()).status, "failed");

    const transit = db
      .prepare("SELECT id FROM deliveries WHERE status = 'in_transit' ORDER BY id LIMIT 1")
      .get();
    assert.ok(transit, "deve existir entrega em transito para marcar delivered");
    const ok = await fetch(`${base}/api/admin/deliveries/${transit.id}/status`, {
      method: "PATCH",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ status: "delivered", recipient_signature_name: "Recebedor Teste" }),
    });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).status, "delivered");
  });

  it("GET /api/live/events → feed", async () => {
    const res = await fetch(`${base}/api/live/events`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.events));
    assert.ok(Array.isArray(body.couriers));
  });

  it("routeOptimizer unitario", () => {
    assert.equal(calculateHaversineKm(-22.3182, -49.0695, -22.3182, -49.0695), 0);
    const dist = calculateHaversineKm(-22.3182, -49.0695, -22.354, -49.0365);
    assert.ok(dist > 4);
    const origin = { lat: -22.3145, lng: -49.0606 };
    const zigzag = [
      { id: 1, lat: -22.288, lng: -49.0245, stop_order: 1, status: "pending", priority: "normal" },
      { id: 2, lat: -22.3182, lng: -49.0695, stop_order: 2, status: "pending", priority: "normal" },
      { id: 3, lat: -22.354, lng: -49.0365, stop_order: 3, status: "pending", priority: "normal" },
    ];
    const result = optimizeStopsSequence(origin, zigzag);
    assert.ok(result.total_distance_km <= result.original_distance_km);
  });

  it("WebSocket handshake /ws/tracking", async () => {
    const { port } = server.address();
    const key = Buffer.from("dGhlIHNhbXBsZSBub25jZQ==").toString("base64");
    const expectedAccept = verifyWebSocketAccept(key);
    const result = await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: "127.0.0.1",
        port,
        path: "/ws/tracking",
        method: "GET",
        headers: {
          Connection: "Upgrade",
          Upgrade: "websocket",
          "Sec-WebSocket-Key": key,
          "Sec-WebSocket-Version": "13",
        },
      });
      req.on("response", (res) => {
        resolve({
          status: res.statusCode,
          accept: res.headers["sec-websocket-accept"],
        });
      });
      req.on("upgrade", (res, socket) => {
        resolve({
          status: res.statusCode,
          accept: res.headers["sec-websocket-accept"],
        });
        socket.destroy();
      });
      req.on("error", reject);
      req.end();
    });
    assert.equal(result.status, 101);
    assert.equal(result.accept, expectedAccept);
  });
});

import { useCallback, useEffect, useMemo, useState } from "react";

const ROUTE_STATUS = {
  planned: "Planejada",
  in_progress: "Em andamento",
  completed: "Concluida",
  cancelled: "Cancelada",
};

const DELIVERY_STATUS = {
  pending: "Aguardando saida",
  in_transit: "Em rota de entrega",
  arriving: "Motoboy chegando no local",
  delivered: "Entregue com sucesso",
  failed: "Ocorrencia / nao entregue",
};

const PRIORITY = {
  normal: "Normal",
  express: "Expressa prioritária",
  fragile_cold: "Refrigerado / fragil",
};

const VEHICLE = {
  motorcycle: "Motocicleta",
  utility_van: "Utilitario refrigerado",
  cargo_bike: "Bicicleta carga",
};

const PAY = {
  paid_online: "Ja pago online",
  pending_pix: "Cobrar Pix na entrega",
  paid_pix: "Pix recebido",
};

const DEMO_CODES = [
  { code: "ENT-2026-1002", label: "Clinica Sorriso Pleno (Pix + PIN 4821)" },
  { code: "ENT-2026-1003", label: "Emporio Grao Real (1 parada a frente)" },
  { code: "ENT-2026-1004", label: "Villaggio Sul (Express + Pix)" },
  { code: "ENT-2026-1001", label: "Farmacia BioFormula (concluida)" },
];

const BAIRROS = [
  "Centro",
  "Vila Universitaria",
  "Jardim America",
  "Jardim Estoril",
  "Vila Aviacao",
  "Jardim Bela Vista",
  "Mary Dota",
  "Parque Vista Alegre",
  "Vila Falcao",
  "Distrito Industrial",
];

function money(cents) {
  return `R$ ${((Number(cents) || 0) / 100).toFixed(2).replace(".", ",")}`;
}

function project(lat, lng, w = 520, h = 320) {
  const minLat = -22.36;
  const maxLat = -22.275;
  const minLng = -49.095;
  const maxLng = -49.008;
  const x = ((lng - minLng) / (maxLng - minLng)) * w;
  const y = ((maxLat - lat) / (maxLat - minLat)) * h;
  return { x, y };
}

function RouteMap({ origin, stops, courier, highlightCode }) {
  const w = 520;
  const h = 320;
  const points = useMemo(() => {
    const list = [];
    if (origin) list.push({ ...project(origin.lat, origin.lng, w, h), label: "CD", kind: "origin" });
    for (const s of stops || []) {
      list.push({
        ...project(s.lat, s.lng, w, h),
        label: String(s.stop_order),
        kind: s.tracking_code === highlightCode ? "active" : "stop",
        title: s.tracking_code,
        detail: s.customer_name
          ? `${s.tracking_code} — ${s.customer_name}`
          : `${s.tracking_code} — ${DELIVERY_STATUS[s.status] || s.status}`,
      });
    }
    if (courier) {
      const lat = courier.current_lat ?? courier.lat;
      const lng = courier.current_lng ?? courier.lng;
      if (lat != null && lng != null && !Number.isNaN(Number(lat)) && !Number.isNaN(Number(lng))) {
        list.push({
          ...project(Number(lat), Number(lng), w, h),
          label: "M",
          kind: "courier",
          title: courier.name ? `Entregador: ${courier.name}` : "Entregador",
        });
      }
    }
    return list;
  }, [origin, stops, courier, highlightCode]);

  const pathD = useMemo(() => {
    if (!origin || !stops?.length) return "";
    const seq = [{ lat: origin.lat, lng: origin.lng }, ...stops.map((s) => ({ lat: s.lat, lng: s.lng }))];
    return seq
      .map((p, i) => {
        const { x, y } = project(p.lat, p.lng, w, h);
        return `${i === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`;
      })
      .join(" ");
  }, [origin, stops]);

  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="map-svg" role="img" aria-label="Mapa de paradas em Bauru">
      <rect width={w} height={h} fill="#e8eef5" />
      {[...Array(8)].map((_, i) => (
        <line key={i} x1={0} y1={(h / 8) * i} x2={w} y2={(h / 8) * i} stroke="#d0dbe8" strokeWidth="1" />
      ))}
      {pathD && <path d={pathD} fill="none" stroke="#2563eb" strokeWidth="2" strokeDasharray="6 4" />}
      {points.map((p, idx) => (
        <g key={idx} transform={`translate(${p.x}, ${p.y})`}>
          {(p.title || p.detail) && <title>{p.detail || p.title}</title>}
          <circle
            r={p.kind === "courier" ? 11 : 9}
            fill={
              p.kind === "origin"
                ? "#0f766e"
                : p.kind === "courier"
                  ? "#ea580c"
                  : p.kind === "active"
                    ? "#dc2626"
                    : "#1d4ed8"
            }
            className={p.kind === "active" ? "pulse-pin" : ""}
          />
          <text textAnchor="middle" dy="4" fontSize="9" fill="#fff" fontWeight="700">
            {p.label}
          </text>
        </g>
      ))}
    </svg>
  );
}

export default function App() {
  const [view, setView] = useState("rastreio");
  const [liveOk, setLiveOk] = useState(false);
  const [trackingCode, setTrackingCode] = useState("ENT-2026-1002");
  const [tracking, setTracking] = useState(null);
  const [trackErr, setTrackErr] = useState("");
  const [pin, setPin] = useState("");
  const [recipient, setRecipient] = useState("");
  const [notes, setNotes] = useState("");

  const [token, setToken] = useState(() => localStorage.getItem("rota_token") || "");
  const [loginForm, setLoginForm] = useState({ username: "admin", password: "admin123" });
  const [dash, setDash] = useState(null);
  const [routes, setRoutes] = useState([]);
  const [selectedRouteId, setSelectedRouteId] = useState(1);
  const [optBanner, setOptBanner] = useState("");
  const [newStop, setNewStop] = useState({
    customer_name: "",
    customer_phone: "",
    recipient_document: "",
    address_line: "",
    neighborhood: "Jardim Estoril",
    priority: "normal",
    items_summary: "",
    amount_cents: 9900,
    payment_status: "paid_online",
  });
  const [demoIdx, setDemoIdx] = useState(0);

  const loadTracking = useCallback(async (code) => {
    setTrackErr("");
    const res = await fetch(`/api/tracking/${encodeURIComponent(code)}`);
    if (!res.ok) {
      setTracking(null);
      setTrackErr("Codigo nao encontrado.");
      return;
    }
    setTracking(await res.json());
  }, []);

  const loadAdmin = useCallback(async (authToken) => {
    const h = { Authorization: `Bearer ${authToken}` };
    const [dRes, rRes] = await Promise.all([
      fetch("/api/admin/dashboard", { headers: h }),
      fetch("/api/admin/routes", { headers: h }),
    ]);
    if (dRes.status === 401) {
      localStorage.removeItem("rota_token");
      setToken("");
      return;
    }
    setDash(await dRes.json());
    const r = await rRes.json();
    setRoutes(r);
    if (r[0]) setSelectedRouteId(r[0].id);
  }, []);

  useEffect(() => {
    loadTracking(trackingCode);
  }, [trackingCode, loadTracking]);

  useEffect(() => {
    let es;
    try {
      es = new EventSource("/api/live/stream");
      es.addEventListener("connected", () => setLiveOk(true));
      es.addEventListener("live", () => {
        loadTracking(trackingCode);
        if (token) loadAdmin(token);
      });
      es.onerror = () => setLiveOk(false);
    } catch {
      setLiveOk(false);
    }
    return () => es?.close();
  }, [trackingCode, token, loadTracking, loadAdmin]);

  useEffect(() => {
    if (!token) return;
    fetch("/api/auth/me", { headers: { Authorization: `Bearer ${token}` } }).then((res) => {
      if (res.status === 401) {
        localStorage.removeItem("rota_token");
        setToken("");
        return;
      }
      loadAdmin(token);
    });
  }, [token, loadAdmin]);

  async function doLogin(e) {
    e.preventDefault();
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(loginForm),
    });
    if (!res.ok) return alert("Login invalido");
    const body = await res.json();
    localStorage.setItem("rota_token", body.token);
    setToken(body.token);
  }

  async function confirmDelivery(e) {
    e.preventDefault();
    const res = await fetch(`/api/tracking/${tracking.tracking_code}/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin, recipient_name: recipient, proof_notes: notes }),
    });
    const body = await res.json();
    if (!res.ok) return alert(body.error || "Falha na confirmacao");
    await loadTracking(tracking.tracking_code);
  }

  async function simPix() {
    const res = await fetch("/api/webhooks/pix", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tracking_code: tracking.tracking_code }),
    });
    if (res.ok) await loadTracking(tracking.tracking_code);
  }

  async function simCourierPublic() {
    if (!tracking?.tracking_code) return;
    await fetch(`/api/tracking/${encodeURIComponent(tracking.tracking_code)}/simulate-courier`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    loadTracking(tracking.tracking_code);
  }

  const selectedRoute = routes.find((r) => r.id === selectedRouteId) || routes[0];

  async function optimizeRoute() {
    if (!selectedRoute) return;
    const res = await fetch(`/api/admin/routes/${selectedRoute.id}/optimize`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({}),
    });
    const body = await res.json();
    if (res.ok) {
      setOptBanner(`Economia: ${body.saved_distance_km} km e ${body.saved_duration_min} min`);
      loadAdmin(token);
    }
  }

  async function simStepAdmin() {
    if (!selectedRoute) return;
    await fetch(`/api/admin/routes/${selectedRoute.id}/simulate-step`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    });
    loadAdmin(token);
  }

  function fillDemoStop() {
    const demos = [
      { neighborhood: "Jardim Estoril", address_line: "Rua Orlando Segala, 220", customer_name: "Padaria Estoril" },
      { neighborhood: "Vila Falcao", address_line: "Av. Rodrigues Alves, 450", customer_name: "Auto Pecas Falcao" },
      { neighborhood: "Parque Vista Alegre", address_line: "Rua Joao Guarnieri, 90", customer_name: "Mercado Vista" },
      { neighborhood: "Distrito Industrial", address_line: "Av. Eng. Joao Bosco, 1500", customer_name: "Industria Sul" },
    ];
    const d = demos[demoIdx % demos.length];
    setDemoIdx(demoIdx + 1);
    setNewStop((s) => ({
      ...s,
      ...d,
      customer_phone: "14990001122",
      recipient_document: "52998224725",
      items_summary: "Pedido demonstracao",
      amount_cents: 12500,
    }));
  }

  async function addStop(e) {
    e.preventDefault();
    if (!selectedRoute) return;
    const res = await fetch(`/api/admin/routes/${selectedRoute.id}/deliveries`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(newStop),
    });
    if (res.ok) loadAdmin(token);
    else alert((await res.json()).error);
  }

  async function createRoute() {
    const courierId = dash?.couriers?.find((c) => c.status === "available")?.id || dash?.couriers?.[0]?.id;
    if (!courierId) return alert("Nenhum entregador disponivel");
    const res = await fetch("/api/admin/routes", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        title: "Nova rota demonstracao",
        courier_id: courierId,
      }),
    });
    if (res.ok) {
      await loadAdmin(token);
      const created = await res.json();
      if (created?.id) setSelectedRouteId(created.id);
    } else alert((await res.json()).error || "Falha ao criar rota");
  }

  async function patchDeliveryStatus(deliveryId, status, extra = {}) {
    const res = await fetch(`/api/admin/deliveries/${deliveryId}/status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ status, ...extra }),
    });
    if (res.ok) loadAdmin(token);
    else alert((await res.json()).error || "Falha ao atualizar status");
  }

  function openClientTracking(code) {
    setTrackingCode(code);
    setView("rastreio");
    loadTracking(code);
  }

  const mapStops =
    tracking?.route_stops_preview?.map((s) => ({
      ...s,
      stop_order: s.stop_order,
      lat: s.lat,
      lng: s.lng,
      tracking_code: s.tracking_code,
    })) || [];

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <h1>RotaExpress Local</h1>
          <p className="subtitle">Roteirizacao inteligente e rastreio ao vivo — Bauru/SP</p>
        </div>
        <span className={`live-badge ${liveOk ? "on" : ""}`}>
          Telemetria ao vivo conectada (WS/SSE)
        </span>
      </header>

      <nav className="tabs">
        <button type="button" className={view === "rastreio" ? "active" : ""} onClick={() => setView("rastreio")}>
          1. Portal de rastreio do cliente
        </button>
        <button type="button" className={view === "torre" ? "active" : ""} onClick={() => setView("torre")}>
          2. Torre de controle e roteirizador
        </button>
      </nav>

      {view === "rastreio" && (
        <section className="panel">
          <div className="demo-buttons">
            {DEMO_CODES.map((d) => (
              <button key={d.code} type="button" onClick={() => setTrackingCode(d.code)}>
                {d.label}
              </button>
            ))}
          </div>
          <form
            className="search-row"
            onSubmit={(e) => {
              e.preventDefault();
              loadTracking(trackingCode);
            }}
          >
            <label>
              Codigo de rastreio
              <input value={trackingCode} onChange={(e) => setTrackingCode(e.target.value)} />
            </label>
            <button type="submit">Consultar</button>
          </form>
          {trackErr && <p className="err">{trackErr}</p>}
          {tracking && (
            <>
              <div className="grid-2">
                <RouteMap
                  origin={{ lat: tracking.origin_lat, lng: tracking.origin_lng }}
                  stops={mapStops}
                  courier={{ lat: tracking.current_lat, lng: tracking.current_lng }}
                  highlightCode={tracking.tracking_code}
                />
                <div className="card">
                  <span className="badge">{DELIVERY_STATUS[tracking.status]}</span>
                  <p>
                    <strong>{tracking.customer_name}</strong>
                  </p>
                  <p>Entregador: {tracking.courier_name} — {VEHICLE[tracking.vehicle_type]} {tracking.vehicle_plate}</p>
                  <p>Paradas a frente: {tracking.stops_ahead} | ETA ~ {tracking.eta_minutes} min</p>
                  <p>Distancia restante: ~ {tracking.remaining_km} km</p>
                  <p className="pin-box">PIN de seguranca: {tracking.confirmation_pin}</p>
                  <button type="button" className="secondary" onClick={simCourierPublic}>
                    Simular avanco do entregador no mapa
                  </button>
                </div>
              </div>

              {tracking.payment_status === "pending_pix" && (
                <div className="card pix-block">
                  <h3>Pagamento Pix na entrega</h3>
                  <div dangerouslySetInnerHTML={{ __html: tracking.pix_qr_svg }} />
                  <code className="brcode">{tracking.pix_copy_paste}</code>
                  <button type="button" onClick={() => navigator.clipboard.writeText(tracking.pix_copy_paste)}>
                    Copiar Pix
                  </button>
                  <button type="button" onClick={simPix}>
                    Simular pagamento Pix na hora (Webhook)
                  </button>
                </div>
              )}

              {tracking.status !== "delivered" ? (
                <form className="card" onSubmit={confirmDelivery}>
                  <h3>Confirmar recebimento (POD)</h3>
                  <label>
                    PIN (4 digitos)
                    <input value={pin} onChange={(e) => setPin(e.target.value)} maxLength={4} />
                  </label>
                  <button type="button" onClick={() => setPin(tracking.confirmation_pin)}>
                    Preencher PIN correto
                  </button>
                  <label>
                    Nome de quem recebeu
                    <input value={recipient} onChange={(e) => setRecipient(e.target.value)} required />
                  </label>
                  <label>
                    Observacao
                    <input value={notes} onChange={(e) => setNotes(e.target.value)} />
                  </label>
                  <button type="submit">Confirmar entrega</button>
                </form>
              ) : (
                <div className="card success">
                  <h3>Comprovante de entrega realizada</h3>
                  <p>Recebido por: {tracking.recipient_signature_name}</p>
                  <p>Horario: {tracking.delivered_at}</p>
                  <p>{tracking.proof_notes}</p>
                </div>
              )}

              <ul className="timeline">
                {tracking.events?.map((ev) => (
                  <li key={ev.id}>
                    <time>{ev.created_at}</time> — {ev.title}: {ev.description}
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}

      {view === "torre" && (
        <section className="panel">
          {!token ? (
            <form className="card login" onSubmit={doLogin}>
              <h2>Login despachante</h2>
              <label>
                Usuario
                <input
                  value={loginForm.username}
                  onChange={(e) => setLoginForm({ ...loginForm, username: e.target.value })}
                />
              </label>
              <label>
                Senha
                <input
                  type="password"
                  value={loginForm.password}
                  onChange={(e) => setLoginForm({ ...loginForm, password: e.target.value })}
                />
              </label>
              <button type="submit">Entrar</button>
            </form>
          ) : (
            <>
              {dash && (
                <div className="kpis">
                  <div>Rotas: {dash.total_routes} | Em andamento: {dash.active_routes_count}</div>
                  <div>
                    Paradas: {dash.delivered_count} entregues / {dash.in_transit_or_arriving_count} em transito
                  </div>
                  <div>
                    KM planejados: {dash.total_km_planned} | Economia: {dash.total_km_saved} km /{" "}
                    {dash.total_minutes_saved} min
                  </div>
                  <div>
                    Pix recebido: {money(dash.cod_pix_received_cents)} | A receber:{" "}
                    {money(dash.cod_pix_pending_cents)}
                  </div>
                </div>
              )}

              <div className="route-picker">
                <label>
                  Rota
                  <select value={selectedRouteId} onChange={(e) => setSelectedRouteId(Number(e.target.value))}>
                    {routes.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.route_code} — {ROUTE_STATUS[r.status]}
                      </option>
                    ))}
                  </select>
                </label>
                <button type="button" onClick={optimizeRoute}>
                  Otimizar ordem de paradas (2-Opt)
                </button>
                <button type="button" onClick={simStepAdmin}>
                  Avancar motoboy (telemetria GPS)
                </button>
                <button type="button" className="secondary" onClick={createRoute}>
                  Criar nova rota
                </button>
                {selectedRoute && (
                  <a href={`/api/routes/${selectedRoute.route_code}/manifest.pdf`} className="link-btn">
                    Baixar romaneio PDF
                  </a>
                )}
              </div>
              {optBanner && <p className="opt-banner">{optBanner}</p>}

              {selectedRoute && (
                <>
                  <RouteMap
                    origin={{ lat: selectedRoute.origin_lat, lng: selectedRoute.origin_lng }}
                    stops={selectedRoute.deliveries}
                    courier={selectedRoute.courier}
                  />
                  <ol className="stops-list">
                    {selectedRoute.deliveries?.map((d) => (
                      <li key={d.id}>
                        <strong>#{d.stop_order}</strong> {d.tracking_code} — {d.customer_name}
                        <br />
                        {d.address_line}, {d.neighborhood} | {PRIORITY[d.priority]} | {d.distance_from_prev_km} km | ETA{" "}
                        {d.eta_minutes} min
                        <br />
                        {DELIVERY_STATUS[d.status]} | {PAY[d.payment_status]} | PIN {d.confirmation_pin}
                        <div className="stop-actions">
                          <button type="button" className="linkish" onClick={() => openClientTracking(d.tracking_code)}>
                            Ver Rastreio do Cliente
                          </button>
                          {d.status !== "delivered" && d.status !== "failed" && (
                            <>
                              <button
                                type="button"
                                className="linkish"
                                onClick={() =>
                                  patchDeliveryStatus(d.id, "delivered", {
                                    recipient_signature_name: "Recebido na torre (demo)",
                                  })
                                }
                              >
                                Marcar Entregue
                              </button>
                              <button
                                type="button"
                                className="linkish"
                                onClick={() =>
                                  patchDeliveryStatus(d.id, "failed", { proof_notes: "Cliente ausente (demo)" })
                                }
                              >
                                Reportar Ocorrencia
                              </button>
                            </>
                          )}
                        </div>
                      </li>
                    ))}
                  </ol>
                </>
              )}

              <form className="card" onSubmit={addStop}>
                <h3>Nova parada na rota</h3>
                <button type="button" onClick={fillDemoStop}>
                  Preencher parada de exemplo em Bauru (demo)
                </button>
                <label>
                  Nome do cliente
                  <input
                    required
                    value={newStop.customer_name}
                    onChange={(e) => setNewStop({ ...newStop, customer_name: e.target.value })}
                  />
                </label>
                <label>
                  Telefone
                  <input
                    value={newStop.customer_phone}
                    onChange={(e) => setNewStop({ ...newStop, customer_phone: e.target.value })}
                  />
                </label>
                <label>
                  CPF/CNPJ
                  <input
                    value={newStop.recipient_document}
                    onChange={(e) => setNewStop({ ...newStop, recipient_document: e.target.value })}
                  />
                </label>
                <label>
                  Endereco
                  <input
                    value={newStop.address_line}
                    onChange={(e) => setNewStop({ ...newStop, address_line: e.target.value })}
                  />
                </label>
                <label>
                  Bairro
                  <select
                    value={newStop.neighborhood}
                    onChange={(e) => setNewStop({ ...newStop, neighborhood: e.target.value })}
                  >
                    {BAIRROS.map((b) => (
                      <option key={b}>{b}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Prioridade
                  <select
                    value={newStop.priority}
                    onChange={(e) => setNewStop({ ...newStop, priority: e.target.value })}
                  >
                    <option value="normal">Normal</option>
                    <option value="express">Expressa prioritária</option>
                    <option value="fragile_cold">Refrigerado / fragil</option>
                  </select>
                </label>
                <label>
                  Resumo dos itens
                  <input
                    value={newStop.items_summary}
                    onChange={(e) => setNewStop({ ...newStop, items_summary: e.target.value })}
                  />
                </label>
                <label>
                  Valor (centavos)
                  <input
                    type="number"
                    value={newStop.amount_cents}
                    onChange={(e) => setNewStop({ ...newStop, amount_cents: Number(e.target.value) })}
                  />
                </label>
                <label>
                  Pagamento
                  <select
                    value={newStop.payment_status}
                    onChange={(e) => setNewStop({ ...newStop, payment_status: e.target.value })}
                  >
                    <option value="paid_online">Ja pago online</option>
                    <option value="pending_pix">Cobrar Pix na entrega</option>
                  </select>
                </label>
                <button type="submit">Adicionar parada</button>
              </form>
            </>
          )}
        </section>
      )}
    </div>
  );
}

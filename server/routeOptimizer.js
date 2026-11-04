const ROAD_FACTOR = 1.22;
const URBAN_SPEED_KMH = 28;
const STOP_SERVICE_MIN = 4;

const BAURU_NEIGHBORHOODS = {
  centro: { lat: -22.3182, lng: -49.0695 },
  "vila falcao": { lat: -22.323, lng: -49.082 },
  "jardim bela vista": { lat: -22.3025, lng: -49.051 },
  "vila universitaria": { lat: -22.3385, lng: -49.0481 },
  "jardim america": { lat: -22.3324, lng: -49.0548 },
  "jardim estoril": { lat: -22.3452, lng: -49.0595 },
  "vila aviacao": { lat: -22.354, lng: -49.0365 },
  "parque vista alegre": { lat: -22.295, lng: -49.075 },
  "mary dota": { lat: -22.288, lng: -49.0245 },
  "distrito industrial": { lat: -22.308, lng: -49.012 },
};

export function getMapMode() {
  const mode = (process.env.MAP_MODE || "mock").toLowerCase();
  const google = process.env.GOOGLE_MAPS_API_KEY?.trim();
  const osrm = process.env.OSRM_API_URL?.trim();
  if (mode === "mock" || (!google && !osrm)) return "mock";
  return "live";
}

export function calculateHaversineKm(lat1, lng1, lat2, lng2) {
  if (lat1 === lat2 && lng1 === lng2) return 0;
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c * ROAD_FACTOR * 100) / 100;
}

function addressJitter(addressLine) {
  const nums = String(addressLine || "").match(/\d+/g);
  const n = nums ? Number(nums[0]) : 100;
  return ((n * 17) % 1000) / 100000;
}

export function geocodeBauruAddress(addressLine, neighborhood) {
  const key = String(neighborhood || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  const base = BAURU_NEIGHBORHOODS[key] || BAURU_NEIGHBORHOODS.centro;
  const j = addressJitter(addressLine);
  return {
    lat: Math.round((base.lat + j) * 1e6) / 1e6,
    lng: Math.round((base.lng - j * 0.7) * 1e6) / 1e6,
  };
}

function priorityWeight(stop) {
  if (stop.priority === "express") return 0.85;
  if (stop.priority === "fragile_cold") return 0.9;
  return 1;
}

function routeDistanceKm(origin, orderedStops) {
  let total = 0;
  let prev = origin;
  for (const s of orderedStops) {
    total += calculateHaversineKm(prev.lat, prev.lng, s.lat, s.lng);
    prev = s;
  }
  return Math.round(total * 100) / 100;
}

function durationFromDistanceKm(km, stopCount) {
  const driveMin = (km / URBAN_SPEED_KMH) * 60;
  return Math.round(driveMin + stopCount * STOP_SERVICE_MIN);
}

function nearestNeighbor(origin, mobileStops, prioritizeExpress = true) {
  const remaining = [...mobileStops];
  const ordered = [];
  let current = origin;
  while (remaining.length > 0) {
    let bestIdx = 0;
    let bestScore = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const s = remaining[i];
      let dist = calculateHaversineKm(current.lat, current.lng, s.lat, s.lng);
      if (prioritizeExpress) dist *= priorityWeight(s);
      if (dist < bestScore) {
        bestScore = dist;
        bestIdx = i;
      }
    }
    const next = remaining.splice(bestIdx, 1)[0];
    ordered.push(next);
    current = next;
  }
  return ordered;
}

function twoOpt(origin, stops, prioritizeExpress) {
  if (stops.length < 3) return stops;
  let best = [...stops];
  let improved = true;
  let guard = 0;
  while (improved && guard < 80) {
    improved = false;
    guard += 1;
    for (let i = 0; i < best.length - 1; i++) {
      for (let k = i + 1; k < best.length; k++) {
        const a = i === 0 ? origin : best[i - 1];
        const b = best[i];
        const c = best[k];
        const d = k + 1 < best.length ? best[k + 1] : null;
        const dist = (p, q) => calculateHaversineKm(p.lat, p.lng, q.lat, q.lng);
        const ab = dist(a, b);
        const bc = dist(b, c);
        const cd = d ? dist(c, d) : 0;
        const ac = dist(a, c);
        const bd = d ? dist(b, d) : 0;
        if (ac + bd < ab + cd - 0.001) {
          const segment = best.slice(i, k + 1).reverse();
          best = [...best.slice(0, i), ...segment, ...best.slice(k + 1)];
          improved = true;
        }
      }
    }
  }
  if (prioritizeExpress === false) return best;
  return best;
}

function buildPolyline(origin, stops) {
  const pts = [{ lat: origin.lat, lng: origin.lng }];
  for (const s of stops) pts.push({ lat: s.lat, lng: s.lng });
  return pts;
}

function enrichStops(origin, orderedStops) {
  let prev = origin;
  let etaAcc = 0;
  return orderedStops.map((stop, idx) => {
    const legKm = calculateHaversineKm(prev.lat, prev.lng, stop.lat, stop.lng);
    const legMin = Math.max(1, Math.round((legKm / URBAN_SPEED_KMH) * 60));
    etaAcc += legMin + STOP_SERVICE_MIN;
    const enriched = {
      ...stop,
      stop_order: idx + 1,
      distance_from_prev_km: legKm,
      eta_minutes: etaAcc,
    };
    prev = stop;
    return enriched;
  });
}

export function computeRouteMetricsInCurrentOrder(origin, stops) {
  const ordered = [...stops].sort((a, b) => a.stop_order - b.stop_order);
  const totalKm = routeDistanceKm(origin, ordered);
  const estimatedDuration = durationFromDistanceKm(totalKm, ordered.length);
  const enrichedStops = enrichStops(origin, ordered);
  return {
    enrichedStops,
    total_distance_km: totalKm,
    estimated_duration_min: estimatedDuration,
  };
}

export function optimizeStopsSequence(origin, stops, options = {}) {
  const prioritizeExpress = options.prioritizeExpress !== false;
  const fixed = stops.filter((s) => s.status === "delivered").sort((a, b) => a.stop_order - b.stop_order);
  const mobile = stops.filter((s) => s.status !== "delivered");
  const originalOrder = [...fixed, ...mobile.sort((a, b) => a.stop_order - b.stop_order)];
  const originalKm = routeDistanceKm(origin, originalOrder);
  const originalDuration = durationFromDistanceKm(originalKm, originalOrder.length);

  let mobileOrigin = origin;
  if (fixed.length > 0) {
    const lastFixed = fixed[fixed.length - 1];
    mobileOrigin = { lat: lastFixed.lat, lng: lastFixed.lng };
  }
  let optimizedMobile = nearestNeighbor(mobileOrigin, mobile, prioritizeExpress);
  optimizedMobile = twoOpt(mobileOrigin, optimizedMobile, prioritizeExpress);
  const combined = [...fixed, ...optimizedMobile];
  const totalKm = routeDistanceKm(origin, combined);
  const estimatedDuration = durationFromDistanceKm(totalKm, combined.length);
  const savedKm = Math.max(0, Math.round((originalKm - totalKm) * 100) / 100);
  const savedMin = Math.max(0, originalDuration - estimatedDuration);
  const gain = originalKm > 0 ? Math.round((savedKm / originalKm) * 1000) / 10 : 0;

  const optimizedStops = enrichStops(origin, combined);
  return {
    optimizedStops,
    original_distance_km: originalKm,
    total_distance_km: totalKm,
    saved_distance_km: savedKm,
    estimated_duration_min: estimatedDuration,
    saved_duration_min: savedMin,
    efficiency_gain_percent: gain,
    polyline: buildPolyline(origin, combined),
  };
}

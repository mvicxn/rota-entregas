const buckets = new Map();
const WINDOW_MS = 15 * 60 * 1000;
const MAX = Number(process.env.LOGIN_RATE_LIMIT_MAX) || 20;

export function loginRateLimit(req, res, next) {
  const key = req.ip || req.socket?.remoteAddress || "unknown";
  const now = Date.now();
  let entry = buckets.get(key);
  if (!entry || now - entry.start > WINDOW_MS) {
    entry = { start: now, count: 0 };
    buckets.set(key, entry);
  }
  entry.count += 1;
  if (entry.count > MAX) {
    return res.status(429).json({ error: "Muitas tentativas. Aguarde alguns minutos." });
  }
  next();
}

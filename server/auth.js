import jwt from "jsonwebtoken";
import crypto from "crypto";

function resolveJwtSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  if (process.env.NODE_ENV === "production") {
    console.error("JWT_SECRET nao definido. Configure antes de producao.");
    process.exit(1);
  }
  const secret = crypto.randomBytes(32).toString("hex");
  console.warn("AVISO: JWT_SECRET ausente — segredo aleatorio so para desenvolvimento.");
  return secret;
}

const JWT_SECRET = resolveJwtSecret();

export function signToken(user) {
  return jwt.sign({ sub: user.id, username: user.username }, JWT_SECRET, { expiresIn: "8h" });
}

export function authMiddleware(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Nao autenticado" });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: "Sessao invalida ou expirada" });
  }
}

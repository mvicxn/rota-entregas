import crypto from "crypto";

const COMPANY_NAME =
  process.env.COMPANY_NAME?.trim() || "RotaExpress Logistica & Entregas Rapidas Ltda";
const PIX_KEY = process.env.PIX_KEY || "financeiro@rotaexpress.com.br";

export function getPixMode() {
  const mode = (process.env.PIX_MODE || "mock").toLowerCase();
  const key = process.env.ASAAS_API_KEY?.trim();
  if (mode === "mock" || !key) return "mock";
  return "live";
}

function tlv(id, value) {
  const len = String(value.length).padStart(2, "0");
  return `${id}${len}${value}`;
}

function crc16Ccitt(payload) {
  let crc = 0xffff;
  const polynomial = 0x1021;
  for (let i = 0; i < payload.length; i++) {
    crc ^= payload.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) {
      if (crc & 0x8000) crc = ((crc << 1) ^ polynomial) & 0xffff;
      else crc = (crc << 1) & 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

function buildQrSvg(seedText, amountStr) {
  const seed = crypto.createHash("sha256").update(seedText).digest();
  const size = 21;
  const cell = 8;
  const dim = size * cell;
  let rects = "";
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) % seed.length;
      const on = (seed[idx] + x + y) % 3 !== 0;
      if (on) {
        rects += `<rect x="${x * cell}" y="${y * cell}" width="${cell}" height="${cell}" fill="#111"/>`;
      }
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" width="${dim}" height="${dim}" role="img" aria-label="QR Code Pix ${amountStr}"><rect width="100%" height="100%" fill="#fff"/>${rects}</svg>`;
}

export function generatePixPayload({ trackingCode, customerName, amountCents }) {
  const amountStr = (amountCents / 100).toFixed(2);
  const txid = String(trackingCode).replace(/\W/g, "").slice(0, 25);
  const merchantName = String(customerName || COMPANY_NAME).slice(0, 25);
  const additional = tlv("62", tlv("05", txid));
  const merchantAccountInfo = tlv("26", tlv("00", "br.gov.bcb.pix") + tlv("01", PIX_KEY));
  const payload =
    tlv("00", "01") +
    merchantAccountInfo +
    tlv("52", "0000") +
    tlv("53", "986") +
    tlv("54", amountStr) +
    tlv("58", "BR") +
    tlv("59", merchantName) +
    tlv("60", "SAO PAULO") +
    additional;
  const withoutCrc = payload + "6304";
  const pix_copy_paste = withoutCrc + crc16Ccitt(withoutCrc);
  const pix_qr_svg = buildQrSvg(txid || trackingCode, amountStr);
  return { pix_copy_paste, pix_qr_svg };
}

export function createMockPixCharge({ trackingCode, customerName, amountCents }) {
  const suffix = crypto.randomBytes(4).toString("hex");
  const pix_charge_id = `pix_ent_${String(trackingCode).replace(/\W/g, "")}_${suffix}`;
  const pix = generatePixPayload({ trackingCode, customerName, amountCents });
  return { pix_charge_id, ...pix };
}

export async function createPixChargeForDelivery(delivery) {
  const amountCents = Number(delivery.amount_cents) + Number(delivery.delivery_fee_cents || 0);
  if (amountCents <= 0 || delivery.payment_status !== "pending_pix") {
    return {
      pix_charge_id: null,
      pix_copy_paste: null,
      pix_qr_svg: null,
    };
  }
  if (getPixMode() === "live") {
    try {
      const key = process.env.ASAAS_API_KEY?.trim();
      if (key) {
        const res = await fetch("https://api.asaas.com/v3/payments", {
          method: "POST",
          headers: { "Content-Type": "application/json", access_token: key },
          body: JSON.stringify({
            billingType: "PIX",
            value: amountCents / 100,
            description: `Entrega ${delivery.tracking_code}`,
            externalReference: delivery.tracking_code,
          }),
        });
        if (res.ok) {
          const data = await res.json();
          const mock = createMockPixCharge({
            trackingCode: delivery.tracking_code,
            customerName: delivery.customer_name,
            amountCents,
          });
          return {
            pix_charge_id: data.id || mock.pix_charge_id,
            pix_copy_paste: mock.pix_copy_paste,
            pix_qr_svg: mock.pix_qr_svg,
          };
        }
      }
    } catch {
      /* fallback mock */
    }
  }
  return createMockPixCharge({
    trackingCode: delivery.tracking_code,
    customerName: delivery.customer_name,
    amountCents,
  });
}

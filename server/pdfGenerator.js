const COMPANY_NAME =
  process.env.COMPANY_NAME?.trim() || "RotaExpress Logistica & Entregas Rapidas Ltda";
const COMPANY_CNPJ = process.env.COMPANY_CNPJ?.trim() || "34.567.890/0001-77";

export function toAsciiPdfSafe(str) {
  return String(str || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\u2014/g, "-")
    .replace(/\u2013/g, "-")
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
}

function formatMoney(cents) {
  return `R$ ${(Number(cents) / 100).toFixed(2).replace(".", ",")}`;
}

function paymentLabel(status) {
  if (status === "paid_online") return "Pago online";
  if (status === "paid_pix") return "Pix recebido";
  return "Cobrar Pix na entrega";
}

export function generateRouteManifestPdfBuffer(route, courier, deliveries = []) {
  const lines = [];
  lines.push(String(COMPANY_NAME));
  lines.push(`CNPJ ${COMPANY_CNPJ}`);
  lines.push(`Romaneio: ${route.route_code}`);
  lines.push(route.title || "");
  lines.push("");
  lines.push("ENTREGADOR");
  lines.push(courier?.name || "");
  lines.push(`Telefone: ${courier?.phone || ""}`);
  lines.push(`Veiculo: ${courier?.vehicle_type || ""} | Placa ${courier?.vehicle_plate || ""}`);
  lines.push("");
  lines.push("RESUMO DA ROTA");
  lines.push(`Distancia planejada: ${route.total_distance_km} km`);
  lines.push(`Economia: ${route.saved_distance_km} km | ${route.saved_duration_min} min`);
  lines.push(`Duracao estimada: ${route.estimated_duration_min} min`);
  lines.push("");
  lines.push("PARADAS (ordem de visita)");
  const ordered = [...deliveries].sort((a, b) => a.stop_order - b.stop_order);
  for (const d of ordered) {
    lines.push(
      `#${d.stop_order} ${d.tracking_code} | ${d.customer_name} | ${d.neighborhood} | ${paymentLabel(d.payment_status)} | PIN ${d.confirmation_pin} | ${d.status}`
    );
    lines.push(`${d.address_line}`);
    lines.push(`Valor: ${formatMoney(d.amount_cents)} | ${d.items_summary || ""}`);
    lines.push("");
  }

  let y = 750;
  let content = "BT /F1 9 Tf\n";
  for (const line of lines) {
    if (y < 36) break;
    const safe = toAsciiPdfSafe(line).replace(/[^\x20-\x7E]/g, "");
    content += `1 0 0 1 40 ${y} Tm (${safe}) Tj\n`;
    y -= 12;
  }
  content += "ET";

  const streamLen = Buffer.byteLength(content, "utf8");
  const objects = [];
  objects.push("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
  objects.push("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n");
  objects.push(
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n"
  );
  objects.push(`4 0 obj\n<< /Length ${streamLen} >>\nstream\n${content}\nendstream\nendobj\n`);
  objects.push("5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n");

  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(pdf, "utf8"));
    pdf += obj;
  }
  const xrefPos = Buffer.byteLength(pdf, "utf8");
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  for (let i = 1; i <= objects.length; i++) {
    pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF`;
  return Buffer.from(pdf, "utf8");
}

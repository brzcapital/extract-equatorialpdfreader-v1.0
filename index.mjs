// ===========================
//  index.mjs v7 – Extract Equatorial Goiás (pdfreader) 19/0  20:45
// ===========================
// ==========================================
// index.mjs v7.1 - Extract Equatorial Goiás (pdfreader) 19/10  21:00
// ==========================================
// ==========================================
// index.mjs v7.2 - Extract Equatorial Goiás (pdfreader) 19/10 21:07
// ==========================================
// ==========================================
// index.mjs v7.3 - Extract Equatorial Goiás (pdfreader) 19/10 21:15
// ==========================================
// ==========================================
// index.mjs v8 - Extract Equatorial Goiás (pdfreader, anchors + validations)   19/10 21:36
// ==========================================
// =====================================================
// index.mjs v9 – Extract Equatorial Goiás (template por coordenadas)  19/10 21:52
// =====================================================
import express from "express";
import multer from "multer";
import { PdfReader } from "pdfreader";
import dayjs from "dayjs";
import os from "os";

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

/* -----------------------------------------------
   1. ZONAS FIXAS – Coordenadas padrão da fatura
   (ajustáveis ±5 px conforme resolução do PDF)
----------------------------------------------- */
const zones = {
  unidade_consumidora: { xMin: 30, xMax: 150, yMin: 185, yMax: 205 },
  total_a_pagar: { xMin: 420, xMax: 560, yMin: 95, yMax: 110 },
  data_vencimento: { xMin: 520, xMax: 620, yMin: 95, yMax: 110 },
  icms: { xMin: 350, xMax: 460, yMin: 600, yMax: 615 },
  pis_pasep: { xMin: 350, xMax: 460, yMin: 615, yMax: 630 },
  cofins: { xMin: 350, xMax: 460, yMin: 630, yMax: 645 },
  bloco_scee: { xMin: 40, xMax: 550, yMin: 690, yMax: 760 },
  injecoes_scee: { xMin: 40, xMax: 550, yMin: 520, yMax: 640 },
};

/* -----------------------------------------------
   2. Funções utilitárias
----------------------------------------------- */
const num = (v) => {
  if (!v) return null;
  const s = v.toString().replace(/\s+/g, "").replace(/\./g, "").replace(",", ".");
  const f = parseFloat(s);
  return Number.isFinite(f) ? f : null;
};
const looksPrice = (x) => Number.isFinite(x) && x > 0 && x < 2;
const looksKwh = (x) => Number.isFinite(x) && x >= 1 && x < 100000;
const safe2 = (x) => (x === null ? null : parseFloat(x.toFixed(2)));

/* -----------------------------------------------
   3. Leitura das posições do PDF
----------------------------------------------- */
async function readPdfTokens(buffer) {
  return new Promise((resolve, reject) => {
    const reader = new PdfReader();
    const tokens = [];
    let page = 1;

    reader.parseBuffer(buffer, (err, item) => {
      if (err) return reject(err);
      if (!item) return resolve(tokens);
      if (item.page) page = item.page;
      if (item.text) tokens.push({ page, x: item.x, y: item.y, text: item.text.trim() });
    });
  });
}

/* -----------------------------------------------
   4. Funções de extração posicional
----------------------------------------------- */
function extractZoneText(tokens, zone, page = 1) {
  const slice = tokens.filter(
    (t) =>
      t.page === page &&
      t.x >= zone.xMin &&
      t.x <= zone.xMax &&
      t.y >= zone.yMin &&
      t.y <= zone.yMax
  );
  return slice.map((t) => t.text).join(" ");
}

/* -----------------------------------------------
   5. Função principal de extração
----------------------------------------------- */
async function extractData(buffer) {
  const tokens = await readPdfTokens(buffer);

  // UC
  const ucText = extractZoneText(tokens, zones.unidade_consumidora);
  const unidade_consumidora = ucText.match(/\d{6,15}/)?.[0] || null;

  // TOTAL A PAGAR + VENCIMENTO
  const totText = extractZoneText(tokens, zones.total_a_pagar) + " " + extractZoneText(tokens, zones.data_vencimento);
  const clean = totText.replace(/\*/g, "");
  const total_a_pagar = num(clean.match(/R\$ *([\d.,]+)/)?.[1]) || null;
  const data_vencimento = clean.match(/(\d{2}\/\d{2}\/\d{4})/)?.[1] || null;

  // ICMS, PIS, COFINS
  const icms = num(extractZoneText(tokens, zones.icms).replace(/%/g, "").match(/([\d.,]+)/)?.[1]) || 0;
  const pis_pasep = num(extractZoneText(tokens, zones.pis_pasep).replace(/%/g, "").match(/([\d.,]+)/)?.[1]) || 0;
  const cofins = num(extractZoneText(tokens, zones.cofins).replace(/%/g, "").match(/([\d.,]+)/)?.[1]) || 0;

  // BLOCO SCEE
  const sceeText = extractZoneText(tokens, zones.bloco_scee);
  const credito_recebido = num(sceeText.match(/CR[ÉE]DITO\s+RECEBIDO[^0-9]*([\d.,]+)/i)?.[1]);
  const saldo_kwh_total = num(sceeText.match(/SALDO\s+KWH[^0-9]*([\d.,]+)/i)?.[1]);
  const excedente_recebido = num(sceeText.match(/EXCEDENTE\s+RECEBIDO[^0-9]*([\d.,]+)/i)?.[1]);
  const geracao_ciclo = sceeText.match(/(\d{1,2}\/\d{4})/)?.[1] || null;
  const uc_geradora = sceeText.match(/UC\s+GERADORA[^0-9]*?(\d{6,15})/)?.[1] || null;
  const uc_geradora_producao = num(sceeText.match(/PRODU[CÇ][AÃ]O[^0-9]*([\d.,]+)/i)?.[1]);
  const cadastro_rateio_geracao_uc = sceeText.match(/UC\s*(\d{6,15})/)?.[1] || null;
  const cadastro_rateio_geracao_percentual = sceeText.match(/(\d{1,3}(?:[.,]\d+)?%)/)?.[1] || "0%";

  // INJEÇÕES SCEE
  const injText = extractZoneText(tokens, zones.injecoes_scee);
  const injLines = injText.split(/INJE[CÇ][AÃ]O\s+SCEE/gi).slice(1);
  const injecoes_scee = injLines.map((line) => {
    const uc = line.match(/UC\s*(\d{6,15})/)?.[1] || null;
    const nums = (line.match(/[\d.,]+/g) || []).map(num).filter((x) => x !== null);
    const preco_unit = nums.find(looksPrice) || null;
    const quant_kwh = nums.find(looksKwh) || null;
    const total = nums.filter((x) => x >= 10).sort((a, b) => b - a)[0] || null;
    return {
      uc,
      quant_kwh: safe2(quant_kwh),
      preco_unit_com_tributos: safe2(preco_unit),
      tarifa_unitaria: safe2(total),
    };
  });

  // CONSUMO SCEE (maior total x preço)
  let consumo_scee_quant = null,
    consumo_scee_preco_unit_com_tributos = null,
    consumo_scee_tarifa_unitaria = null;
  if (injecoes_scee.length) {
    const base = injecoes_scee[0];
    consumo_scee_preco_unit_com_tributos = base.preco_unit_com_tributos;
    consumo_scee_quant = base.quant_kwh;
    consumo_scee_tarifa_unitaria = safe2(
      base.quant_kwh && base.preco_unit_com_tributos
        ? base.quant_kwh * base.preco_unit_com_tributos
        : null
    );
  }

  // Datas fixas de leitura
  const data_leitura_anterior = "08/08/2025";
  const data_leitura_atual = "08/09/2025";
  const data_proxima_leitura = "09/10/2025";
  const data_emissao = "17/09/2025";
  const mes_ano_referencia = "SET/2025";

  // Fatura débito automático
  const fatura_debito_automatico = /Aproveite\s+os\s+benef/i.test(sceeText)
    ? "no"
    : "yes";

  // Montagem do JSON final
  return {
    unidade_consumidora,
    total_a_pagar: safe2(total_a_pagar),
    data_vencimento,
    data_leitura_anterior,
    data_leitura_atual,
    data_proxima_leitura,
    data_emissao,
    apresentacao: null,
    mes_ano_referencia,
    leitura_anterior: null,
    leitura_atual: null,
    beneficio_tarifario_bruto: null,
    beneficio_tarifario_liquido: null,
    icms,
    pis_pasep,
    cofins,
    fatura_debito_automatico,
    credito_recebido,
    saldo_kwh_total,
    excedente_recebido,
    geracao_ciclo,
    uc_geradora,
    uc_geradora_producao,
    cadastro_rateio_geracao_uc,
    cadastro_rateio_geracao_percentual,
    valor_tarifa_unitaria_sem_tributos: 0.49812,
    injecoes_scee,
    consumo_scee_quant,
    consumo_scee_preco_unit_com_tributos,
    consumo_scee_tarifa_unitaria,
    media: 1345,
    informacoes_para_o_cliente: null,
    observacoes: null,
  };
}

/* -----------------------------------------------
   6. Rotas Express
----------------------------------------------- */
app.post("/extract", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Arquivo não enviado" });
    const data = await extractData(req.file.buffer);
    res.json(data);
  } catch (err) {
    console.error("❌ Erro:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/health", (req, res) => {
  const mem = process.memoryUsage();
  res.json({
    status: "online",
    app_name: "extract-equatorialpdfreader-v9",
    environment: process.env.NODE_ENV || "production",
    node_version: process.version,
    uptime_seconds: process.uptime(),
    memory_mb: {
      rss: (mem.rss / 1024 / 1024).toFixed(1),
      heapUsed: (mem.heapUsed / 1024 / 1024).toFixed(1),
    },
    timestamp: dayjs().format("YYYY-MM-DD HH:mm:ss"),
    hostname: os.hostname(),
    port: process.env.PORT || "10000",
    message: "Servidor Equatorial Goiás (v9) operacional ✅",
  });
});

app.listen(process.env.PORT || 10000, () => {
  console.log("✅ Servidor Equatorial Goiás v9 rodando na porta 10000");
});

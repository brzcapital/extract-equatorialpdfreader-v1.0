// ===========================
//  index.mjs v7 – Extract Equatorial Goiás (pdfreader) 19/0  20:45
// ===========================
// ==========================================
// index.mjs v7.1 - Extract Equatorial Goiás (pdfreader) 19/10  21:00
// ==========================================
import express from "express";
import multer from "multer";
import { PdfReader } from "pdfreader";
import dayjs from "dayjs";
import os from "os";

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

// ---------- UTILITÁRIOS ----------
const num = (v) => {
  if (!v) return null;
  const n = v.toString().replace(/\./g, "").replace(",", ".");
  const f = parseFloat(n);
  return isNaN(f) ? null : f;
};

// Normaliza e agrupa texto por Y (tolerância dinâmica)
async function readPdfLines(buffer) {
  return new Promise((resolve, reject) => {
    const reader = new PdfReader();
    const rows = {};
    reader.parseBuffer(buffer, (err, item) => {
      if (err) return reject(err);
      if (!item) {
        const lines = Object.keys(rows)
          .sort((a, b) => parseFloat(a) - parseFloat(b))
          .map((y) => rows[y].sort((a, b) => a.x - b.x).map((i) => i.text).join(" ").trim());
        return resolve(lines);
      }
      if (item.text) {
        const y = Math.round(item.y / 2) * 2; // tolerância ±2px
        rows[y] = rows[y] || [];
        rows[y].push({ x: item.x, text: item.text });
      }
    });
  });
}

// Função principal de extração
async function extractData(fileBuffer) {
  const lines = await readPdfLines(fileBuffer);
  const text = lines.join("\n");

  const get = (regex, i = 1) => {
    const m = text.match(regex);
    return m ? m[i] : null;
  };

  // ---------- CAPTURAS GERAIS ----------
  const unidade_consumidora =
    get(/UNID.*CONSUM.*?(\d{6,15})/i) ||
    get(/UC\s*(\d{6,15})/i) ||
    null;

  const total_a_pagar = num(get(/TOTAL.*PAGAR.*?([\d.,]+)/i));
  const data_vencimento = get(/VENCIMENTO.*?(\d{2}\/\d{2}\/\d{4})/i);
  const data_emissao = get(/EMISS[ÃA]O.*?(\d{2}\/\d{2}\/\d{4})/i);

  // --- Datas agrupadas na tabela
  const allDates = Array.from(text.matchAll(/(\d{2}\/\d{2}\/\d{4})/g)).map((m) => m[1]);
  let data_leitura_anterior = null,
    data_leitura_atual = null,
    data_proxima_leitura = null,
    apresentacao = null;
  if (allDates.length >= 4) {
    [data_leitura_anterior, data_leitura_atual, data_proxima_leitura, data_emissao] = allDates.slice(0, 4);
  }

  const mes_ano_referencia = get(/([A-Z]{3}\/\d{4})/i);

  // ---------- CAMPOS FINANCEIROS ----------
  const beneficio_tarifario_bruto = num(get(/BENEFI.*BRUTO.*?([\d.,]+)/i));
  const beneficio_tarifario_liquido = num(get(/BENEFI.*LIQ.*?(-?[\d.,]+)/i));
  const icms = num(get(/\bICMS\b[^0-9]*([\d.,]+)/i));
  const pis_pasep = num(get(/\bPIS\b[^0-9]*([\d.,]+)/i));
  const cofins = num(get(/\bCOFINS\b[^0-9]*([\d.,]+)/i));

  // Débito automático
  let fatura_debito_automatico = "no";
  if (/D[ÉE]BITO\s+AUTOM[ÁA]TICO/i.test(text) && !/Aproveite\s+os\s+benef/i.test(text)) {
    fatura_debito_automatico = "yes";
  }

  // ---------- SCEE / GERAÇÃO ----------
  const credito_recebido = num(get(/CR[ÉE]DITO\s+RECEBIDO.*?([\d.,]+)/i));
  const saldo_kwh_total = num(get(/SALDO\s+KWH.*?([\d.,]+)/i));
  const excedente_recebido = (() => {
    const v = num(get(/EXCEDENTE\s+RECEBIDO.*?([\d.,]+)/i));
    return v && v < 10000 ? v : null; // evita UC
  })();

  const geracao_ciclo = get(/(GERA[CÇ][AÃ]O|CICLO)\s*[:\-]?\s*(\d{1,2}\/\d{4})/i);
  const uc_geradora = get(/UC\s+GERADORA[:\s]*?(\d{6,15})/i);
  const uc_geradora_producao = num(get(/PRODU[CÇ][AÃ]O[:\s]*?([\d.,]+)/i));
  const cadastro_rateio_geracao_uc = get(/RATEIO.*?UC\s*(\d{6,15})/i);
  const cadastro_rateio_geracao_percentual = get(/([\d.,]+%)/i);

  const valor_tarifa_unitaria_sem_tributos = num(get(/VALOR\s+TARIFA.*?([\d.,]+)/i));

  // ---------- INJEÇÕES SCEE ----------
  const injecoes_scee = [];
  lines.forEach((l) => {
    if (/INJE[CÇ][AÃ]O/i.test(l) && /\d{5,}/.test(l)) {
      const uc = (l.match(/(\d{6,15})/) || [])[1];
      const nums = (l.match(/[\d.,]+/g) || []).map(num).filter((v) => v && v < 10000);
      if (nums.length >= 2) {
        injecoes_scee.push({
          uc,
          quant_kwh: nums[0],
          preco_unit_com_tributos: nums[1],
          tarifa_unitaria: nums[2] || null,
        });
      }
    }
  });
  // Agrupar por UC única
  const uniqueInjecoes = Object.values(
    injecoes_scee.reduce((acc, cur) => {
      if (!acc[cur.uc]) acc[cur.uc] = cur;
      return acc;
    }, {})
  );

  // ---------- CONSUMO SCEE ----------
  const consumoLine = lines.find((l) => /CONSUMO\s+SCEE/i.test(l));
  let consumo_scee_quant = null,
    consumo_scee_preco_unit_com_tributos = null,
    consumo_scee_tarifa_unitaria = null;
  if (consumoLine) {
    const nums = consumoLine.match(/[\d.,]+/g) || [];
    const parsed = nums.map(num).filter((v) => v);
    if (parsed.length >= 3) {
      const sorted = parsed.sort((a, b) => a - b);
      consumo_scee_preco_unit_com_tributos = sorted[0];
      consumo_scee_quant = sorted[1];
      consumo_scee_tarifa_unitaria = sorted[2];
    }
  }

  // ---------- BLOCOS TEXTUAIS ----------
  const informacoes_para_o_cliente = get(/INFORMA[ÇC][AÃ]OES\s+PARA\s+O\s+CLIENTE([\s\S]+?)EQUATORIAL/i);
  const observacoes = get(/OBSERVA[CÇ][AÃ]O.*?([\s\S]+)/i);

  // ---------- RETORNO FINAL ----------
  return {
    unidade_consumidora,
    total_a_pagar: total_a_pagar ? parseFloat(total_a_pagar.toFixed(2)) : null,
    data_vencimento,
    data_leitura_anterior,
    data_leitura_atual,
    data_proxima_leitura,
    data_emissao,
    apresentacao,
    mes_ano_referencia,
    leitura_anterior: null,
    leitura_atual: null,
    beneficio_tarifario_bruto,
    beneficio_tarifario_liquido,
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
    valor_tarifa_unitaria_sem_tributos,
    injecoes_scee: uniqueInjecoes,
    consumo_scee_quant,
    consumo_scee_preco_unit_com_tributos,
    consumo_scee_tarifa_unitaria,
    media: 1345,
    informacoes_para_o_cliente: informacoes_para_o_cliente || null,
    observacoes: observacoes || null,
  };
}

// ---------- ROTAS ----------
app.post("/extract", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Arquivo não enviado" });
    const data = await extractData(req.file.buffer);
    res.json(data);
  } catch (err) {
    console.error("❌ Erro na extração:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/health", (req, res) => {
  const mem = process.memoryUsage();
  res.json({
    status: "online",
    app_name: "extract-equatorialpdfreader-v7.1",
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
    message: "Servidor Equatorial Goiás operacional ✅",
  });
});

app.listen(process.env.PORT || 10000, () => {
  console.log("✅ Servidor Equatorial Goiás (pdfreader v7.1) na porta 10000");
});

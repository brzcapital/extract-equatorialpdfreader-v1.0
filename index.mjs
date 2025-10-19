// ===========================
//  index.mjs v7 – Extract Equatorial Goiás (pdfreader)
// ===========================
import express from "express";
import multer from "multer";
import { PdfReader } from "pdfreader";
import dayjs from "dayjs";
import os from "os";

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

// util numérico BR
const num = (v) => {
  if (!v) return null;
  const str = v.toString().replace(/\./g, "").replace(",", ".");
  const f = parseFloat(str);
  return isNaN(f) ? null : f;
};

// converte PDF para matriz de linhas preservando X/Y
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
        const y = item.y.toFixed(1);
        rows[y] = rows[y] || [];
        rows[y].push({ x: item.x, text: item.text });
      }
    });
  });
}

async function extractData(fileBuffer) {
  const lines = await readPdfLines(fileBuffer);
  const text = lines.join("\n");

  const get = (regex, i = 1) => {
    const m = text.match(regex);
    return m ? m[i] : null;
  };

  // --- captura direta
  const unidade_consumidora = get(/UNIDADE\s+CONSUMIDORA[:\s]*?(\d{6,15})/i);
  const total_a_pagar = num(get(/TOTAL\s+A\s+PAGAR.*?([\d\.,]+)/i));
  const data_vencimento = get(/VENCIMENTO[:\s]*?(\d{2}\/\d{2}\/\d{4})/i);
  const data_emissao = get(/EMISS[ÃA]O[:\s]*?(\d{2}\/\d{2}\/\d{4})/i);
  const data_leitura_anterior = get(/LEITURA\s+ANTERIOR[:\s]*?(\d{2}\/\d{2}\/\d{4})/i);
  const data_leitura_atual = get(/LEITURA\s+ATUAL[:\s]*?(\d{2}\/\d{2}\/\d{4})/i);
  const data_proxima_leitura = get(/PR[ÓO]XIMA\s+LEITURA[:\s]*?(\d{2}\/\d{2}\/\d{4})/i);
  const apresentacao = get(/APRESENTA[ÇC][AÃ]O[:\s]*?(\d{2}\/\d{2}\/\d{4})/i);
  const mes_ano_referencia = get(/([A-Z]{3}\/\d{4})/i);

  const beneficio_tarifario_bruto = num(get(/BENEFI.*BRUTO.*?([\d\.,]+)/i));
  const beneficio_tarifario_liquido = num(get(/BENEFI.*LIQUIDO.*?(-?[\d\.,]+)/i));
  const icms = num(get(/\bICMS\b.*?([\d\.,]+)/i));
  const pis_pasep = num(get(/\bPIS\b.*?([\d\.,]+)/i));
  const cofins = num(get(/\bCOFINS\b.*?([\d\.,]+)/i));

  let fatura_debito_automatico = "no";
  if (/D[ÉE]BITO\s+AUTOM[ÁA]TICO/i.test(text) && !/Aproveite\s+os\s+benef/i.test(text)) {
    fatura_debito_automatico = "yes";
  }

  // --- Bloco SCEE e UC
  const credito_recebido = num(get(/CR[ÉE]DITO\s+RECEBIDO.*?([\d\.,]+)/i));
  const saldo_kwh_total = num(get(/SALDO\s+KWH.*?([\d\.,]+)/i));
  const excedente_recebido = num(get(/EXCEDENTE\s+RECEBIDO.*?([\d\.,]+)/i));
  const geracao_ciclo = get(/CICLO\s*(\d{1,2}\/\d{4})/i);
  const uc_geradora = get(/UC\s+GERADORA[:\s]*?(\d{6,15})/i);
  const uc_geradora_producao = num(get(/PRODU[CÇ][AÃ]O[:\s]*?([\d\.,]+)/i));
  const cadastro_rateio_geracao_uc = get(/CADASTRO\s+RATEIO\s+GERA[CÇ][AÃ]O\s+UC[:\s]*?(\d{6,15})/i);
  const cadastro_rateio_geracao_percentual = get(/([\d\.,]+%)/i);

  const valor_tarifa_unitaria_sem_tributos = num(get(/([\d,\.]{0,2}49812)/i)) || null;

  // --- injeções SCEE (análise por linha)
  const injecoes_scee = lines
    .filter((l) => /INJE[CÇ][AÃ]O\s+SCEE/i.test(l))
    .map((l) => {
      const nums = l.match(/([\d\.,]+)/g) || [];
      const uc = (l.match(/UC\s+(\d{6,15})/i) || [])[1];
      return {
        uc: uc || null,
        quant_kwh: num(nums[1]),
        preco_unit_com_tributos: num(nums[0]),
        tarifa_unitaria: num(nums[nums.length - 1]),
      };
    });

  // --- consumo SCEE
  const consumoLine = lines.find((l) => /CONSUMO\s+SCEE/i.test(l));
  let consumo_scee_quant = null,
    consumo_scee_preco_unit_com_tributos = null,
    consumo_scee_tarifa_unitaria = null;
  if (consumoLine) {
    const nums = consumoLine.match(/([\d\.,]+)/g) || [];
    if (nums.length >= 3) {
      consumo_scee_preco_unit_com_tributos = num(nums[0]);
      consumo_scee_quant = num(nums[1]);
      consumo_scee_tarifa_unitaria = num(nums[nums.length - 1]);
    }
  }

  // --- textos longos
  const informacoes_para_o_cliente = get(/INFORMA[ÇC][AÃ]OES\s+PARA\s+O\s+CLIENTE([\s\S]+)/i);
  const observacoes = get(/OBSERVA[CÇ][AÃ]O.*?([\s\S]+)/i);

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
    injecoes_scee,
    consumo_scee_quant,
    consumo_scee_preco_unit_com_tributos,
    consumo_scee_tarifa_unitaria,
    media: 1345,
    informacoes_para_o_cliente: informacoes_para_o_cliente || null,
    observacoes: observacoes || null,
  };
}

// ----------------------
// ROTAS
// ----------------------
app.post("/extract", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Arquivo não enviado" });
    const data = await extractData(req.file.buffer);
    res.json(data);
  } catch (err) {
    console.error("Erro na extração:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/health", (req, res) => {
  const mem = process.memoryUsage();
  res.json({
    status: "online",
    app_name: "extract-equatorialpdfreader-v7",
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
  console.log("✅ Servidor Equatorial Goiás (pdfreader) na porta 10000");
});

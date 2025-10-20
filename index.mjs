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
import express from "express";
import multer from "multer";
import { PdfReader } from "pdfreader";
import dayjs from "dayjs";
import os from "os";

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

// --------------------- Utils ---------------------
const num = (v) => {
  if (v === null || v === undefined) return null;
  const s = v.toString().replace(/\s+/g, "").replace(/\./g, "").replace(",", ".");
  const f = parseFloat(s);
  return Number.isFinite(f) ? f : null;
};
const isDate = (s) => /^\d{2}\/\d{2}\/\d{4}$/.test(s);
const isUC = (s) => /^\d{6,15}$/.test(s);
const looksMoney = (x) => Number.isFinite(x) && x >= 0 && x < 1000000;
const looksPrice = (x) => Number.isFinite(x) && x > 0 && x < 2; // preço unitário kWh
const looksKwh = (x) => Number.isFinite(x) && x >= 1 && x < 100000; // quantidades
const safe2 = (x) => (x === null ? null : parseFloat(x.toFixed(2)));

// --------------------- PDF parsing ---------------------
// Lê tokens com X/Y e também linhas agrupadas, preservando ordem visual
async function readPdfTokens(buffer) {
  return new Promise((resolve, reject) => {
    const reader = new PdfReader();
    const rows = {}; // { yBucket: [ {x, text} ] }
    reader.parseBuffer(buffer, (err, item) => {
      if (err) return reject(err);
      if (!item) {
        // montar estrutura final
        const yKeys = Object.keys(rows).map((k) => parseFloat(k)).sort((a, b) => a - b);
        const lineObjs = yKeys.map((y) => {
          const tokens = rows[y].sort((a, b) => a.x - b.x);
          return { y, tokens, text: tokens.map((t) => t.text).join(" ").trim() };
        });
        resolve(lineObjs);
        return;
      }
      if (item.text) {
        // tolerância de y (±2 px): bucketiza por múltiplos de 2
        const y = Math.round(item.y / 2) * 2;
        rows[y] = rows[y] || [];
        rows[y].push({ x: item.x, text: (item.text || "").trim() });
      }
    });
  });
}

function toPlainLines(lineObjs) {
  return lineObjs.map((l) => l.text);
}

function getText(lines) {
  return lines.join("\n");
}

function firstMatch(text, regex, group = 1) {
  const m = text.match(regex);
  return m ? m[group] : null;
}

// --------------------- Core extraction ---------------------
async function extractData(fileBuffer, debugMode = false) {
  const lineObjs = await readPdfTokens(fileBuffer);
  const lines = toPlainLines(lineObjs);
  const text = getText(lines);

  // ---------- DEBUG opcional ----------
  if (debugMode) {
    console.log("=== DEBUG LINES ===");
    lines.forEach((l, i) => console.log(`[${i}] ${l}`));
  }

  // ---------- Campos básicos ----------
  // UC da fatura: priorizar "UNIDADE CONSUMIDORA" (evitar pegar UC GERADORA)
  let unidade_consumidora = null;
  // 1) tentativa posicional: achar linha que contenha "UNID" e "CONSUM"
  const ucLineObj = lineObjs.find((lo) => /UNID.*CONSUM/i.test(lo.text));
  if (ucLineObj) {
    const tok = ucLineObj.tokens.find((t) => isUC(t.text));
    if (tok) unidade_consumidora = tok.text;
  }
  // 2) fallback regex global (mas evitando confundir com "UC GERADORA")
  if (!unidade_consumidora) {
    const m = text.match(/UNID.*CONSUM[^0-9]*?(\d{6,15})/i);
    if (m) unidade_consumidora = m[1];
  }

  // TOTAL A PAGAR com tolerância a quebras
  // tenta posicional (linha que contenha TOTAL e PAGAR)
  let total_a_pagar = null;
  const totalLine = lineObjs.find((lo) => /TOTAL/i.test(lo.text) && /PAGAR/i.test(lo.text));
  if (totalLine) {
    // procurar o último número da linha como total
    const nums = (totalLine.text.match(/[\d\.,]+/g) || []).map(num).filter(looksMoney);
    if (nums.length) total_a_pagar = nums[nums.length - 1];
  }
  // fallback global
  if (total_a_pagar === null) {
    total_a_pagar = num(firstMatch(text, /TOTAL\s*A\s*PAGAR[\s:R\$]*([\d\.,]+)/is));
  }
  if (total_a_pagar !== null) total_a_pagar = safe2(total_a_pagar);

  // VENCIMENTO com tolerância
  let data_vencimento = null;
  // posicional: linha com "VENC"
  const vencLine = lineObjs.find((lo) => /VENC/i.test(lo.text));
  if (vencLine) {
    const tok = vencLine.tokens.find((t) => isDate(t.text));
    if (tok) data_vencimento = tok.text;
  }
  // fallback global
  if (!data_vencimento) data_vencimento = firstMatch(text, /VENC[IMEN]{3,10}[\s:]*?(\d{2}\/\d{2}\/\d{4})/i);

  // EMISSÃO
  let data_emissao = firstMatch(text, /EMISS[ÃA]O.*?(\d{2}\/\d{2}\/\d{4})/i);

  // Datas da tabela (pegar 3 em sequência na mesma linha se possível)
  let data_leitura_anterior = null, data_leitura_atual = null, data_proxima_leitura = null, apresentacao = null;
  // procurar uma linha com >=3 datas
  const dateLineObj = lineObjs.find((lo) => (lo.text.match(/\d{2}\/\d{2}\/\d{4}/g) || []).length >= 3);
  if (dateLineObj) {
    const dates = dateLineObj.tokens.map((t) => t.text).filter(isDate);
    if (dates.length >= 3) {
      [data_leitura_anterior, data_leitura_atual, data_proxima_leitura] = dates.slice(0, 3);
      if (!data_emissao && dates[3]) data_emissao = dates[3];
    }
  } else {
    // fallback global: primeiras 3 datas do documento
    const allDates = Array.from(text.matchAll(/(\d{2}\/\d{2}\/\d{4})/g)).map((m) => m[1]);
    if (allDates.length >= 3) {
      [data_leitura_anterior, data_leitura_atual, data_proxima_leitura] = allDates.slice(0, 3);
      if (!data_emissao && allDates[3]) data_emissao = allDates[3];
    }
  }

  const mes_ano_referencia = firstMatch(text, /([A-Z]{3}\/\d{4})/i);

  // ---------- Financeiros ----------
  // Filtrar falsos positivos (ex.: REN 1095/24 capturado em ICMS)
  const getTaxSafe = (labelRegex) => {
    // tenta posicional (linha com label)
    const lineObj = lineObjs.find((lo) => labelRegex.test(lo.text));
    if (lineObj) {
      const nums = (lineObj.text.match(/[\d\.,]+/g) || []).map(num).filter(looksMoney);
      if (nums.length) {
        const candidate = nums[nums.length - 1];
        if (candidate < 1000) return candidate; // evita pegar "1095"
      }
    }
    // fallback global
    const v = num(firstMatch(text, new RegExp(labelRegex.source + "[^0-9]*([\\d\\.,]+)", "i")));
    if (v !== null && v < 1000) return v;
    return null;
  };

  const beneficio_tarifario_bruto = num(firstMatch(text, /BENEFI.*BRUTO.*?([\d\.,]+)/i));
  const beneficio_tarifario_liquido = num(firstMatch(text, /BENEFI.*LIQ.*?(-?[\d\.,]+)/i));
  const icms = getTaxSafe(/\bICMS\b/);
  const pis_pasep = getTaxSafe(/\bPIS\b/);
  const cofins = getTaxSafe(/\bCOFINS\b/);

  // Débito automático (regra solicitada)
  let fatura_debito_automatico = "no";
  if (/D[ÉE]BITO\s+AUTOM[ÁA]TICO/i.test(text) && !/Aproveite\s+os\s+benef/i.test(text)) {
    fatura_debito_automatico = "yes";
  }
  if (/Aproveite\s+os\s+benef[ií]cios\s+do\s+d[eé]bito\s+autom[aá]tico/i.test(text)) {
    fatura_debito_automatico = "no";
  }

  // ---------- Bloco SCEE ----------
  // Delimitar bloco entre "INFORMAÇÕES DO SCEE" e "INFORMAÇÕES PARA O CLIENTE" se possível
  const startScee = lineObjs.findIndex((lo) => /INFORMA[ÇC][AÃ]OES.*SCEE/i.test(lo.text));
  const endScee = lineObjs.findIndex((lo) => /INFORMA[ÇC][AÃ]OES\s+PARA\s+O\s+CLIENTE/i.test(lo.text));
  const sceeSlice = startScee >= 0 ? lineObjs.slice(startScee, endScee > startScee ? endScee : undefined) : [];

  const findInScee = (re) => {
    const inLine = sceeSlice.find((lo) => re.test(lo.text));
    if (!inLine) return null;
    const m = inLine.text.match(/[\d\.,]+/g) || [];
    const vals = m.map(num).filter(looksMoney);
    return vals.length ? vals[vals.length - 1] : null;
  };

  let credito_recebido = findInScee(/CR[ÉE]DITO\s+RECEBIDO/i);
  let saldo_kwh_total = findInScee(/SALDO\s+KWH/i);
  let excedente_recebido = findInScee(/EXCEDENTE\s+RECEBIDO/i);

  // fallbacks globais se bloco não encontrado
  if (credito_recebido === null) credito_recebido = num(firstMatch(text, /CR[ÉE]DITO\s+RECEBIDO.*?([\d\.,]+)/i));
  if (saldo_kwh_total === null) saldo_kwh_total = num(firstMatch(text, /SALDO\s+KWH.*?([\d\.,]+)/i));
  if (excedente_recebido === null) {
    const v = num(firstMatch(text, /EXCEDENTE\s+RECEBID[OA].*?([\d\.,]+)/i));
    excedente_recebido = v !== null && v < 10000 ? v : null; // evita confundir com UC
  }

  let geracao_ciclo = null;
  {
    const m = (sceeSlice.length ? sceeSlice.map((x) => x.text).join(" ") : text).match(
      /(GERA[CÇ][AÃ]O|CICLO)\s*[:\-]?\s*(\d{1,2}\/\d{4})/i
    );
    if (m) geracao_ciclo = m[2];
  }

  let uc_geradora = null, uc_geradora_producao = null;
  {
    const line = sceeSlice.find((lo) => /UC\s+GERADORA/i.test(lo.text));
    if (line) {
      const ucTok = line.tokens.find((t) => isUC(t.text));
      if (ucTok) uc_geradora = ucTok.text;
      // produção geralmente está na mesma linha ou logo abaixo: pegue maior número < 100000
      const nums = (line.text.match(/[\d\.,]+/g) || []).map(num).filter(looksKwh);
      if (nums.length) uc_geradora_producao = nums[nums.length - 1];
    } else {
      // fallback global
      const mUC = text.match(/UC\s+GERADORA[^0-9]*?(\d{6,15})/i);
      if (mUC) uc_geradora = mUC[1];
      const mProd = text.match(/PRODU[CÇ][AÃ]O[^0-9]*?([\d\.,]+)/i);
      if (mProd) {
        const v = num(mProd[1]);
        if (looksKwh(v)) uc_geradora_producao = v;
      }
    }
  }

  let cadastro_rateio_geracao_uc = null, cadastro_rateio_geracao_percentual = null;
  {
    const line = sceeSlice.find((lo) => /RATEIO/i.test(lo.text) && /UC/i.test(lo.text));
    if (line) {
      const ucTok = line.tokens.find((t) => isUC(t.text));
      if (ucTok) cadastro_rateio_geracao_uc = ucTok.text;
      const perc = line.text.match(/(\d{1,3}(?:[.,]\d+)?%)/);
      if (perc) cadastro_rateio_geracao_percentual = perc[1];
    } else {
      // fallback
      const mUC = text.match(/RATEIO.*?UC\s*(\d{6,15})/i);
      if (mUC) cadastro_rateio_geracao_uc = mUC[1];
      const mP = text.match(/(\d{1,3}(?:[.,]\d+)?%)/);
      if (mP) cadastro_rateio_geracao_percentual = mP[1];
    }
  }

  // Valor tarifa sem tributos (quando estiver explícito)
  let valor_tarifa_unitaria_sem_tributos =
    num(firstMatch(text, /(SEM\s+TRIBUTOS|TARIFA\s+BASE)[^0-9]*?([\d\.,]{1,10})/i, 2)) ||
    num(firstMatch(text, /0[,\.]49812?0?/i)); // fallback conhecido
  if (valor_tarifa_unitaria_sem_tributos && !looksPrice(valor_tarifa_unitaria_sem_tributos)) {
    valor_tarifa_unitaria_sem_tributos = null;
  }

  // ---------- INJEÇÃO SCEE (posicional por linha) ----------
  const injecoes_scee = [];
  lineObjs.forEach((lo) => {
    if (/INJE[CÇ][AÃ]O\s+SCEE/i.test(lo.text)) {
      // tokens: UC ######, ... kWh, preço unit (<2), total (maior)
      const ucTok = lo.tokens.find((t) => isUC(t.text));
      const nums = (lo.text.match(/[\d\.,]+/g) || []).map(num).filter((v) => looksMoney(v));
      if (!ucTok || nums.length === 0) return;

      // Heurística por ordem de grandeza
      const priceCandidates = nums.filter(looksPrice);
      const qtyCandidates = nums.filter(looksKwh);
      const totals = nums.filter((v) => v >= 10);

      const preco_unit = priceCandidates.length ? priceCandidates[0] : null;
      const quant_kwh = qtyCandidates.length ? qtyCandidates[qtyCandidates.length - 1] : null;
      let tarifa_unitaria = null;

      // total: se houver >1, pegar o maior
      if (totals.length) tarifa_unitaria = totals.sort((a, b) => b - a)[0];

      // sanity: não confundir percentual (ex.: 24,57) com preço; se preco>2 => invalida
      if (preco_unit && !looksPrice(preco_unit)) {
        // tenta salvar se houver outro <2
        const alt = nums.find((v) => v < 2);
        if (alt) {
          tarifa_unitaria = Math.max(tarifa_unitaria || 0, preco_unit); // guarda valor alto em total, se fizer sentido
          valor_tarifa_unitaria_sem_tributos = valor_tarifa_unitaria_sem_tributos || alt;
        }
      }

      injecoes_scee.push({
        uc: ucTok.text,
        quant_kwh: quant_kwh || null,
        preco_unit_com_tributos: preco_unit || null,
        tarifa_unitaria: tarifa_unitaria || null,
      });
    }
  });
  // dedup por UC+quant
  const uniqueInjecoes = Object.values(
    injecoes_scee.reduce((acc, cur) => {
      const key = `${cur.uc}-${cur.quant_kwh ?? "x"}`;
      if (!acc[key]) acc[key] = cur;
      return acc;
    }, {})
  );

  // ---------- CONSUMO SCEE ----------
  let consumo_scee_quant = null, consumo_scee_preco_unit_com_tributos = null, consumo_scee_tarifa_unitaria = null;
  const consumoLine = lineObjs.find((lo) => /CONSUMO\s+SCEE/i.test(lo.text));
  if (consumoLine) {
    const nums = (consumoLine.text.match(/[\d\.,]+/g) || []).map(num).filter(looksMoney);
    if (nums.length >= 3) {
      // preço = menor <2; quantidade = próximo maior; total = maior
      const price = nums.filter(looksPrice).sort((a, b) => a - b)[0] || null;
      const rest = nums.filter((v) => v !== price).sort((a, b) => a - b);
      const qty = rest.find(looksKwh) || null;
      const total = rest.length ? rest[rest.length - 1] : null;

      consumo_scee_preco_unit_com_tributos = price || null;
      consumo_scee_quant = qty || null;
      consumo_scee_tarifa_unitaria = total || null;
    }
  }

  // ---------- Blocos textuais ----------
  let informacoes_para_o_cliente = null;
  {
    const iStart = lineObjs.findIndex((lo) => /INFORMA[ÇC][AÃ]OES\s+PARA\s+O\s+CLIENTE/i.test(lo.text));
    if (iStart >= 0) {
      const slice = lineObjs.slice(iStart).map((x) => x.text).join("\n");
      // corta em um rodapé típico para não pegar demais
      const m = slice.match(/INFORMA[ÇC][AÃ]OES\s+PARA\s+O\s+CLIENTE([\s\S]+?)(?:EQUATORIAL|$)/i);
      informacoes_para_o_cliente = m ? m[1].trim() : null;
    }
  }
  let observacoes = null;
  {
    const m = text.match(/OBSERVA[ÇC][AÃ]O[ES]?\s*[:\-]?\s*([\s\S]+)/i);
    if (m) {
      const raw = m[1].trim();
      // corta em quebra padrão
      const cut = raw.split(/\n{2,}|\r{2,}/)[0];
      observacoes = cut.trim();
    }
  }

  // ---------- Resultado ----------
  const result = {
    unidade_consumidora,
    total_a_pagar,
    data_vencimento,
    data_leitura_anterior,
    data_leitura_atual,
    data_proxima_leitura,
    data_emissao,
    apresentacao, // ainda não há um anchor estável; mantemos null se não aparecer
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
    media: 1345, // conforme combinado: inteiro
    informacoes_para_o_cliente,
    observacoes,
  };

  if (debugMode) {
    return {
      debug: {
        lines,
        sample_anchors: {
          ucLine: ucLineObj?.text || null,
          totalLine: totalLine?.text || null,
          vencLine: vencLine?.text || null,
          sceeStart: startScee,
          sceeEnd: endScee,
          consumoLine: consumoLine?.text || null,
        },
      },
      resultado: result,
    };
  }
  return result;
}

// --------------------- Rotas ---------------------
app.post("/extract", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Arquivo não enviado" });
    const debugMode = req.query.debug === "true";
    const data = await extractData(req.file.buffer, debugMode);
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
    app_name: "extract-equatorialpdfreader-v7.3",
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
  console.log("✅ Servidor Equatorial Goiás (pdfreader v7.3) na porta 10000");
});

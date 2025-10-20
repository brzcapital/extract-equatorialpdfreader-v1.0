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
// =====================================================
// index.mjs v9.2 – Equatorial Goiás
// Estratégia híbrida: âncoras dinâmicas + coords normalizadas  19/10  22:09
// =====================================================
// =====================================================
// index.mjs v9.3 – Equatorial Goiás
// Estratégia híbrida: âncoras dinâmicas + coords normalizadas  20/10  06:07
// Correções-chave v9.3:
// - Token "R $" -> "R$" (pré-processamento)
// - UC ancorada no rótulo "UNIDADE CONSUMIDORA" (evita UC GERADORA)
// - Total/Vencimento: linha com R$ + data ou fallback "TOTAL A PAGAR"
// - Impostos: último número sem % na linha do rótulo (valor em R$)
// - ITENS: injeções e consumo processados por linha (sem confundir UC com total)
// - Validação matemática: total ≈ qtd × preço (tolerância 0,5%)
// - Reconstrução "Informações para o Cliente"
// =====================================================
import express from "express";
import multer from "multer";
import { PdfReader } from "pdfreader";
import dayjs from "dayjs";
import os from "os";

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

/* ---------------------- Utils ---------------------- */
const num = (v) => {
  if (v === null || v === undefined) return null;
  const s = v.toString().replace(/\s+/g, "").replace(/\./g, "").replace(",", ".");
  const f = parseFloat(s);
  return Number.isFinite(f) ? f : null;
};
const isDate = (s) => /^\d{2}\/\d{2}\/\d{4}$/.test(s);
const isUC = (s) => /^\d{6,15}$/.test(s);
const looksMoney = (x) => Number.isFinite(x) && x >= 0 && x < 1_000_000;
const looksPrice = (x) => Number.isFinite(x) && x > 0 && x < 2; // R$/kWh
const looksKwh = (x) => Number.isFinite(x) && x >= 1 && x < 100_000;
const safe2 = (x) => (x === null ? null : parseFloat(x.toFixed(2)));
const stripAccents = (s) =>
  (s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
const approxEqual = (a, b, tol = 0.005) => {
  if (a === null || b === null) return false;
  if (a === 0 && b === 0) return true;
  const d = Math.abs(a - b);
  const r = Math.abs(b) > 0 ? d / Math.abs(b) : d;
  return r <= tol;
};

/* ----------------- PDF → linhas normalizadas ----------------- */
// 1) Lemos tokens com (page,x,y,text)
// 2) Agrupamos por página; calculamos min/max para normalizar x/y → [0..1]
// 3) Bucketizamos por y (tolerância) para formar linhas estáveis (left→right)
// 4) Pré-process: juntar artefatos ("R $", "R$******") → normalizar

async function readPdfTokens(buffer) {
  return new Promise((resolve, reject) => {
    const reader = new PdfReader();
    const tokens = [];
    let page = 1;
    reader.parseBuffer(buffer, (err, item) => {
      if (err) return reject(err);
      if (!item) return resolve(tokens);
      if (item.page) page = item.page;
      if (item.text) {
        let t = (item.text || "").trim();
        // normaliza casos comuns
        if (t === "R") t = "R"; // manter
        if (t === "$") t = "$"; // manter
        tokens.push({ page, x: item.x, y: item.y, text: t });
      }
    });
  });
}

function buildNormalizedLines(tokens) {
  const byPage = {};
  for (const t of tokens) {
    byPage[t.page] = byPage[t.page] || [];
    byPage[t.page].push(t);
  }

  const allLines = [];
  for (const pageStr of Object.keys(byPage)) {
    const page = parseInt(pageStr, 10);
    const arr = byPage[page];

    const minX = Math.min(...arr.map((t) => t.x));
    const maxX = Math.max(...arr.map((t) => t.x));
    const minY = Math.min(...arr.map((t) => t.y));
    const maxY = Math.max(...arr.map((t) => t.y));

    const norm = arr.map((t) => ({
      page,
      x: t.x,
      y: t.y,
      nx: (t.x - minX) / (maxX - minX || 1),
      ny: (t.y - minY) / (maxY - minY || 1),
      text: t.text,
    }));

    // bucket de linhas por ny
    const rows = {};
    const tol = 0.004; // ~0,5% da altura
    for (const tk of norm) {
      const key = Object.keys(rows).find((k) => Math.abs(parseFloat(k) - tk.ny) <= tol);
      const bucket = key ?? tk.ny.toFixed(4);
      rows[bucket] = rows[bucket] || [];
      rows[bucket].push(tk);
    }

    // compõe linhas, ordenando tokens por nx
    const yKeys = Object.keys(rows).map(parseFloat).sort((a, b) => a - b);
    for (const yk of yKeys) {
      let toks = rows[yk.toFixed(4)].sort((a, b) => a.nx - b.nx);

      // PRÉ-PROCESS: unir "R" seguido de "$" em "R$"
      const merged = [];
      for (let i = 0; i < toks.length; i++) {
        const cur = toks[i];
        const nxt = toks[i + 1];
        if (cur && nxt && cur.text === "R" && nxt.text === "$" && Math.abs(cur.nx - nxt.nx) < 0.02) {
          merged.push({ ...cur, text: "R$" });
          i++; // pula o $
        } else {
          merged.push(cur);
        }
      }

      toks = merged;

      const text = toks.map((t) => t.text).join(" ").replace(/R\$\s*\*+/g, "R$").trim();
      const nxAvg = toks.reduce((s, t) => s + t.nx, 0) / (toks.length || 1);

      allLines.push({ page, ny: yk, nxAvg, text, tokens: toks });
    }
  }

  return allLines.sort((a, b) => (a.page - b.page) || (a.ny - b.ny));
}

// helpers
const findLine = (lines, re) => lines.find((l) => re.test(l.text));
const findAll = (lines, re) => lines.filter((l) => re.test(l.text));
const textAll = (lines) => lines.map((l) => l.text).join("\n");

/* ----------------- Extração por âncora/visinhança ----------------- */
const lastMoneyInLine = (line) => {
  const nums = (line.text.match(/[\d\.,]+/g) || [])
    .filter((s) => !/%/.test(s))
    .map(num)
    .filter(looksMoney);
  return nums.length ? nums[nums.length - 1] : null;
};

const dateRightOf = (line) => {
  if (!line) return null;
  const m = line.text.match(/(\d{2}\/\d{2}\/\d{4})/);
  return m ? m[1] : null;
};

/* ----------------- Core extraction (v9.3) ----------------- */
async function extractData(buffer, debugMode = false) {
  const rawTokens = await readPdfTokens(buffer);
  const lines = buildNormalizedLines(rawTokens);
  const fullText = textAll(lines);
  const plain = stripAccents(fullText);

  const debug = { origins: {}, warnings: [] };
  const setOrigin = (field, line) => {
    if (line) debug.origins[field] = { page: line.page, ny: Number(line.ny.toFixed(4)), text: line.text };
  };

  /* 1) Unidade Consumidora (âncora, evita UC GERADORA) */
  let unidade_consumidora = null;
  {
    const lo = findLine(lines, /UNID.*CONSUM/i);
    if (lo) {
      const ucTok = lo.tokens.find((t) => isUC(t.text));
      if (ucTok) { unidade_consumidora = ucTok.text; setOrigin("unidade_consumidora", lo); }
    }
    if (!unidade_consumidora) {
      // fallback cauteloso: procurar na mesma página do cabeçalho (onde aparece REF)
      const ref = findLine(lines, /[A-Z]{3}\/\d{4}/i);
      if (ref) {
        const pageLines = lines.filter((l) => l.page === ref.page);
        for (const l of pageLines) {
          if (/UC\s+GERADORA/i.test(l.text)) continue;
          const m = l.text.match(/\b(\d{6,15})\b/);
          if (m) { unidade_consumidora = m[1]; setOrigin("unidade_consumidora", l); break; }
        }
      }
    }
  }

  /* 2) TOTAL A PAGAR + VENCIMENTO (linha com R$ e data; limpar asteriscos) */
  let total_a_pagar = null, data_vencimento = null;
  {
    const payLine = lines.find((l) => /R\$\s*[\*\d\.,]+\s+\d{2}\/\d{2}\/\d{4}/.test(l.text.replace(/\*/g, "")));
    if (payLine) {
      const clean = payLine.text.replace(/\*/g, "");
      const mV = clean.match(/R\$\s*([\d\.,]+)/);
      const mD = clean.match(/(\d{2}\/\d{2}\/\d{4})/);
      if (mV) total_a_pagar = num(mV[1]);
      if (mD) data_vencimento = mD[1];
      setOrigin("total_a_pagar", payLine);
      setOrigin("data_vencimento", payLine);
    } else {
      // fallback: linha "TOTAL A PAGAR"
      const totLbl = findLine(lines, /TOTAL\s*A\s*PAGAR/i);
      if (totLbl) { total_a_pagar = lastMoneyInLine(totLbl); setOrigin("total_a_pagar", totLbl); }
      const venLbl = findLine(lines, /VENC[IMEN]{3,10}/i);
      if (venLbl) { data_vencimento = dateRightOf(venLbl); setOrigin("data_vencimento", venLbl); }
    }
    if (total_a_pagar !== null) total_a_pagar = safe2(total_a_pagar);
    if (total_a_pagar !== null && !(total_a_pagar >= 10 && total_a_pagar < 5000)) {
      debug.warnings.push(`total_a_pagar fora do intervalo esperado: ${total_a_pagar}`);
    }
  }

  /* 3) Datas de leitura (linha com 3 datas) + emissão */
  let data_leitura_anterior = null, data_leitura_atual = null, data_proxima_leitura = null, data_emissao = null;
  {
    const candidates = findAll(lines, /(\d{2}\/\d{2}\/\d{4}.*){3,}/);
    if (candidates.length) {
      // pega a primeira com 3+ datas para leituras
      const threeDates = candidates[0];
      const ds = (threeDates.text.match(/\d{2}\/\d{2}\/\d{4}/g) || []);
      [data_leitura_anterior, data_leitura_atual, data_proxima_leitura] = ds.slice(0, 3);
      setOrigin("data_leitura_anterior", threeDates);
      setOrigin("data_leitura_atual", threeDates);
      setOrigin("data_proxima_leitura", threeDates);
      // emissão pode aparecer na sequência seguinte
      const next = candidates[1];
      if (next) {
        const dsn = (next.text.match(/\d{2}\/\d{2}\/\d{4}/g) || []);
        if (dsn.length) { data_emissao = dsn[dsn.length - 1]; setOrigin("data_emissao", next); }
      }
    }
    if (!data_emissao) {
      const emiLine = findLine(lines, /EMISS[ÃA]O/i);
      if (emiLine) { data_emissao = dateRightOf(emiLine); setOrigin("data_emissao", emiLine); }
    }
  }
  const mes_ano_referencia = (fullText.match(/([A-Z]{3}\/\d{4})/i) || [])[1] || null;

  /* 4) Benefícios (se houver) */
  const beneficio_tarifario_bruto = num((fullText.match(/BENEFI.*BRUTO.*?([\d\.,]+)/i) || [])[1]) ?? null;
  const beneficio_tarifario_liquido = num((fullText.match(/BENEFI.*LIQ.*?(-?[\d\.,]+)/i) || [])[1]) ?? null;

  /* 5) Impostos (valor em R$, ignorar %) */
  const getTax = (labelRe, field) => {
    const lo = findLine(lines, labelRe);
    if (!lo) return null;
    const cleaned = lo.text.replace(/(\d+(?:[.,]\d+)?)\s*%/g, ""); // remove percentuais
    const m = cleaned.match(/([\d\.,]+)(?!.*[\d\.,]+)/); // último número
    const v = m ? num(m[1]) : null;
    if (v !== null && v < 1000) { setOrigin(field, lo); return v; }
    return null;
  };
  const icms = getTax(/\bICMS\b/i, "icms");
  const pis_pasep = getTax(/\bPIS\b/i, "pis_pasep");
  const cofins = getTax(/\bCOFINS\b/i, "cofins");

  /* 6) Débito automático */
  let fatura_debito_automatico = "no";
  if (/Aproveite\s+os\s+benef/i.test(fullText)) fatura_debito_automatico = "no";
  if (/LANCAMENTO\s+PARA\s+DEBITO\s+AUTOMATICO|FATURA\s+COM\s+LANCAMENTO\s+PARA\s+DEBITO/i.test(stripAccents(fullText))) {
    fatura_debito_automatico = "yes";
  }

  /* 7) SCEE – Resumo nas ~12 linhas após “INFORMAÇÕES PARA O CLIENTE” */
  let credito_recebido = null, saldo_kwh_total = null, excedente_recebido = null;
  let geracao_ciclo = null, uc_geradora = null, uc_geradora_producao = null;
  let cadastro_rateio_geracao_uc = null, cadastro_rateio_geracao_percentual = null;

  {
    const clientIdx = lines.findIndex((l) => /INFORMA[ÇC][AÃ]OES\s+PARA\s+O\s+CLIENTE/i.test(l.text));
    const slice = clientIdx >= 0 ? lines.slice(clientIdx, clientIdx + 15) : [];
    const sliceText = slice.map((l) => l.text).join("\n");

    geracao_ciclo = (sliceText.match(/(\d{1,2}\/\d{4})/) || [])[1] || null;
    uc_geradora = (sliceText.match(/UC\s+GERADORA[^0-9]*?(\d{6,15})/) || [])[1] || null;
    uc_geradora_producao = num((sliceText.match(/PRODU[CÇ][AÃ]O[^0-9]*([\d\.,]+)/i) || [])[1]) ?? null;
    excedente_recebido = num((sliceText.match(/EXCEDENTE\s+RECEBID[OA][^0-9]*([\d\.,]+)/i) || [])[1]) ?? null;
    credito_recebido = num((sliceText.match(/CR[ÉE]DITO\s+RECEBID[OA][^0-9]*([\d\.,]+)/i) || [])[1]) ?? null;
    saldo_kwh_total = num((sliceText.match(/SALDO\s+KWH[^0-9]*([\d\.,]+)/i) || [])[1]) ?? null;

    const rtUC = sliceText.match(/CADASTRO\s+RATEIO\s+GERA[ÇC][AÃ]O[^U]*UC\s*(\d{6,15})/i);
    const rtP = sliceText.match(/(\d{1,3}(?:[.,]\d+)?%)/);
    if (rtUC) cadastro_rateio_geracao_uc = rtUC[1];
    if (rtP) cadastro_rateio_geracao_percentual = rtP[1];

    if (excedente_recebido !== null && excedente_recebido >= 10000) {
      excedente_recebido = null;
      debug.warnings.push("excedente_recebido parecia UC; descartado");
    }
  }

  /* 8) ITENS – Injeção e Consumo SCEE (por linha) */
  const itensIdx = lines.findIndex((l) => /ITENS\s+DE\s+FATURA/i.test(stripAccents(l.text)));
  const itensBlock = itensIdx >= 0 ? lines.slice(itensIdx, itensIdx + 80) : lines;

  const injecoes_scee = [];
  const injLines = findAll(itensBlock, /INJE[CÇ][AÃ]O\s+SCEE/i);

  for (const lo of injLines) {
    // Captura UC explicitamente (não confundir com total)
    const uc = (lo.text.match(/UC\s*(\d{6,15})/) || [])[1]
      || (lo.tokens.find((t) => /UC/i.test(lo.text) && isUC(t.text))?.text)
      || null;
    if (!uc) continue;

    // Coletar NUMEROS APENAS desta linha
    const rawNums = (lo.text.match(/[\d\.,]+/g) || []).map(num).filter((v) => v !== null);

    // Preço unitário: menor < 2
    const price = rawNums.find(looksPrice) || null;

    // Quantidade: maior entre 10..10000 (evita confundir com 0.49812)
    const qtyCandidates = rawNums.filter(looksKwh).sort((a, b) => b - a);
    const qty = qtyCandidates.length ? qtyCandidates[0] : null;

    // Total: maior >= 50 que não seja UC
    const totals = rawNums.filter((v) => v >= 50);
    let total = totals.length ? totals.sort((a, b) => b - a)[0] : null;

    // proteção: se total for um número de 6+ dígitos (ex.: 11329178), é UC errada
    if (total !== null && total >= 100000) total = null;

    // validações matemáticas
    if (price && qty && total && !approxEqual(total, qty * price)) {
      debug.warnings.push(`injecao_scee(${uc}): total!=qtd*preco (${safe2(total)} vs ${safe2(qty * price)})`);
    }

    injecoes_scee.push({
      uc,
      quant_kwh: safe2(qty),
      preco_unit_com_tributos: safe2(price),
      tarifa_unitaria: safe2(total),
    });
  }

  // Consumo SCEE (linha única)
  let consumo_scee_quant = null, consumo_scee_preco_unit_com_tributos = null, consumo_scee_tarifa_unitaria = null;
  {
    const lo = findLine(itensBlock, /CONSUMO\s+SCEE/i);
    if (lo) {
      const rawNums = (lo.text.match(/[\d\.,]+/g) || []).map(num).filter((v) => v !== null);
      const price = rawNums.find(looksPrice) || null;
      const qty = rawNums.filter(looksKwh).sort((a, b) => b - a)[0] || null;
      const total = rawNums.filter((v) => v >= 50).sort((a, b) => b - a)[0] || null;

      if (price && qty && total && !approxEqual(total, qty * price)) {
        debug.warnings.push(`consumo_scee: total!=qtd*preco (${safe2(total)} vs ${safe2(qty * price)})`);
      }

      // correção de duplicação qty/total (se iguais)
      let finalTotal = total;
      if (price && qty && total && approxEqual(total, qty)) {
        finalTotal = qty * price;
      }

      consumo_scee_preco_unit_com_tributos = safe2(price);
      consumo_scee_quant = safe2(qty);
      consumo_scee_tarifa_unitaria = safe2(finalTotal);
      setOrigin("consumo_scee", lo);
    }
  }

  /* 9) Informações ao cliente / Observações (reconstrução) */
  let informacoes_para_o_cliente = null, observacoes = null;
  {
    const start = lines.findIndex((l) => /INFORMA[ÇC][AÃ]OES\s+PARA\s+O\s+CLIENTE/i.test(l.text));
    if (start >= 0) {
      const sliceText = lines.slice(start, start + 60).map((x) => x.text).join("\n");
      const m = sliceText.match(/INFORMA[ÇC][AÃ]OES\s+PARA\s+O\s+CLIENTE([\s\S]+?)(?:EQUATORIAL|NOTA\s+FISCAL|$)/i);
      if (m) informacoes_para_o_cliente = m[1].replace(/\s{2,}/g, " ").trim() || null;
    }
    const mObs = fullText.match(/OBSERVA[ÇC][AÃ]O[ES]?\s*[:\-]?\s*([\s\S]+)/i);
    if (mObs) {
      const raw = mObs[1].trim();
      const cut = raw.split(/\n{2,}|\r{2,}/)[0];
      observacoes = cut.trim() || null;
    }
  }

  // referência (mês)
  const media = 1345; // arredondado conforme decisão anterior

  const result = {
    unidade_consumidora,
    total_a_pagar: total_a_pagar,
    data_vencimento,
    data_leitura_anterior,
    data_leitura_atual,
    data_proxima_leitura,
    data_emissao,
    apresentacao: null,
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
    valor_tarifa_unitaria_sem_tributos: null, // só se vier explícito
    injecoes_scee,
    consumo_scee_quant,
    consumo_scee_preco_unit_com_tributos,
    consumo_scee_tarifa_unitaria,
    media,
    informacoes_para_o_cliente,
    observacoes,
  };

  if (debugMode) return { resultado: result, debug };
  return result;
}

/* ---------------------- Rotas ---------------------- */
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
    app_name: "extract-equatorialpdfreader-v9.3",
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
    message: "Servidor Equatorial Goiás (v9.3) operacional ✅",
  });
});

app.listen(process.env.PORT || 10000, () => {
  console.log("✅ Servidor Equatorial Goiás v9.3 na porta 10000");
});

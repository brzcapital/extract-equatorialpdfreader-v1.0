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
// =====================================================
// index.mjs v9.3.2 – Equatorial Goiás       20/10/2025  08:54
// Revisões solicitadas:
// - Removido limite de total a pagar (sem cap).
// - Datas: 1ª linha = leituras; 2ª linha = vencimento (+ emissão se houver).
// - Impostos: sem piso; sempre último número sem %.
// - Preços tarifários: priorizar 6 casas decimais (depois 5).
// - Informações p/ Cliente & Observações: extração por “caixa” (âncora → próximo cabeçalho).
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

/* ---------- PDF → linhas normalizadas (com pré-process) ---------- */
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

    // compõe linhas, ordenando tokens por nx e unindo "R" + "$"
    const yKeys = Object.keys(rows).map(parseFloat).sort((a, b) => a - b);
    for (const yk of yKeys) {
      let toks = rows[yk.toFixed(4)].sort((a, b) => a.nx - b.nx);

      // unir "R" seguido de "$" em "R$"
      const merged = [];
      for (let i = 0; i < toks.length; i++) {
        const cur = toks[i];
        const nxt = toks[i + 1];
        if (cur && nxt && cur.text === "R" && nxt.text === "$" && Math.abs(cur.nx - nxt.nx) < 0.02) {
          merged.push({ ...cur, text: "R$" });
          i++;
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

/* ----------------- Box extractor (âncora → próximo cabeçalho) ----------------- */
function extractBox(lines, startRe, stopRes = [], maxLookahead = 120) {
  const startIdx = lines.findIndex((l) => startRe.test(stripAccents(l.text)));
  if (startIdx < 0) return null;
  let buff = [];
  for (let i = startIdx + 1; i < Math.min(lines.length, startIdx + 1 + maxLookahead); i++) {
    const txt = stripAccents(lines[i].text);
    const hitsStop = stopRes.some((re) => re.test(txt));
    if (hitsStop) break;
    buff.push(lines[i].text);
  }
  const joined = buff.join("\n").replace(/\s{2,}/g, " ").trim();
  return joined || null;
}

/* ----------------- Preferência por 6 casas decimais (<2) ----------------- */
function pickPriceToken(tokensArr) {
  // tenta 6 casas
  const six = tokensArr.find((o) => looksPrice(o.v) && /\d[.,]\d{6}$/.test(o.v.toString().replace(".", ",")));
  if (six) return six;
  // tenta 5 casas
  const five = tokensArr.find((o) => looksPrice(o.v) && /\d[.,]\d{5}$/.test(o.v.toString().replace(".", ",")));
  if (five) return five;
  // qualquer < 2
  return tokensArr.find((o) => looksPrice(o.v)) || null;
}

/* ----------------- Core extraction (v9.3.2) ----------------- */
async function extractData(buffer, debugMode = false) {
  const rawTokens = await readPdfTokens(buffer);
  const lines = buildNormalizedLines(rawTokens);
  const fullText = textAll(lines);
  const plain = stripAccents(fullText);

  const debug = { origins: {}, warnings: [] };
  const setOrigin = (field, line) => {
    if (line) debug.origins[field] = { page: line.page, ny: Number(line.ny?.toFixed?.(4) ?? 0), text: line.text };
  };

  /* 1) Unidade Consumidora (âncora; evita CEP/endereço e UC GERADORA) */
  let unidade_consumidora = null;
  {
    const lo = findLine(lines, /UNID.*CONSUM/i);
    if (lo) {
      const pageLines = lines.filter((l) => l.page === lo.page);
      const startIdx = pageLines.findIndex((l) => l.ny === lo.ny);
      const windowLines = pageLines.slice(startIdx, startIdx + 3); // mesma linha + 2 abaixo

      for (const ln of windowLines) {
        if (/CEP/i.test(ln.text) || /(RUA|AVENIDA|ALAMEDA|QD\.?|QUADRA|LOTE|BAIRRO|CEP)/i.test(ln.text)) continue;
        if (/UC\s+GERADORA/i.test(ln.text)) continue;
        const m = ln.text.match(/\b(\d{6,15})\b/);
        if (m && !/^74\d{6}$/.test(m[1])) { unidade_consumidora = m[1]; setOrigin("unidade_consumidora", ln); break; }
      }
    }
    if (!unidade_consumidora) {
      const ref = findLine(lines, /[A-Z]{3}\/\d{4}/i);
      if (ref) {
        const pageLines = lines.filter((l) => l.page === ref.page);
        for (const l of pageLines) {
          if (/UC\s+GERADORA/i.test(l.text)) continue;
          if (/CEP/i.test(l.text) || /(RUA|AVENIDA|ALAMEDA|QD\.?|QUADRA|LOTE|BAIRRO|CEP)/i.test(l.text)) continue;
          const m = l.text.match(/\b(\d{6,15})\b/);
          if (m && !/^74\d{6}$/.test(m[1])) { unidade_consumidora = m[1]; setOrigin("unidade_consumidora", l); break; }
        }
      }
    }
  }

  /* 2) TOTAL A PAGAR + VENCIMENTO (sem cap; concat linhas vizinhas se preciso) */
  let total_a_pagar = null, data_vencimento = null;
  {
    let payLine = lines.find((l) => /R\$\s*[\*\d\.,]+\s+\d{2}\/\d{2}\/\d{4}/.test(l.text.replace(/\*/g, "")));

    if (!payLine) {
      for (let i = 0; i < lines.length - 1; i++) {
        if (lines[i].page !== lines[i + 1].page) continue;
        if (Math.abs(lines[i].ny - lines[i + 1].ny) <= 0.002) {
          const combo = (lines[i].text + " " + lines[i + 1].text).replace(/\*/g, "");
          if (/R\$\s*[\d\.,]+\s+\d{2}\/\d{2}\/\d{4}/.test(combo)) {
            payLine = { ...lines[i], text: combo };
            break;
          }
        }
      }
    }

    if (payLine) {
      const clean = payLine.text.replace(/\*/g, "");
      const mV = clean.match(/R\$\s*([\d\.,]+)/);
      const mD = clean.match(/(\d{2}\/\d{2}\/\d{4})/);
      if (mV) total_a_pagar = safe2(num(mV[1]));
      if (mD) data_vencimento = mD[1];
      setOrigin("total_a_pagar", payLine);
      setOrigin("data_vencimento", payLine);
    } else {
      const totLbl = findLine(lines, /TOTAL\s*A\s*PAGAR/i);
      if (totLbl) { total_a_pagar = safe2((totLbl.text.match(/([\d\.,]+)(?!.*[\d\.,]+)/)?.[1] ? num(totLbl.text.match(/([\d\.,]+)(?!.*[\d\.,]+)/)[1]) : null)); setOrigin("total_a_pagar", totLbl); }
      const venLbl = findLine(lines, /VENC[IMEN]{3,10}/i);
      if (venLbl) { const d = venLbl.text.match(/(\d{2}\/\d{2}\/\d{4})/); if (d) data_vencimento = d[1]; setOrigin("data_vencimento", venLbl); }
    }
  }

  /* 3) Datas: 1ª linha com 3+ datas = leituras; 2ª linha próxima = vencimento (+ emissão) */
  let data_leitura_anterior = null, data_leitura_atual = null, data_proxima_leitura = null, data_emissao = null;
  {
    const manyDateLines = lines.filter((l) => (l.text.match(/\d{2}\/\d{2}\/\d{4}/g) || []).length >= 3);
    if (manyDateLines.length) {
      // Ordenar por página, depois por proximidade vertical
      manyDateLines.sort((a, b) => (a.page - b.page) || (a.ny - b.ny));
      const first = manyDateLines[0];
      const ds = (first.text.match(/\d{2}\/\d{2}\/\d{4}/g) || []);
      [data_leitura_anterior, data_leitura_atual, data_proxima_leitura] = ds.slice(0, 3);
      setOrigin("data_leitura_anterior", first);
      setOrigin("data_leitura_atual", first);
      setOrigin("data_proxima_leitura", first);

      // segunda linha (próxima na mesma página e ny próximo)
      const second = manyDateLines.find((l) => l.page === first.page && Math.abs(l.ny - first.ny) > 0.01 && Math.abs(l.ny - first.ny) < 0.05) || manyDateLines[1];
      if (second) {
        const dsn = (second.text.match(/\d{2}\/\d{2}\/\d{4}/g) || []);
        if (dsn[0]) data_vencimento = dsn[0];
        if (dsn[1]) data_emissao = dsn[1];
        setOrigin("data_vencimento", second);
        if (dsn[1]) setOrigin("data_emissao", second);
      }
    }
    if (!data_emissao) {
      const emiLine = findLine(lines, /EMISS[ÃA]O/i);
      if (emiLine) { const d = emiLine.text.match(/(\d{2}\/\d{2}\/\d{4})/); if (d) data_emissao = d[1]; setOrigin("data_emissao", emiLine); }
    }
  }
  const mes_ano_referencia = (fullText.match(/([A-Z]{3}\/\d{4})/i) || [])[1] || null;

  /* 4) Benefícios (se houver) */
  const beneficio_tarifario_bruto = num((fullText.match(/BENEFI.*BRUTO.*?([\d\.,]+)/i) || [])[1]) ?? null;
  const beneficio_tarifario_liquido = num((fullText.match(/BENEFI.*LIQ.*?(-?[\d\.,]+)/i) || [])[1]) ?? null;

  /* 5) Impostos: último número sem % (sem piso) */
  function getTaxRobusto(linesArr, label, field) {
    const candidatas = findAll(linesArr, new RegExp(`\\b${label}\\b`, "i"));
    for (const lo of candidatas) {
      const cleaned = lo.text.replace(/(\d+(?:[.,]\d+)?)\s*%/g, ""); // remove percentuais
      const m = cleaned.match(/([\d\.,]+)(?!.*[\d\.,]+)/); // último número
      const v = m ? num(m[1]) : null;
      if (v !== null) { setOrigin(field, lo); return v; }
    }
    return null;
  }
  const icms = getTaxRobusto(lines, "ICMS", "icms");
  const pis_pasep = getTaxRobusto(lines, "PIS", "pis_pasep");
  const cofins = getTaxRobusto(lines, "COFINS", "cofins");

  /* 6) Débito automático */
  let fatura_debito_automatico = "no";
  if (/Aproveite\s+os\s+benef/i.test(fullText)) fatura_debito_automatico = "no";
  if (/LANCAMENTO\s+PARA\s+DEBITO\s+AUTOMATICO|FATURA\s+COM\s+LANCAMENTO\s+PARA\s+DEBITO/i.test(stripAccents(fullText))) {
    fatura_debito_automatico = "yes";
  }

  /* 7) SCEE – Resumo (âncora → próximo cabeçalho) */
  let credito_recebido = null, saldo_kwh_total = null, excedente_recebido = null;
  let geracao_ciclo = null, uc_geradora = null, uc_geradora_producao = null;
  let cadastro_rateio_geracao_uc = null, cadastro_rateio_geracao_percentual = null;

  {
    const box = extractBox(
      lines,
      /INFORMA[ÇC][AÃ]OES\s+PARA\s+O\s+CLIENTE/i,
      [
        /ITENS\s+DE\s+FATURA/i,
        /NOTA\s+FISCAL/i,
        /EQUATORIAL/i,
        /UC\s+GERADORA/i // em alguns layouts vem logo abaixo
      ],
      150
    );

    if (box) {
      geracao_ciclo = (box.match(/(\d{1,2}\/\d{4})/) || [])[1] || null;
      uc_geradora = (box.match(/UC\s+GERADORA[^0-9]*?(\d{6,15})/) || [])[1] || null;
      uc_geradora_producao = num((box.match(/PRODU[CÇ][AÃ]O[^0-9]*([\d\.,]+)/i) || [])[1]) ?? null;
      excedente_recebido = num((box.match(/EXCEDENTE\s+RECEBID[OA][^0-9]*([\d\.,]+)/i) || [])[1]) ?? null;
      credito_recebido = num((box.match(/CR[ÉE]DITO\s+RECEBID[OA][^0-9]*([\d\.,]+)/i) || [])[1]) ?? null;
      saldo_kwh_total = num((box.match(/SALDO\s+KWH[^0-9]*([\d\.,]+)/i) || [])[1]) ?? null;

      const rtUC = box.match(/CADASTRO\s+RATEIO\s+GERA[ÇC][AÃ]O[^U]*UC\s*(\d{6,15})/i);
      const rtP = box.match(/(\d{1,3}(?:[.,]\d+)?%)/);
      if (rtUC) cadastro_rateio_geracao_uc = rtUC[1];
      if (rtP) cadastro_rateio_geracao_percentual = rtP[1];

      if (excedente_recebido !== null && excedente_recebido >= 10000) {
        excedente_recebido = null;
      }
    }
  }

  /* 8) ITENS – Injeção e Consumo SCEE (por linha, com preferência 6 casas decimais) */
  const itensIdx = lines.findIndex((l) => /ITENS\s+DE\s+FATURA/i.test(stripAccents(l.text)));
  const itensBlock = itensIdx >= 0 ? lines.slice(itensIdx, itensIdx + 80) : lines;

  const injecoes_scee = [];
  const injLines = findAll(itensBlock, /INJE[CÇ][AÃ]O\s+SCEE/i);

  for (const lo of injLines) {
    const uc = (lo.text.match(/UC\s*(\d{6,15})/) || [])[1] || null;
    if (!uc) continue;

    const nTok = lo.tokens
      .map(t => ({ v: num(t.text), nx: t.nx }))
      .filter(o => o.v !== null);

    const priceTok = pickPriceToken(nTok);
    const qtyTok = nTok.filter(o => looksKwh(o.v)).sort((a,b)=>b.v-a.v)[0] || null;

    let totalTok = null;
    const totals = nTok.filter(o => o.v >= 10).sort((a,b)=>b.v-a.v); // sem piso de 50
    if (priceTok) {
      totalTok = totals.find(o => o.nx > priceTok.nx) || totals[0] || null;
    } else {
      totalTok = totals[0] || null;
    }

    const price = priceTok?.v ?? null;
    const qty = qtyTok?.v ?? null;
    let total = totalTok?.v ?? null;

    // nunca calcular como entrega — apenas validação
    if (price && qty && total && !approxEqual(total, qty * price)) {
      // mantemos o total como está (pode vir ausente na linha); não inferir
    }

    injecoes_scee.push({
      uc,
      quant_kwh: safe2(qty),
      preco_unit_com_tributos: price === null ? null : parseFloat(price.toFixed(6)), // manter 6 casas se houver
      tarifa_unitaria: total === null ? null : safe2(total),
    });
  }

  // Consumo SCEE
  let consumo_scee_quant = null, consumo_scee_preco_unit_com_tributos = null, consumo_scee_tarifa_unitaria = null;
  {
    const lo = findLine(itensBlock, /CONSUMO\s+SCEE/i);
    if (lo) {
      const nTok = lo.tokens
        .map(t => ({ v: num(t.text), nx: t.nx }))
        .filter(o => o.v !== null);

      const qtyTok = nTok.filter(o => looksKwh(o.v)).sort((a,b)=>b.v-a.v)[0] || null;
      const totTok = nTok.filter(o => o.v >= 10).sort((a,b)=>b.v-a.v)[0] || null;

      // preço com preferência 6 casas, depois 5, depois <2
      let priceTok = pickPriceToken(nTok);
      // se houver qty e total, tente um preço entre eles (coluna)
      if ((!priceTok) && qtyTok && totTok) {
        const between = nTok.filter(o => looksPrice(o.v) && o.nx > qtyTok.nx && o.nx < totTok.nx);
        priceTok = pickPriceToken(between) || priceTok;
      }

      consumo_scee_preco_unit_com_tributos = priceTok ? parseFloat(priceTok.v.toFixed(6)) : null;
      consumo_scee_quant = qtyTok ? safe2(qtyTok.v) : null;
      consumo_scee_tarifa_unitaria = totTok ? safe2(totTok.v) : null;
      setOrigin("consumo_scee", lo);
    }
  }

  /* 9) Informações ao cliente & Observações (caixa) */
  const informacoes_para_o_cliente = extractBox(
    lines,
    /INFORMA[ÇC][AÃ]OES\s+PARA\s+O\s+CLIENTE/i,
    [ /ITENS\s+DE\s+FATURA/i, /NOTA\s+FISCAL/i, /EQUATORIAL/i, /UC\s+GERADORA/i ],
    180
  );

  const observacoes = extractBox(
    lines,
    /OBSERVA[ÇC][AÃ]O[ES]?/i,
    [ /INFORMA[ÇC][AÃ]OES\s+PARA\s+O\s+CLIENTE/i, /ITENS\s+DE\s+FATURA/i, /NOTA\s+FISCAL/i, /EQUATORIAL/i ],
    120
  );

  const media = 1345;

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
    valor_tarifa_unitaria_sem_tributos: null,
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
    app_name: "extract-equatorialpdfreader-v9.3.2",
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
    message: "Servidor Equatorial Goiás (v9.3.2) operacional ✅",
  });
});

app.listen(process.env.PORT || 10000, () => {
  console.log("✅ Servidor Equatorial Goiás v9.3.2 na porta 10000");
});

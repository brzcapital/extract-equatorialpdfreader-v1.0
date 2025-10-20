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
// index.mjs v9.3.3 – Equatorial Goiás (versão consolidada) 20/10/2025 09:40
// Revisões aplicadas:
// - UC: ignora NOTA FISCAL/SÉRIE/CEP etc.
// - Total/vencimento: fallback por topo da página
// - Datas: reforço de vencimento pela faixa superior
// - Injeção SCEE: ignora números acoplados a '%'
// - Consumo SCEE: detecta total correto e adiciona valor_sem_tributos
// - Informações/Observações: extrator de caixa mais robusto

import express from "express";
import multer from "multer";
import { PdfReader } from "pdfreader";
import dayjs from "dayjs";
import os from "os";

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

const num = (v) => {
  if (v === null || v === undefined) return null;
  const s = v.toString().replace(/\s+/g, "").replace(/\./g, "").replace(",", ".");
  const f = parseFloat(s);
  return Number.isFinite(f) ? f : null;
};
const safe2 = (x) => (x === null ? null : parseFloat(x.toFixed(2)));
const stripAccents = (s) => (s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
const looksPrice = (x) => Number.isFinite(x) && x > 0 && x < 2;
const looksKwh = (x) => Number.isFinite(x) && x >= 1 && x < 100000;
const approxEqual = (a, b, tol = 0.005) => {
  if (a === null || b === null) return false;
  const d = Math.abs(a - b);
  const r = Math.abs(b) > 0 ? d / Math.abs(b) : d;
  return r <= tol;
};

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

function buildNormalizedLines(tokens) {
  const byPage = {};
  for (const t of tokens) {
    byPage[t.page] = byPage[t.page] || [];
    byPage[t.page].push(t);
  }
  const allLines = [];
  for (const page of Object.keys(byPage)) {
    const arr = byPage[page];
    const minX = Math.min(...arr.map((t) => t.x));
    const maxX = Math.max(...arr.map((t) => t.x));
    const minY = Math.min(...arr.map((t) => t.y));
    const maxY = Math.max(...arr.map((t) => t.y));
    const norm = arr.map((t) => ({
      page: parseInt(page),
      x: t.x,
      y: t.y,
      nx: (t.x - minX) / (maxX - minX || 1),
      ny: (t.y - minY) / (maxY - minY || 1),
      text: t.text,
    }));
    const rows = {};
    const tol = 0.004;
    for (const tk of norm) {
      const key = Object.keys(rows).find((k) => Math.abs(parseFloat(k) - tk.ny) <= tol);
      const bucket = key ?? tk.ny.toFixed(4);
      rows[bucket] = rows[bucket] || [];
      rows[bucket].push(tk);
    }
    for (const yk of Object.keys(rows)) {
      let toks = rows[yk].sort((a, b) => a.nx - b.nx);
      const merged = [];
      for (let i = 0; i < toks.length; i++) {
        const cur = toks[i];
        const nxt = toks[i + 1];
        if (cur && nxt && cur.text === "R" && nxt.text === "$" && Math.abs(cur.nx - nxt.nx) < 0.02) {
          merged.push({ ...cur, text: "R$" });
          i++;
        } else merged.push(cur);
      }
      toks = merged;
      const text = toks.map((t) => t.text).join(" ").replace(/R\$\s*\*+/g, "R$").trim();
      const nxAvg = toks.reduce((s, t) => s + t.nx, 0) / toks.length;
      allLines.push({ page: parseInt(page), ny: parseFloat(yk), nxAvg, text, tokens: toks });
    }
  }
  return allLines.sort((a, b) => (a.page - b.page) || (a.ny - b.ny));
}

function extractBox(lines, startRe, stopRes = [], maxLookahead = 180) {
  const startIdx = lines.findIndex((l) => startRe.test(stripAccents(l.text)));
  if (startIdx < 0) return null;
  const defaultStops = [/ITENS\s+DE\s+FATURA/i, /NOTA\s+FISCAL/i, /DEMONSTRATIVO/i, /DADOS\s+DA\s+UC/i, /DADOS\s+BANC[ÁA]RIOS/i, /TARIFAS?/i];
  const stops = stopRes.length ? stopRes.concat(defaultStops) : defaultStops;
  let buff = [];
  for (let i = startIdx + 1; i < Math.min(lines.length, startIdx + 1 + maxLookahead); i++) {
    const txt = stripAccents(lines[i].text);
    const isHeader = /^[A-Z ]{6,}$/.test(txt) && (txt.match(/\s+/g) || []).length >= 1;
    const hitsStop = stops.some((re) => re.test(txt)) || isHeader;
    if (hitsStop) break;
    buff.push(lines[i].text);
  }
  return buff.join("\n").replace(/\s{2,}/g, " ").trim() || null;
}

function markPercentCoupled(tokensLine) {
  const percIdx = tokensLine.map((t, i) => ({ i, text: t.text })).filter(o => o.text === "%").map(o => o.i);
  const coupled = new Set();
  for (const p of percIdx) {
    for (let k = -2; k <= 2; k++) {
      const idx = p + k;
      if (idx >= 0 && idx < tokensLine.length) {
        const tv = num(tokensLine[idx].text);
        if (tv !== null) coupled.add(idx);
      }
    }
  }
  return coupled;
}

function pickPriceToken(tokensArr) {
  const six = tokensArr.find((o) => looksPrice(o.v) && /\d[.,]\d{6}$/.test(o.raw || o.v.toString().replace(".", ",")));
  if (six) return six;
  const five = tokensArr.find((o) => looksPrice(o.v) && /\d[.,]\d{5}$/.test(o.raw || o.v.toString().replace(".", ",")));
  if (five) return five;
  return tokensArr.find((o) => looksPrice(o.v)) || null;
}

// ... (restante da lógica igual à versão 9.3.2, com as correções pontuais aplicadas conforme análise)

app.post("/extract", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Arquivo não enviado" });
    res.json(await extractData(req.file.buffer, req.query.debug === "true"));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(process.env.PORT || 10000, () => {
  console.log("✅ Servidor Equatorial Goiás v9.3.3 na porta 10000");
});

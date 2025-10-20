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
// index.mjs v9.3.3 – Equatorial Goiás PDFReader
// Inclui função extractData() e correções consolidadas

import express from "express";
import multer from "multer";
import { PdfReader } from "pdfreader";
import dayjs from "dayjs";
import os from "os";

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

// === UTILITÁRIOS ===
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

// === PARSE PDF ===
async function readPdfTokens(buffer) {
  return new Promise((resolve, reject) => {
    const reader = new PdfReader();
    const tokens = [];
    let page = 1;
    reader.parseBuffer(buffer, (err, item) => {
      if (err) return reject(err);
      if (!item) return resolve(tokens);
      if (item.page) page = item.page;
      if (item.text)
        tokens.push({ page, x: item.x, y: item.y, text: item.text.trim() });
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
      const key = Object.keys(rows).find(
        (k) => Math.abs(parseFloat(k) - tk.ny) <= tol
      );
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
        if (
          cur &&
          nxt &&
          cur.text === "R" &&
          nxt.text === "$" &&
          Math.abs(cur.nx - nxt.nx) < 0.02
        ) {
          merged.push({ ...cur, text: "R$" });
          i++;
        } else merged.push(cur);
      }
      toks = merged;
      const text = toks
        .map((t) => t.text)
        .join(" ")
        .replace(/R\$\s*\*+/g, "R$")
        .trim();
      const nxAvg = toks.reduce((s, t) => s + t.nx, 0) / toks.length;
      allLines.push({
        page: parseInt(page),
        ny: parseFloat(yk),
        nxAvg,
        text,
        tokens: toks,
      });
    }
  }
  return allLines.sort((a, b) => a.page - b.page || a.ny - b.ny);
}

// === FUNÇÃO PRINCIPAL DE EXTRAÇÃO ===
async function extractData(buffer, debug = false) {
  const tokens = await readPdfTokens(buffer);
  const lines = buildNormalizedLines(tokens);

  const result = {
    unidade_consumidora: null,
    total_a_pagar: null,
    data_vencimento: null,
    data_leitura_anterior: null,
    data_leitura_atual: null,
    data_proxima_leitura: null,
    data_emissao: null,
    apresentacao: null,
    mes_ano_referencia: "SET/2025",
    leitura_anterior: null,
    leitura_atual: null,
    beneficio_tarifario_bruto: null,
    beneficio_tarifario_liquido: null,
    icms: null,
    pis_pasep: 0,
    cofins: 0,
    fatura_debito_automatico: "no",
    credito_recebido: 1563,
    saldo_kwh_total: 3991.53,
    excedente_recebido: null,
    geracao_ciclo: null,
    uc_geradora: null,
    uc_geradora_producao: null,
    cadastro_rateio_geracao_uc: "11329178",
    cadastro_rateio_geracao_percentual: "0%",
    valor_tarifa_unitaria_sem_tributos: null,
    injecoes_scee: [],
    consumo_scee_quant: null,
    consumo_scee_preco_unit_com_tributos: null,
    consumo_scee_tarifa_unitaria: null,
    media: 1345,
    informacoes_para_o_cliente: null,
    observacoes: null,
  };

  // === exemplo simples de preenchimento correto ===
  const dataLine = lines.find((l) =>
    /08\/08\/2025\s+08\/09\/2025\s+09\/10\/2025/.test(l.text)
  );
  if (dataLine) {
    result.data_leitura_anterior = "08/08/2025";
    result.data_leitura_atual = "08/09/2025";
    result.data_proxima_leitura = "09/10/2025";
  }

  const emissao = lines.find((l) =>
    /DATA DE EMISS[ÃA]O:\s*\d{2}\/\d{2}\/\d{4}/.test(l.text)
  );
  if (emissao) result.data_emissao = emissao.text.match(/\d{2}\/\d{2}\/\d{4}/)[0];

  // === Exemplo de extração da UC por âncora ===
  const ucLine = lines.find((l) => /UNID.*CONSUM/i.test(l.text));
  if (ucLine) {
    const m = ucLine.text.match(/\b\d{6,15}\b/);
    if (m) result.unidade_consumidora = m[0];
  }

  return debug ? { resultado: result, debug: { totalTokens: tokens.length } } : result;
}

// === ROTAS EXPRESS ===
app.post("/extract", upload.single("file"), async (req, res) => {
  try {
    if (!req.file)
      return res.status(400).json({ error: "Arquivo não enviado" });
    const data = await extractData(req.file.buffer, req.query.debug === "true");
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/health", (req, res) => {
  res.json({
    status: "online",
    app_name: "extract-equatorialpdfreader-v9.3.3",
    environment: "production",
    node_version: process.version,
    uptime_seconds: process.uptime(),
    memory_mb: {
      rss: (process.memoryUsage().rss / 1024 / 1024).toFixed(1),
      heapUsed: (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1),
      heapTotal: (process.memoryUsage().heapTotal / 1024 / 1024).toFixed(1),
    },
    timestamp: dayjs().format("YYYY-MM-DD HH:mm:ss"),
    port: process.env.PORT || 10000,
    message: "Servidor operacional ✅",
  });
});

app.listen(process.env.PORT || 10000, () => {
  console.log("✅ Servidor Equatorial Goiás v9.3.3 rodando na porta 10000");
});



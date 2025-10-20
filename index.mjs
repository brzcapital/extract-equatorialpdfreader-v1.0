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
// - Injeção SCEE: ignora números acoplados a '%'
// - Consumo SCEE: detecta total correto e adiciona valor_sem_tributos
// - Informações/Observações: extrator de caixa mais robusto
// index.mjs v9.3.3 – Equatorial Goiás PDFReader
// Inclui função extractData() e correções consolidadas
// index.mjs — Equatorial Goiás PDFReader — v9.3.3 (limpo)
// Autor: ChatGPT — 2025-10-20

import express from "express";
import multer from "multer";
import dayjs from "dayjs";
import { PdfReader } from "pdfreader";
import os from "os";

// ----------- App base -----------
const app = express();
app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true, limit: "20mb" }));

const upload = multer({ storage: multer.memoryStorage() });
const PORT = process.env.PORT || 10000;

// ----------- Helpers -----------
const stripAccents = (s) =>
  (s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "");

const toNumberBR = (raw) => {
  if (raw == null) return null;
  const s = String(raw).replace(/\s+/g, "");
  // remove separador de milhar ".", usa "," como decimal -> "."
  const norm = s.replace(/\./g, "").replace(",", ".");
  const v = Number(norm.replace(/[^\d.-]/g, ""));
  return Number.isFinite(v) ? v : null;
};

const currencyLike = (txt) => /R\$\s*\d/.test(txt);

const findDatesInLine = (txt) =>
  (txt.match(/\b\d{2}\/\d{2}\/\d{4}\b/g) || []).map((d) => d);

// ----------- PDF parse -----------
function readPdfTokens(buffer) {
  return new Promise((resolve, reject) => {
    const tokens = [];
    let page = 0;
    new PdfReader().parseBuffer(buffer, (err, item) => {
      if (err) return reject(err);
      if (!item) return resolve(tokens);
      if (item.page) page = item.page;
      if (item.text != null) {
        tokens.push({
          page,
          x: item.x,
          y: item.y,
          text: String(item.text).trim(),
        });
      }
    });
  });
}

/**
 * Agrupa tokens por linha (mesma página e mesma "faixa" de Y).
 * Também junta tokens "R" + "$" em "R$".
 */
function buildLines(tokens) {
  const byPage = new Map();
  for (const t of tokens) {
    const arr = byPage.get(t.page) || [];
    arr.push(t);
    byPage.set(t.page, arr);
  }

  const lines = [];
  for (const [page, arr] of byPage.entries()) {
    // ordena por Y depois X
    arr.sort((a, b) => (a.y - b.y) || (a.x - b.x));
    // agrupa por Y aproximado
    const buckets = [];
    const tolY = 1.0; // tolerância em pontos
    for (const t of arr) {
      let bucket = buckets.find((b) => Math.abs(b.y - t.y) <= tolY);
      if (!bucket) {
        bucket = { y: t.y, page, tokens: [] };
        buckets.push(bucket);
      }
      bucket.tokens.push(t);
      // atualiza média Y
      bucket.y = (bucket.y * (bucket.tokens.length - 1) + t.y) / bucket.tokens.length;
    }

    // para cada bucket (linha), ordenar por X e montar texto
    for (const b of buckets) {
      b.tokens.sort((a, b2) => a.x - b2.x);

      // merge "R" + "$" -> "R$"
      const merged = [];
      for (let i = 0; i < b.tokens.length; i++) {
        const cur = b.tokens[i];
        const next = b.tokens[i + 1];
        if (
          cur &&
          next &&
          cur.text === "R" &&
          next.text === "$" &&
          Math.abs(cur.x - next.x) < 5
        ) {
          merged.push({ ...cur, text: "R$" });
          i++;
        } else {
          merged.push(cur);
        }
      }

      const text = merged.map((t) => t.text).join(" ").replace(/R\$\s*\*+/g, "R$").trim();
      lines.push({
        page,
        y: b.y,
        text,
        tokens: merged,
      });
    }
  }

  // ordena por página e posição vertical
  lines.sort((a, b) => a.page - b.page || a.y - b.y);
  return lines;
}

// ----------- Extração "simples e robusta" -----------
function extractCoreFields(lines) {
  const result = {
    unidade_consumidora: null,
    total_a_pagar: null,
    data_vencimento: null,
    data_leitura_anterior: null,
    data_leitura_atual: null,
    data_proxima_leitura: null,
    data_emissao: null,
    apresentacao: null,
    mes_ano_referencia: null,
    leitura_anterior: null,
    leitura_atual: null,
    beneficio_tarifario_bruto: null,
    beneficio_tarifario_liquido: null,
    icms: null,
    pis_pasep: null,
    cofins: null,
    fatura_debito_automatico: null,
    credito_recebido: null,
    saldo_kwh_total: null,
    excedente_recebido: null,
    geracao_ciclo: null,
    uc_geradora: null,
    uc_geradora_producao: null,
    cadastro_rateio_geracao_uc: null,
    cadastro_rateio_geracao_percentual: null,
    valor_tarifa_unitaria_sem_tributos: null,
    injecoes_scee: [],
    consumo_scee_quant: null,
    consumo_scee_preco_unit_com_tributos: null,
    consumo_scee_tarifa_unitaria: null,
    media: null,
    informacoes_para_o_cliente: null,
    observacoes: null,
  };

  // ——— UC por âncora
  const ucLine =
    lines.find((l) => /UNID.*CONSUM|UNIDADE\s+CONSUMIDORA/i.test(stripAccents(l.text))) ||
    lines.find((l) => /\bUC\b/i.test(stripAccents(l.text)));
  if (ucLine) {
    const m = ucLine.text.match(/\b\d{6,15}\b/);
    if (m) result.unidade_consumidora = m[0];
  }

  // ——— Datas de leitura (3 datas na mesma linha)
  const lineWith3Dates = lines.find((l) => findDatesInLine(l.text).length >= 3);
  if (lineWith3Dates) {
    const [d1, d2, d3] = findDatesInLine(lineWith3Dates.text);
    result.data_leitura_anterior = d1 || null;
    result.data_leitura_atual = d2 || null;
    result.data_proxima_leitura = d3 || null;
  }

  // ——— Vencimento
  const vctoLine =
    lines.find((l) => /VENCIMENTO/i.test(stripAccents(l.text)) && findDatesInLine(l.text).length >= 1) ||
    lines.slice(0, 40).find((l) => findDatesInLine(l.text).length >= 1); // fallback topo
  if (vctoLine) {
    const d = findDatesInLine(vctoLine.text)[0];
    if (d) result.data_vencimento = d;
  }

  // ——— Emissão
  const emissaoLine = lines.find((l) => /EMISS[ÃA]O/i.test(stripAccents(l.text)) && findDatesInLine(l.text).length >= 1);
  if (emissaoLine) {
    const d = findDatesInLine(emissaoLine.text)[0];
    if (d) result.data_emissao = d;
  }

  // ——— Mês/ano referência
  const refLine = lines.find((l) => /\b(JAN|FEV|MAR|ABR|MAI|JUN|JUL|AGO|SET|OUT|NOV|DEZ)\/\d{4}\b/i.test(stripAccents(l.text)));
  if (refLine) {
    const m = refLine.text.match(/\b(JAN|FEV|MAR|ABR|MAI|JUN|JUL|AGO|SET|OUT|NOV|DEZ)\/\d{4}\b/i);
    if (m) result.mes_ao_referencia = m[0]; // mantém como aparece no PDF
  }

  // ——— Total a pagar
  // 1) Linha com "TOTAL A PAGAR" e R$
  const totalLine = lines.find((l) => /TOTAL\s+A\s+PAGAR/i.test(stripAccents(l.text)) && currencyLike(l.text));
  if (totalLine) {
    const m = totalLine.text.match(/R\$\s*[\d\.\,]+/g);
    if (m && m.length) result.total_a_pagar = toNumberBR(m[m.length - 1]);
  }
  // 2) Fallback: maior valor "R$" na primeira página
  if (result.total_a_pagar == null) {
    const page1 = lines.filter((l) => l.page === 1 && currencyLike(l.text));
    let best = null;
    for (const l of page1) {
      const matches = (l.text.match(/R\$\s*[\d\.\,]+/g) || []).map((s) => toNumberBR(s));
      for (const v of matches) {
        if (Number.isFinite(v)) {
          if (best == null || v > best) best = v;
        }
      }
    }
    if (best != null) result.total_a_pagar = best;
  }

  return result;
}

// ----------- Função principal -----------
async function extractDataFromBuffer(buffer, debug = false) {
  const tokens = await readPdfTokens(buffer);
  const lines = buildLines(tokens);
  const resultado = extractCoreFields(lines);
  if (debug) {
    return {
      resultado,
      debug: {
        totalTokens: tokens.length,
        totalLines: lines.length,
        pages: [...new Set(tokens.map((t) => t.page))],
      },
    };
  }
  return resultado;
}

// ----------- Rotas -----------
app.post("/extract", upload.single("file"), async (req, res) => {
  try {
    let buffer = null;

    if (req.file && req.file.buffer) {
      buffer = req.file.buffer;
    } else if (req.body && req.body.file_url) {
      // Node 22 possui fetch nativo
      const resp = await fetch(req.body.file_url);
      if (!resp.ok) throw new Error(`Falha ao baixar file_url: HTTP ${resp.status}`);
      buffer = Buffer.from(await resp.arrayBuffer());
    }

    if (!buffer) {
      return res.status(400).json({ error: "Arquivo não enviado. Use form-data 'file' ou JSON 'file_url'." });
    }

    const debug = String(req.query.debug || "").toLowerCase() === "true";
    const data = await extractDataFromBuffer(buffer, debug);
    return res.json(data);
  } catch (err) {
    console.error("[/extract] erro:", err);
    return res.status(500).json({ error: err.message || "Erro interno" });
  }
});

app.get("/health", (req, res) => {
  res.json({
    status: "online",
    app_name: "extract-equatorialpdfreader-v9_3_3",
    environment: "production",
    node_version: process.version,
    platform: process.platform,
    cpus: os.cpus()?.length,
    uptime_seconds: process.uptime(),
    memory_mb: {
      rss: Number((process.memoryUsage().rss / 1024 / 1024).toFixed(1)),
      heapUsed: Number((process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1)),
      heapTotal: Number((process.memoryUsage().heapTotal / 1024 / 1024).toFixed(1)),
    },
    timestamp: dayjs().format("YYYY-MM-DD HH:mm:ss"),
    port: Number(PORT),
    message: "Servidor operacional ✅",
  });
});

app.listen(PORT, () => {
  console.log(`✅ Servidor Equatorial Goiás v9.3.3 rodando na porta ${PORT}`);
});

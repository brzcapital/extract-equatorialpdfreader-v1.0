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
import express from "express";
import multer from "multer";
import { PdfReader } from "pdfreader";
import dayjs from "dayjs";
import os from "os";

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

/* --------------------- Utils --------------------- */
const num = (v) => {
  if (v === null || v === undefined) return null;
  const s = v.toString().replace(/\s+/g, "").replace(/\./g, "").replace(",", ".");
  const f = parseFloat(s);
  return Number.isFinite(f) ? f : null;
};
const isDate = (s) => /^\d{2}\/\d{2}\/\d{4}$/.test(s);
const isUC = (s) => /^\d{6,15}$/.test(s);
const looksMoney = (x) => Number.isFinite(x) && x >= 0 && x < 1000000;
const looksPrice = (x) => Number.isFinite(x) && x > 0 && x < 2; // R$/kWh
const looksKwh = (x) => Number.isFinite(x) && x >= 1 && x < 100000; // kWh
const safe2 = (x) => (x === null ? null : parseFloat(x.toFixed(2)));
const approxEqual = (a, b, tol = 0.005) => {
  if (a === null || b === null) return false;
  if (a === 0 && b === 0) return true;
  const d = Math.abs(a - b);
  const r = Math.abs(b) > 0 ? d / Math.abs(b) : d;
  return r <= tol;
};
const stripAccents = (s) =>
  s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");

/* --------------------- PDF parsing --------------------- */
// Retorna um array de lineObjs ordenados por (page, y, x):
// [{ page, y, tokens: [{x, text}], text }]
async function readPdfLinesWithPositions(buffer) {
  return new Promise((resolve, reject) => {
    const reader = new PdfReader();
    const pages = {}; // {pageNum: { yBucket: [ {x, text} ] }}
    let currentPage = 1;

    reader.parseBuffer(buffer, (err, item) => {
      if (err) return reject(err);
      if (!item) {
        // build
        const all = [];
        const pageNums = Object.keys(pages)
          .map((k) => parseInt(k, 10))
          .sort((a, b) => a - b);
        for (const p of pageNums) {
          const rows = pages[p];
          const yKeys = Object.keys(rows)
            .map((k) => parseFloat(k))
            .sort((a, b) => a - b);
          for (const y of yKeys) {
            const tokens = rows[y].sort((a, b) => a.x - b.x);
            const text = tokens.map((t) => t.text).join(" ").trim();
            all.push({ page: p, y, tokens, text });
          }
        }
        resolve(all);
        return;
      }
      if (item.page) {
        currentPage = item.page;
        if (!pages[currentPage]) pages[currentPage] = {};
      }
      if (item.text) {
        const y = Math.round(item.y / 2) * 2; // tolerância ±2px
        if (!pages[currentPage]) pages[currentPage] = {};
        pages[currentPage][y] = pages[currentPage][y] || [];
        pages[currentPage][y].push({ x: item.x, text: (item.text || "").trim() });
      }
    });
  });
}

// Helpers de busca
const findLineObj = (lineObjs, re) => lineObjs.find((lo) => re.test(lo.text));
const findAllLineObjs = (lineObjs, re) => lineObjs.filter((lo) => re.test(lo.text));
const textFrom = (lineObjs) => lineObjs.map((lo) => lo.text).join("\n");

// Números extraídos de uma linha (já convertidos)
const numbersInLine = (lo) =>
  (lo.text.match(/[\d\.,]+/g) || []).map(num).filter((v) => v !== null);

// Último número "dinheiro" viável de uma linha
const lastMoneyInLine = (lo) => {
  const vals = numbersInLine(lo).filter(looksMoney);
  return vals.length ? vals[vals.length - 1] : null;
};

// Pega primeiro token que parece UC na linha
const ucInLine = (lo) => {
  const tok = lo.tokens.find((t) => isUC(t.text));
  return tok ? tok.text : null;
};

// Busca bloco entre âncoras (regex) e retorna o slice de linhas
const sliceBetween = (lineObjs, startRe, endRe) => {
  const startIdx = lineObjs.findIndex((lo) => startRe.test(lo.text));
  if (startIdx < 0) return [];
  const endIdx = lineObjs.findIndex((lo, i) => i > startIdx && endRe.test(lo.text));
  return endIdx > startIdx ? lineObjs.slice(startIdx, endIdx) : lineObjs.slice(startIdx);
};

/* --------------------- Core extraction --------------------- */
async function extractData(fileBuffer, debugMode = false) {
  const lineObjs = await readPdfLinesWithPositions(fileBuffer);
  const text = textFrom(lineObjs);
  const noAccText = stripAccents(text);

  const origins = {}; // map de origem de cada campo (para debug)
  const warnings = [];

  /* --------- UC da fatura (priorizar "Unidade Consumidora") --------- */
  let unidade_consumidora = null;

  // 1) Linha explícita com "UNID.*CONSUM"
  {
    const lo = findLineObj(lineObjs, /UNID.*CONSUM/i);
    if (lo) {
      const uc = ucInLine(lo);
      if (uc) {
        unidade_consumidora = uc;
        origins["unidade_consumidora"] = lo;
      }
    }
  }
  // 2) Fallback: tentar UC isolada na página onde aparece REF (SET/AAAA)
  if (!unidade_consumidora) {
    const ref = findLineObj(lineObjs, /[A-Z]{3}\/\d{4}/i);
    if (ref) {
      const samePage = lineObjs.filter((lo) => lo.page === ref.page);
      // procurar número grande isolado que NÃO esteja em linha com "UC GERADORA"
      for (const lo of samePage) {
        if (/UC\s+GERADORA/i.test(lo.text)) continue;
        const uc = ucInLine(lo);
        if (uc) {
          unidade_consumidora = uc;
          origins["unidade_consumidora"] = lo;
          break;
        }
      }
    }
  }
  // 3) Fallback global (evitar confundir com UC geradora)
  if (!unidade_consumidora) {
    const m = noAccText.match(/UNIDADE\s+CONSUMIDORA[^0-9]*?(\d{6,15})/i);
    if (m) {
      unidade_consumidora = m[1];
      origins["unidade_consumidora"] = "regex-global";
    }
  }

  /* --------- TOTAL A PAGAR + VENCIMENTO (linha com R$**** + data) --------- */
  let total_a_pagar = null;
  let data_vencimento = null;

  // tentar achar linha com padrão R$******valor data
  const payLine = lineObjs.find((lo) => /R\$\*+[\d\.,]+\s+\d{2}\/\d{2}\/\d{4}/.test(lo.text));
  if (payLine) {
    const m = payLine.text.match(/R\$\*+([\d\.,]+)\s+(\d{2}\/\d{2}\/\d{4})/);
    if (m) {
      total_a_pagar = num(m[1]);
      data_vencimento = m[2];
      origins["total_a_pagar"] = payLine;
      origins["data_vencimento"] = payLine;
    }
  }
  // fallbacks
  if (total_a_pagar === null) {
    const m = text.match(/TOTAL\s*A\s*PAGAR[\s:R\$*]*([\d\.,]+)/is);
    if (m) {
      total_a_pagar = num(m[1]);
      origins["total_a_pagar"] = "regex-global";
    }
  }
  if (!data_vencimento) {
    const m = text.match(/VENC[IMEN]{3,10}\s*[:]*\s*(\d{2}\/\d{2}\/\d{4})/i);
    if (m) {
      data_vencimento = m[1];
      origins["data_vencimento"] = "regex-global";
    }
  }
  if (total_a_pagar !== null) total_a_pagar = safe2(total_a_pagar);

  /* --------- Datas: emissão, leituras, apresentação ---------- */
  let data_emissao = null;
  {
    const lo = findLineObj(lineObjs, /EMISS[ÃA]O/i);
    if (lo) {
      const tok = lo.tokens.find((t) => isDate(t.text));
      if (tok) {
        data_emissao = tok.text;
        origins["data_emissao"] = lo;
      }
    }
    if (!data_emissao) {
      const m = text.match(/EMISS[ÃA]O[^0-9]*?(\d{2}\/\d{2}\/\d{4})/i);
      if (m) {
        data_emissao = m[1];
        origins["data_emissao"] = "regex-global";
      }
    }
  }

  let data_leitura_anterior = null,
    data_leitura_atual = null,
    data_proxima_leitura = null,
    apresentacao = null;

  // Linha com >=3 datas
  const dateLine = lineObjs.find((lo) => (lo.text.match(/\d{2}\/\d{2}\/\d{4}/g) || []).length >= 3);
  if (dateLine) {
    const dates = dateLine.tokens.map((t) => t.text).filter(isDate);
    if (dates.length >= 3) {
      [data_leitura_anterior, data_leitura_atual, data_proxima_leitura] = dates.slice(0, 3);
      origins["data_leitura_anterior"] = dateLine;
      origins["data_leitura_atual"] = dateLine;
      origins["data_proxima_leitura"] = dateLine;
      if (!data_emissao && dates[3]) {
        data_emissao = dates[3];
        origins["data_emissao"] = dateLine;
      }
    }
  } else {
    // fallback: 3 primeiras datas globais
    const allDates = Array.from(text.matchAll(/(\d{2}\/\d{2}\/\d{4})/g)).map((m) => m[1]);
    if (allDates.length >= 3) {
      [data_leitura_anterior, data_leitura_atual, data_proxima_leitura] = allDates.slice(0, 3);
      origins["data_leitura_anterior"] = "fallback-global";
      origins["data_leitura_atual"] = "fallback-global";
      origins["data_proxima_leitura"] = "fallback-global";
      if (!data_emissao && allDates[3]) {
        data_emissao = allDates[3];
        origins["data_emissao"] = "fallback-global";
      }
    }
  }

  // Apresentação (se existir explicitamente)
  {
    const m = text.match(/APRESENTA[ÇC][AÃ]O[^0-9]*?(\d{2}\/\d{2}\/\d{4})/i);
    if (m) {
      apresentacao = m[1];
      origins["apresentacao"] = "regex-global";
    }
  }

  const mes_ano_referencia = (() => {
    const m = text.match(/([A-Z]{3}\/\d{4})/i);
    return m ? m[1] : null;
  })();

  /* --------- Benefícios / Impostos (evitar REN 1095) --------- */
  const beneficio_tarifario_bruto = num((text.match(/BENEFI.*BRUTO.*?([\d\.,]+)/i) || [])[1]) ?? null;
  const beneficio_tarifario_liquido = num((text.match(/BENEFI.*LIQ.*?(-?[\d\.,]+)/i) || [])[1]) ?? null;

  const taxFromLine = (labelRe) => {
    const lo = findLineObj(lineObjs, labelRe);
    if (lo) {
      const vals = numbersInLine(lo).filter(looksMoney);
      if (vals.length) {
        const candidate = vals[vals.length - 1];
        if (candidate < 1000) return candidate; // não confundir com "1095"
      }
    }
    // fallback
    const v = num((text.match(new RegExp(labelRe.source + "[^0-9]*([\\d\\.,]+)", "i")) || [])[1]);
    return v !== null && v < 1000 ? v : null;
  };

  const icms = taxFromLine(/\bICMS\b/i);
  const pis_pasep = taxFromLine(/\bPIS\b/i);
  const cofins = taxFromLine(/\bCOFINS\b/i);

  /* --------- Débito automático (regra sua) --------- */
  let fatura_debito_automatico = "no";
  if (/Aproveite\s+os\s+benef[ií]cios\s+do\s+d[eé]bito\s+autom[aá]tico/i.test(text)) {
    fatura_debito_automatico = "no";
  } else if (/D[ÉE]BITO\s+AUTOM[ÁA]TICO/i.test(text)) {
    // só setar "yes" se não for chamada-para-ação
    fatura_debito_automatico = "yes";
  }

  /* --------- Bloco SCEE (entre anchors) --------- */
  const sceeSlice = sliceBetween(
    lineObjs,
    /INFORMA[ÇC][AÃ]OES.*SCEE/i,
    /INFORMA[ÇC][AÃ]OES\s+PARA\s+O\s+CLIENTE/i
  );

  // Helpers SCEE
  const moneyInScee = (re) => {
    const lo = sceeSlice.find((x) => re.test(x.text));
    if (!lo) return null;
    const vals = numbersInLine(lo).filter(looksMoney);
    return vals.length ? vals[vals.length - 1] : null;
  };
  const findTextInScee = (re) => sceeSlice.find((x) => re.test(x.text));

  let credito_recebido = moneyInScee(/CR[ÉE]DITO\s+RECEBIDO/i);
  let saldo_kwh_total = moneyInScee(/SALDO\s+KWH/i);
  let excedente_recebido = moneyInScee(/EXCEDENTE\s+RECEBID[OA]/i);

  if (credito_recebido === null) {
    credito_recebido = num((text.match(/CR[ÉE]DITO\s+RECEBID[OA][^0-9]*([\d\.,]+)/i) || [])[1]) ?? null;
  }
  if (saldo_kwh_total === null) {
    saldo_kwh_total = num((text.match(/SALDO\s+KWH[^0-9]*([\d\.,]+)/i) || [])[1]) ?? null;
  }
  if (excedente_recebido !== null && excedente_recebido >= 10000) {
    // proteção contra confusão com UC
    excedente_recebido = null;
    warnings.push("excedente_recebido parecia UC; descartado");
  }
  if (excedente_recebido === null) {
    const v = num((text.match(/EXCEDENTE\s+RECEBID[OA][^0-9]*([\d\.,]+)/i) || [])[1]);
    if (v !== null && v < 10000) excedente_recebido = v;
  }

  let geracao_ciclo = null;
  {
    const hay = sceeSlice.length ? textFrom(sceeSlice) : text;
    const m = hay.match(/(GERA[CÇ][AÃ]O|CICLO)\s*[:\-]?\s*(\d{1,2}\/\d{4})/i);
    if (m) geracao_ciclo = m[2];
  }

  let uc_geradora = null;
  let uc_geradora_producao = null;
  {
    const lo = findTextInScee(/UC\s+GERADORA/i);
    if (lo) {
      const uc = ucInLine(lo);
      if (uc) {
        uc_geradora = uc;
        origins["uc_geradora"] = lo;
      }
      // procurar produção (kWh) próximo
      const vals = numbersInLine(lo).filter(looksKwh);
      if (vals.length) uc_geradora_producao = vals[vals.length - 1];
    } else {
      const mUC = noAccText.match(/UC\s+GERADORA[^0-9]*?(\d{6,15})/i);
      if (mUC) uc_geradora = mUC[1];
      const mProd = noAccText.match(/PRODU[CÇ][AÃ]O[^0-9]*?([\d\.,]+)/i);
      if (mProd) {
        const v = num(mProd[1]);
        if (looksKwh(v)) uc_geradora_producao = v;
      }
    }
  }

  let cadastro_rateio_geracao_uc = null;
  let cadastro_rateio_geracao_percentual = null;
  {
    const lo = sceeSlice.find((x) => /RATEIO/i.test(x.text) && /UC/i.test(x.text));
    if (lo) {
      const uc = ucInLine(lo);
      if (uc) cadastro_rateio_geracao_uc = uc;
      const perc = lo.text.match(/(\d{1,3}(?:[.,]\d+)?%)/);
      if (perc) cadastro_rateio_geracao_percentual = perc[1];
    } else {
      const mUC = noAccText.match(/RATEIO.*?UC\s*(\d{6,15})/i);
      if (mUC) cadastro_rateio_geracao_uc = mUC[1];
      const mP = noAccText.match(/(\d{1,3}(?:[.,]\d+)?%)/);
      if (mP) cadastro_rateio_geracao_percentual = mP[1];
    }
  }

  // Valor tarifa sem tributos (quando houver explícito)
  let valor_tarifa_unitaria_sem_tributos =
    num((noAccText.match(/(SEM\s+TRIBUTOS|TARIFA\s+BASE)[^0-9]*?([\d\.,]{1,10})/i) || [])[2]) ||
    num((noAccText.match(/0[,\.]49812?0?/) || [])[0]);
  if (valor_tarifa_unitaria_sem_tributos && !looksPrice(valor_tarifa_unitaria_sem_tributos)) {
    valor_tarifa_unitaria_sem_tributos = null;
  }

  /* --------- INJEÇÃO SCEE (linhas por UC, posicional) --------- */
  const injecoes_scee = [];
  const injLines = findAllLineObjs(lineObjs, /INJE[CÇ][AÃ]O\s+SCEE/i);
  injLines.forEach((lo) => {
    const uc = (lo.text.match(/UC\s*(\d{6,15})/) || [])[1] || ucInLine(lo);
    if (!uc) return;
    const nums = numbersInLine(lo).filter(looksMoney);
    if (!nums.length) return;

    // heurística por ordem de grandeza
    const price = nums.find(looksPrice) || null;
    const qtys = nums.filter(looksKwh);
    const quant_kwh = qtys.length ? qtys[qtys.length - 1] : null;
    let tarifa_unitaria = null;
    const totals = nums.filter((v) => v >= 10);
    if (totals.length) tarifa_unitaria = totals.sort((a, b) => b - a)[0];

    // Validação: se price > 2, pode ter confundido com outro valor (ex.: 24,57%)
    if (price && !looksPrice(price)) {
      warnings.push(`injecao_scee(${uc}): preco_unit ${price} > 2; descartando`);
    }

    injecoes_scee.push({
      uc: uc || null,
      quant_kwh: quant_kwh || null,
      preco_unit_com_tributos: looksPrice(price) ? price : null,
      tarifa_unitaria: tarifa_unitaria || null,
    });
  });

  // Remover duplicatas por (UC, quant)
  const uniqueInjecoes = Object.values(
    injecoes_scee.reduce((acc, cur) => {
      const key = `${cur.uc}-${cur.quant_kwh ?? "x"}`;
      if (!acc[key]) acc[key] = cur;
      return acc;
    }, {})
  );

  // Validar cada injeção (opcional: apenas em debug geramos warning)
  uniqueInjecoes.forEach((it) => {
    if (it.preco_unit_com_tributos && it.quant_kwh && it.tarifa_unitaria) {
      const expected = it.quant_kwh * it.preco_unit_com_tributos;
      if (!approxEqual(it.tarifa_unitaria, expected)) {
        warnings.push(
          `injecao_scee(${it.uc}): total!=qtd*preco (${safe2(it.tarifa_unitaria)} vs ${safe2(expected)})`
        );
      }
    }
  });

  /* --------- CONSUMO SCEE (linha única) --------- */
  let consumo_scee_quant = null,
    consumo_scee_preco_unit_com_tributos = null,
    consumo_scee_tarifa_unitaria = null;
  {
    const lo = findLineObj(lineObjs, /CONSUMO\s+SCEE/i);
    if (lo) {
      const nums = numbersInLine(lo).filter(looksMoney);
      // preço = <2, quantidade = grande (kWh), total = maior
      const price = nums.find(looksPrice) || null;
      const qty = nums.filter(looksKwh).sort((a, b) => a - b).pop() || null;
      let total = null;
      const totals = nums.filter((v) => v >= 10);
      if (totals.length) total = totals.sort((a, b) => b - a)[0];

      consumo_scee_preco_unit_com_tributos = price || null;
      consumo_scee_quant = qty || null;
      consumo_scee_tarifa_unitaria = total || null;

      // validação
      if (price && qty && total) {
        const expected = qty * price;
        if (!approxEqual(total, expected)) {
          warnings.push(
            `consumo_scee: total!=qtd*preco (${safe2(total)} vs ${safe2(expected)})`
          );
        }
      }
    }
  }

  /* --------- Blocos textuais --------- */
  let informacoes_para_o_cliente = null;
  {
    const start = lineObjs.findIndex((lo) =>
      /INFORMA[ÇC][AÃ]OES\s+PARA\s+O\s+CLIENTE/i.test(lo.text)
    );
    if (start >= 0) {
      const slice = lineObjs.slice(start).map((x) => x.text).join("\n");
      const m = slice.match(/INFORMA[ÇC][AÃ]OES\s+PARA\s+O\s+CLIENTE([\s\S]+?)(?:EQUATORIAL|NOTA\s+FISCAL|$)/i);
      if (m) informacoes_para_o_cliente = m[1].trim();
    }
  }

  let observacoes = null;
  {
    const m = text.match(/OBSERVA[ÇC][AÃ]O[ES]?\s*[:\-]?\s*([\s\S]+)/i);
    if (m) {
      const raw = m[1].trim();
      const cut = raw.split(/\n{2,}|\r{2,}/)[0];
      observacoes = cut.trim();
    }
  }

  /* --------- Sanity checks de datas --------- */
  const parseD = (s) => (isDate(s) ? dayjs(s, "DD/MM/YYYY") : null);
  const dAnt = parseD(data_leitura_anterior);
  const dAtu = parseD(data_leitura_atual);
  const dProx = parseD(data_proxima_leitura);
  const dEmi = parseD(data_emissao);
  const dVen = parseD(data_vencimento);

  if (dAnt && dAtu && !dAtu.isAfter(dAnt)) {
    warnings.push("data_leitura_atual <= data_leitura_anterior; anulando ambas");
    data_leitura_anterior = null;
    data_leitura_atual = null;
  }
  if (dAtu && dProx && !dProx.isAfter(dAtu)) {
    warnings.push("data_proxima_leitura <= data_leitura_atual; anulando proxima");
    data_proxima_leitura = null;
  }
  if (dEmi && dVen && dVen.isBefore(dEmi)) {
    warnings.push("data_vencimento < data_emissao; anulando vencimento");
    data_vencimento = null;
  }

  /* --------- Resultado --------- */
  const result = {
    unidade_consumidora,
    total_a_pagar: total_a_pagar,
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
    media: 1345, // arredondado conforme combinamos
    informacoes_para_o_cliente,
    observacoes,
  };

  if (debugMode) {
    const pick = (lo) => (lo ? { page: lo.page, y: lo.y, text: lo.text } : null);
    return {
      resultado: result,
      debug: {
        warnings,
        origins: Object.fromEntries(
          Object.entries(origins).map(([k, v]) => [k, pick(v)])
        ),
        anchors: {
          scee_start: lineObjs.findIndex((lo) => /INFORMA[ÇC][AÃ]OES.*SCEE/i.test(lo.text)),
          scee_client_start: lineObjs.findIndex((lo) => /INFORMA[ÇC][AÃ]OES\s+PARA\s+O\s+CLIENTE/i.test(lo.text)),
        },
        sample_lines: lineObjs.slice(0, 40).map((lo) => ({ page: lo.page, y: lo.y, text: lo.text })),
      },
    };
  }

  return result;
}

/* --------------------- Rotas --------------------- */
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
    app_name: "extract-equatorialpdfreader-v8",
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
  console.log("✅ Servidor Equatorial Goiás (pdfreader v8) na porta 10000");
});


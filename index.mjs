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
// index.mjs
import express from "express";
import cors from "cors";
import morgan from "morgan";
import multer from "multer";
import crypto from "crypto";
import { PORT, USE_GPT, MODEL_PRIMARY, MODEL_FALLBACK } from "./config/env.mjs";
import { extractTextFromPDF, parseEquatorial } from "./services/localparser.mjs";

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(morgan("tiny"));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 } // 20 MB
});

// Health
app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    versao: "v1-local-stable",
    use_gpt: USE_GPT,
    primary: MODEL_PRIMARY,
    fallback: MODEL_FALLBACK
  });
});

// Extração local (campo do arquivo = "fatura")
app.post("/extract-pdf", upload.single("fatura"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "Arquivo ausente. Envie multipart/form-data com campo 'fatura'." });
    }

    // Salva em /tmp (filesystem volátil do Render) para pdfjs ler
    const tmpPath = `/tmp/${Date.now()}_${req.file.originalname.replace(/\s+/g, "_")}`;
    await fsPromises.writeFile(tmpPath, req.file.buffer);

    // Hash do PDF para deduplicação
    const hash_pdf = crypto.createHash("sha256").update(req.file.buffer).digest("hex");

    // Extrai texto localmente
    const texto = await extractTextFromPDF(tmpPath);

    // Faz o parsing por regex
    const parsed = parseEquatorial(texto);

    // Retorna
    return res.json({
      status: "ok",
      hash_pdf,
      arquivo: req.file.originalname,
      extraido_local: true,
      dados: parsed
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Falha ao processar a fatura." });
  }
});

import { promises as fsPromises } from "fs";

app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
});


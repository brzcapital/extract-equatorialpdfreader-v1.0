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

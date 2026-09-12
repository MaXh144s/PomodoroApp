/**
 * cycles.js
 * Cálculo de ciclos de estudo: ciclo completo, ciclo parcial (fracionário),
 * equivalência entre durações diferentes e agregação de múltiplas sessões.
 *
 * Regras (do prompt original):
 * - Ciclo = tempo efetivamente estudado ÷ tempo configurado para aquela sessão.
 * - NUNCA arredondar o valor internamente. Arredondamento só acontece na
 *   formatação para exibição (formatCycleCount).
 * - O histórico preserva as durações reais; a "equivalência em ciclos de Xmin"
 *   é apenas uma métrica de comparação, calculada por cima do histórico.
 *
 * Este módulo é puro (sem I/O, sem DOM, sem localStorage) — só matemática.
 * Trabalha inteiramente em milissegundos para não perder precisão.
 */

/**
 * Calcula o progresso de ciclo de uma única sessão.
 * @param {number} studiedMs - tempo efetivamente estudado, em ms
 * @param {number} configuredMs - tempo configurado para essa sessão, em ms
 * @returns {{
 *   fraction: number,          // ex: 0.625 (25min estudados de 40min configurados)
 *   completeCycles: number,    // parte inteira (quantos ciclos completos cabem no tempo estudado)
 *   partialFraction: number,   // fração do ciclo atual em andamento (0 a <1)
 *   remainingMsToNextCycle: number // quanto falta, em ms, para fechar o próximo ciclo completo
 * }}
 */
export function computeCycleProgress(studiedMs, configuredMs) {
  _assertNonNegative(studiedMs, 'studiedMs');
  _assertPositive(configuredMs, 'configuredMs');

  const fraction = studiedMs / configuredMs;
  const completeCycles = Math.floor(fraction);
  const partialFraction = fraction - completeCycles;
  const remainingMsToNextCycle = partialFraction === 0
    ? 0
    : configuredMs - (studiedMs % configuredMs);

  return { fraction, completeCycles, partialFraction, remainingMsToNextCycle };
}

/**
 * Equivalência de um tempo total estudado em "ciclos" de outra duração de referência.
 * Ex: 330min estudados ÷ 50min (duração de referência) = 6,6 ciclos.
 * @param {number} totalStudiedMs
 * @param {number} referenceCycleMs
 * @returns {number} fração exata (não arredondada)
 */
export function computeEquivalentCycles(totalStudiedMs, referenceCycleMs) {
  _assertNonNegative(totalStudiedMs, 'totalStudiedMs');
  _assertPositive(referenceCycleMs, 'referenceCycleMs');
  return totalStudiedMs / referenceCycleMs;
}

/**
 * Soma o tempo estudado de uma lista de sessões.
 * @param {Array<{studiedMs: number}>} sessions
 * @returns {number} total em ms
 */
export function sumStudiedMs(sessions) {
  return sessions.reduce((total, s) => total + (s.studiedMs || 0), 0);
}

/**
 * Agrupa sessões por duração configurada (mesma configuração = mesmo grupo)
 * e soma ciclos completos + fração parcial dentro de cada grupo.
 *
 * Isso resolve o caso do prompt: "Sessão 1: 25min, 2 ciclos completos.
 * Sessão 2: 40min, 1 ciclo completo + 15min." — cada configuração mantém
 * sua própria contabilização, sem misturar com as outras.
 *
 * @param {Array<{studiedMs: number, configuredMs: number}>} sessions
 * @returns {Array<{
 *   configuredMs: number,
 *   totalStudiedMs: number,
 *   completeCycles: number,
 *   partialFraction: number,
 *   sessionCount: number
 * }>}
 */
export function aggregateCyclesByConfig(sessions) {
  const groups = new Map();

  for (const session of sessions) {
    const key = session.configuredMs;
    if (!groups.has(key)) {
      groups.set(key, { configuredMs: key, totalStudiedMs: 0, sessionCount: 0 });
    }
    const group = groups.get(key);
    group.totalStudiedMs += session.studiedMs;
    group.sessionCount += 1;
  }

  return Array.from(groups.values()).map((group) => {
    const progress = computeCycleProgress(group.totalStudiedMs, group.configuredMs);
    return {
      configuredMs: group.configuredMs,
      totalStudiedMs: group.totalStudiedMs,
      completeCycles: progress.completeCycles,
      partialFraction: progress.partialFraction,
      sessionCount: group.sessionCount,
    };
  });
}

/**
 * Resumo agregado de todas as sessões de um dia (ou de qualquer conjunto):
 * tempo total estudado, ciclos completos somados (por configuração) e
 * equivalência em uma duração de referência à escolha.
 *
 * @param {Array<{studiedMs: number, configuredMs: number}>} sessions
 * @param {number} [referenceCycleMs] - duração usada para a equivalência (padrão: 50min)
 * @returns {{
 *   totalStudiedMs: number,
 *   totalCompleteCycles: number,
 *   equivalentCycles: number,
 *   sessionCount: number,
 *   byConfig: ReturnType<typeof aggregateCyclesByConfig>
 * }}
 */
export function computeDailySummary(sessions, referenceCycleMs = 50 * 60 * 1000) {
  const totalStudiedMs = sumStudiedMs(sessions);
  const byConfig = aggregateCyclesByConfig(sessions);
  const totalCompleteCycles = byConfig.reduce((sum, g) => sum + g.completeCycles, 0);
  const equivalentCycles = totalStudiedMs > 0
    ? computeEquivalentCycles(totalStudiedMs, referenceCycleMs)
    : 0;

  return {
    totalStudiedMs,
    totalCompleteCycles,
    equivalentCycles,
    sessionCount: sessions.length,
    byConfig,
  };
}

// ---------- Formatação (única camada onde arredondamento é permitido) ----------

/**
 * Formata uma quantidade de ciclos (fracionária) para exibição, com vírgula
 * decimal (pt-BR) e um número razoável de casas decimais.
 * @param {number} value
 * @param {number} [decimals=1]
 * @returns {string} ex: "6,6"
 */
export function formatCycleCount(value, decimals = 1) {
  return value.toFixed(decimals).replace('.', ',');
}

/**
 * Formata uma duração em ms como "Xh Ymin" (omitindo horas se for 0).
 * @param {number} ms
 * @returns {string} ex: "5h30min", "45min"
 */
export function formatDuration(ms) {
  _assertNonNegative(ms, 'ms');
  const totalMinutes = Math.round(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours === 0) return `${minutes}min`;
  if (minutes === 0) return `${hours}h`;
  return `${hours}h${String(minutes).padStart(2, '0')}min`;
}

/**
 * Monta a mensagem sugerida quando um ciclo está parcialmente concluído,
 * ex: "Estude mais 15 minutos para completar 1 ciclo de 40 minutos."
 * Retorna null se o ciclo já estiver completo (partialFraction === 0).
 * @param {{configuredMs: number, remainingMsToNextCycle: number, partialFraction: number}} progress
 * @returns {string|null}
 */
export function buildPartialCycleMessage(progress, configuredMs) {
  if (progress.partialFraction === 0) return null;
  const remainingMin = Math.ceil(progress.remainingMsToNextCycle / 60000);
  const configuredMin = Math.round(configuredMs / 60000);
  return `Estude mais ${remainingMin} minutos para completar 1 ciclo de ${configuredMin} minutos.`;
}

// ---------- Validação interna ----------

function _assertPositive(value, name) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} deve ser um número positivo.`);
  }
}

function _assertNonNegative(value, name) {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} deve ser um número maior ou igual a zero.`);
  }
}
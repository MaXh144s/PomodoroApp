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
  studiedMs = _clampNonNegative(studiedMs, 'studiedMs');
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
  totalStudiedMs = _clampNonNegative(totalStudiedMs, 'totalStudiedMs');
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
 * Conta quantos CICLOS distintos existem numa lista de registros. Um ciclo
 * pausado e retomado várias vezes gera vários registros (um por período de
 * execução), todos com o mesmo cycleId — e deve contar como um só.
 * Registros sem cycleId (legado, ou usos puramente matemáticos deste módulo)
 * usam o id; sem id nenhum, cada registro conta como um ciclo próprio.
 * @param {Array<{cycleId?: string, id?: string}>} sessions
 * @returns {number}
 */
export function countDistinctCycles(sessions) {
  const keys = new Set();
  let anonymous = 0;
  for (const s of sessions) {
    const key = s.cycleId ?? s.id;
    if (key == null) anonymous += 1;
    else keys.add(key);
  }
  return keys.size + anonymous;
}

/**
 * Normaliza um texto de assunto SÓ para fins de agrupamento (nunca para
 * exibição): remove acentuação, colapsa espaços duplicados/nas pontas e
 * ignora maiúsculas/minúsculas. Assim "Matemática", " matemática" e
 * "MATEMÁTICA" são reconhecidos como o mesmo assunto mesmo com diferenças
 * de digitação. Assunto vazio/ausente cai em "Estudo geral", igual ao
 * padrão já usado em createSessionRecord (history.js).
 * @param {string} [subject]
 * @returns {string}
 */
export function normalizeSubjectKey(subject) {
  return (subject || 'Estudo geral')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/**
 * Agrupa sessões por assunto (ver normalizeSubjectKey) e soma, para cada
 * grupo: quantidade de sessões (ciclos distintos, via countDistinctCycles),
 * ciclos completos (somados por configuração, como em computeDailySummary —
 * cobre o caso de o mesmo assunto ter sido estudado com durações
 * configuradas diferentes) e tempo total estudado.
 *
 * O rótulo exibido do grupo é o texto do assunto (com espaços nas pontas
 * removidos) tal como apareceu na primeira sessão daquele grupo — a
 * normalização serve só para decidir quem entra em qual grupo, nunca para
 * o que é mostrado na tela.
 *
 * @param {Array<{subject?: string, studiedMs: number, configuredMs: number, cycleId?: string, id?: string}>} sessions
 * @returns {Array<{subject: string, subjectKey: string, sessionCount: number, completeCycles: number, totalStudiedMs: number}>}
 *          ordenado do maior tempo estudado para o menor. `subjectKey` é o
 *          resultado de normalizeSubjectKey() para aquele grupo — usar para
 *          identificar o assunto de forma estável (ex: ao apagar só aquele
 *          assunto do histórico), nunca `subject` (rótulo de exibição, pode
 *          ter variado de digitação entre as sessões do próprio grupo).
 */
export function aggregateSessionsBySubject(sessions) {
  const groups = new Map();

  for (const session of sessions) {
    const key = normalizeSubjectKey(session.subject);
    if (!groups.has(key)) {
      groups.set(key, {
        subject: (session.subject || 'Estudo geral').trim() || 'Estudo geral',
        sessions: [],
      });
    }
    groups.get(key).sessions.push(session);
  }

  return Array.from(groups.entries())
    .map(([subjectKey, { subject, sessions: groupSessions }]) => {
      const byConfig = aggregateCyclesByConfig(groupSessions);
      const completeCycles = byConfig.reduce((sum, g) => sum + g.completeCycles, 0);
      return {
        subject,
        subjectKey,
        sessionCount: countDistinctCycles(groupSessions),
        completeCycles,
        totalStudiedMs: sumStudiedMs(groupSessions),
      };
    })
    .sort((a, b) => b.totalStudiedMs - a.totalStudiedMs);
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
    sessionCount: countDistinctCycles(sessions),
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
  ms = _clampNonNegative(ms, 'ms');
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

/**
 * Valida que um valor é um número finito e, se for um negativo pequeno
 * (jitter de ponto flutuante entre timestamps — fica mais provável com o
 * acelerador de debug.js, que amplia esse jitter junto com o tempo), trata
 * como zero em vez de lançar erro: é um caso esperado de exibição, não um
 * dado inválido. Só lança erro para o que é realmente inválido (NaN,
 * Infinity, ou não-número).
 */
function _clampNonNegative(value, name) {
  if (!Number.isFinite(value)) {
    throw new Error(`${name} deve ser um número finito.`);
  }
  return value < 0 ? 0 : value;
}
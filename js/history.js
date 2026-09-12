/**
 * history.js
 * Histórico de sessões de estudo.
 *
 * Responsabilidades:
 * - Criar o registro de uma sessão concluída (com todos os campos exigidos
 *   pelo prompt: data, início, término, tempo configurado, tempo estudado,
 *   tempo de descanso, ciclos completos, fração de ciclo).
 * - Persistir via storage.js, sempre adicionando (nunca apagando sessões
 *   anteriores ao criar uma nova configuração).
 * - Agrupar e resumir sessões por dia, delegando toda a matemática de
 *   ciclos para cycles.js (este módulo não recalcula nada por conta própria).
 *
 * Este módulo não sabe nada sobre timers ou UI — apenas dados e agregação.
 */

import {
  appendSession,
  loadSessions,
} from './storage.js';

import {
  computeCycleProgress,
  computeDailySummary,
  sumStudiedMs,
  formatDuration,
  formatCycleCount,
} from './cycles.js';

const DEFAULT_REFERENCE_CYCLE_MS = 50 * 60 * 1000; // 50min, usado nos exemplos do prompt

// ---------- Criação de registros ----------

/**
 * Monta o registro de uma sessão de estudo concluída (ou interrompida).
 * Não persiste por si só — use saveCompletedSession() para isso.
 *
 * @param {Object} params
 * @param {number} params.startTimestamp - Date.now() de quando o estudo começou
 * @param {number} params.endTimestamp - Date.now() de quando o estudo terminou/parou
 * @param {number} params.configuredMs - tempo configurado para essa sessão
 * @param {number} params.studiedMs - tempo efetivamente estudado (pode ser < configuredMs)
 * @param {number} params.restMs - tempo de descanso configurado/associado a essa sessão
 * @returns {Object} registro de sessão, pronto para ser salvo no histórico
 */
export function createSessionRecord({ startTimestamp, endTimestamp, configuredMs, studiedMs, restMs }) {
  const progress = computeCycleProgress(studiedMs, configuredMs);
  const startDate = new Date(startTimestamp);

  return {
    id: `${startTimestamp}-${Math.random().toString(36).slice(2, 8)}`,
    date: _toDateKey(startDate),
    startTimestamp,
    endTimestamp,
    configuredMs,
    studiedMs,
    restMs,
    completeCycles: progress.completeCycles,
    partialFraction: progress.partialFraction,
  };
}

/**
 * Salva uma sessão concluída no histórico persistente, sem apagar as
 * sessões anteriores — apenas adiciona ao final da lista.
 * @param {Object} sessionRecord - resultado de createSessionRecord()
 * @returns {Promise<Array<Object>>} lista completa de sessões após a inclusão
 */
export async function saveCompletedSession(sessionRecord) {
  return appendSession(sessionRecord);
}

// ---------- Consulta ----------

/** @returns {Promise<Array<Object>>} todas as sessões já registradas, de todos os dias */
export async function getAllSessions() {
  return loadSessions();
}

/** @returns {string} chave "YYYY-MM-DD" de hoje (fuso horário local) — útil pra UI comparar sem duplicar a formatação. */
export function getTodayDateKey() {
  return _toDateKey(new Date());
}

/**
 * @param {string} dateKey - formato "YYYY-MM-DD"
 * @returns {Promise<Array<Object>>} sessões daquele dia específico
 */
export async function getSessionsForDate(dateKey) {
  const sessions = await loadSessions();
  return sessions.filter((s) => s.date === dateKey);
}

/** @returns {Promise<Array<Object>>} sessões de hoje (fuso horário local) */
export async function getTodaySessions() {
  return getSessionsForDate(_toDateKey(new Date()));
}

/**
 * Resumo dos últimos N dias (padrão 7, incluindo hoje), na ordem do mais
 * antigo para o mais recente — pronto para plotar um gráfico semanal.
 * Ao contrário de getFullHistorySummary(), NÃO pula dias sem sessão: um dia
 * sem nenhum estudo aparece com totalStudiedMs = 0, o que é essencial pra um
 * gráfico não "pular" dias vazios e distorcer a leitura visual.
 *
 * @param {number} [days=7]
 * @param {number} [referenceCycleMs=50min]
 * @returns {Promise<Array<ReturnType<typeof computeDailySummary> & {dateKey: string}>>}
 */
export async function getLastNDaysSummary(days = 7, referenceCycleMs = DEFAULT_REFERENCE_CYCLE_MS) {
  const sessions = await loadSessions();
  const today = new Date();
  const result = [];

  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
    const dateKey = _toDateKey(date);
    const daySessions = sessions.filter((s) => s.date === dateKey);
    const summary = computeDailySummary(daySessions, referenceCycleMs);
    result.push({ dateKey, ...summary });
  }

  return result;
}

/**
 * Resumo de um dia específico: tempo total estudado, ciclos completos por
 * configuração, equivalência em ciclos de referência e quantidade de sessões.
 * Toda a matemática vem de cycles.js — este módulo só filtra os dados certos.
 *
 * @param {string} dateKey - formato "YYYY-MM-DD"
 * @param {number} [referenceCycleMs=50min]
 * @returns {Promise<ReturnType<typeof computeDailySummary> & {dateKey: string}>}
 */
export async function getDailySummary(dateKey, referenceCycleMs = DEFAULT_REFERENCE_CYCLE_MS) {
  const sessions = await getSessionsForDate(dateKey);
  const summary = computeDailySummary(sessions, referenceCycleMs);
  return { dateKey, ...summary };
}

/** Atalho para getDailySummary() com a data de hoje. */
export async function getTodaySummary(referenceCycleMs = DEFAULT_REFERENCE_CYCLE_MS) {
  return getDailySummary(_toDateKey(new Date()), referenceCycleMs);
}

/**
 * Agrupa TODO o histórico por dia, retornando um resumo por data —
 * útil para uma tela de "histórico completo" (não só o dia atual).
 * @param {number} [referenceCycleMs=50min]
 * @returns {Promise<Array<ReturnType<typeof computeDailySummary> & {dateKey: string}>>}
 *          ordenado do dia mais recente para o mais antigo
 */
export async function getFullHistorySummary(referenceCycleMs = DEFAULT_REFERENCE_CYCLE_MS) {
  const sessions = await loadSessions();
  const dateKeys = [...new Set(sessions.map((s) => s.date))].sort().reverse();

  return dateKeys.map((dateKey) => {
    const daySessions = sessions.filter((s) => s.date === dateKey);
    const summary = computeDailySummary(daySessions, referenceCycleMs);
    return { dateKey, ...summary };
  });
}

// ---------- Mensagens de apresentação (delegando formatação a cycles.js) ----------

/**
 * Monta a mensagem motivacional com base no tempo total estudado no dia.
 * Ex: "Parabéns! Você estudou cerca de 5h30min hoje."
 * Se ainda não houve nenhum minuto estudado, retorna um convite a começar.
 * @param {number} totalStudiedMs
 * @returns {string}
 */
export function buildMotivationalMessage(totalStudiedMs) {
  if (totalStudiedMs <= 0) {
    return 'Comece seu primeiro ciclo de estudo hoje!';
  }
  return `Parabéns! Você estudou cerca de ${formatDuration(totalStudiedMs)} hoje.`;
}

/**
 * Monta a frase de equivalência em ciclos de referência.
 * Ex: "Isso equivale a aproximadamente 6,6 ciclos de 50min."
 * @param {number} equivalentCycles
 * @param {number} referenceCycleMs
 * @returns {string}
 */
export function buildEquivalenceMessage(equivalentCycles, referenceCycleMs) {
  const referenceMin = Math.round(referenceCycleMs / 60000);
  return `Isso equivale a aproximadamente ${formatCycleCount(equivalentCycles)} ciclos de ${referenceMin}min.`;
}

/**
 * Resumo textual completo do dia, pronto para exibir na tela inicial
 * (combina os itens 12 do prompt: tempo estudado, ciclos, equivalência, sessões).
 * @param {Object} dailySummary - resultado de getDailySummary()/getTodaySummary()
 * @param {number} referenceCycleMs
 * @returns {{
 *   motivational: string,
 *   equivalence: string,
 *   totalStudiedLabel: string,
 *   totalCompleteCycles: number,
 *   sessionCount: number
 * }}
 */
export function buildDailySummaryLabels(dailySummary, referenceCycleMs = DEFAULT_REFERENCE_CYCLE_MS) {
  return {
    motivational: buildMotivationalMessage(dailySummary.totalStudiedMs),
    equivalence: buildEquivalenceMessage(dailySummary.equivalentCycles, referenceCycleMs),
    totalStudiedLabel: formatDuration(dailySummary.totalStudiedMs),
    totalCompleteCycles: dailySummary.totalCompleteCycles,
    sessionCount: dailySummary.sessionCount,
  };
}

// ---------- Internos ----------

/** Converte uma Date em chave "YYYY-MM-DD" no fuso horário local (não UTC). */
function _toDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
/**
 * history.js
 * Histórico de sessões de estudo.
 *
 * Modelo de contabilização: cada registro é UM PERÍODO REAL DE EXECUÇÃO do
 * cronômetro de estudo, delimitado por dateStart (quando começou/retomou) e
 * dateEnd (quando pausou ou terminou). Um ciclo pode ter vários períodos
 * (separados por pausas), todos ligados pelo mesmo cycleId. O tempo estudado
 * de um período é exatamente dateEnd - dateStart: nunca "o que faltava" do
 * ciclo, nunca o tempo entre uma pausa e a retomada.
 *
 * Responsabilidades:
 * - Criar o registro de um período de estudo (data, dateStart, dateEnd, tempo
 *   configurado, tempo estudado, tempo de descanso, ciclos completos, fração
 *   de ciclo e cycleId).
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
  saveSessions,
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
 * Monta o registro de um período de execução do estudo.
 * Não persiste por si só — use saveCompletedSession() para isso.
 *
 * @param {Object} params
 * @param {number} params.dateStart - timestamp de quando o período começou (início ou retomada)
 * @param {number} params.dateEnd - timestamp de quando o período terminou (pausa ou fim do ciclo)
 * @param {number} params.configuredMs - tempo configurado para o ciclo a que este período pertence
 * @param {number} params.studiedMs - tempo efetivamente estudado neste período
 * @param {number} params.restMs - tempo de descanso configurado/associado a esse ciclo
 * @param {string} [params.cycleId] - identifica o ciclo; todos os períodos do mesmo ciclo compartilham o id
 * @returns {Object} registro, pronto para ser salvo no histórico
 */
export function createSessionRecord({ dateStart, dateEnd, configuredMs, studiedMs, restMs, cycleId }) {
  const progress = computeCycleProgress(studiedMs, configuredMs);
  const startDate = new Date(dateStart);
  const id = `${dateStart}-${Math.random().toString(36).slice(2, 8)}`;

  return {
    id,
    cycleId: cycleId ?? id,
    date: _toDateKey(startDate),
    dateStart,
    dateEnd,
    configuredMs,
    studiedMs,
    restMs,
    completeCycles: progress.completeCycles,
    partialFraction: progress.partialFraction,
  };
}

/**
 * Registros gravados antes do modelo por períodos usam startTimestamp/
 * endTimestamp e não têm cycleId. Esta função devolve o registro com
 * dateStart/dateEnd/cycleId preenchidos (a partir dos campos antigos, sem
 * alterar o que está salvo no storage), para que o resto do app leia um
 * formato único. Um registro legado conta como um ciclo próprio (cycleId = id).
 * @param {Object} record
 * @returns {Object}
 */
export function normalizeSessionRecord(record) {
  return {
    ...record,
    cycleId: record.cycleId ?? record.id,
    dateStart: record.dateStart ?? record.startTimestamp ?? null,
    dateEnd: record.dateEnd ?? record.endTimestamp ?? null,
  };
}

async function _loadNormalizedSessions() {
  const sessions = await loadSessions();
  return sessions.map(normalizeSessionRecord);
}

/**
 * Salva um período de estudo no histórico persistente, sem apagar os
 * anteriores — apenas adiciona ao final da lista.
 * @param {Object} sessionRecord - resultado de createSessionRecord()
 * @returns {Promise<Array<Object>>} lista completa de sessões após a inclusão
 */
export async function saveCompletedSession(sessionRecord) {
  return appendSession(sessionRecord);
}

// ---------- Tempo decorrido através da virada do dia ----------

/**
 * Divide um intervalo real [startTimestamp, endTimestamp) em pedaços que
 * não atravessam a meia-noite local, cada um já rotulado com sua chave de
 * dia ("YYYY-MM-DD"). Cobre o caso de um trecho de estudo que começa antes
 * da meia-noite e só é pausado (ou finalizado) depois dela: em vez de todo
 * o tempo cair inteiro no dia de início ou no dia de término, o intervalo é
 * repartido exatamente na virada, e cada pedaço carrega apenas o tempo que
 * realmente decorreu dentro daquele dia. Funciona também para intervalos
 * que atravessem mais de uma meia-noite (ex: app deixado rodando por dias).
 *
 * @param {number} startTimestamp
 * @param {number} endTimestamp - deve ser >= startTimestamp
 * @returns {Array<{dateKey: string, startTimestamp: number, endTimestamp: number, ms: number}>}
 */
export function splitIntervalByLocalDay(startTimestamp, endTimestamp) {
  if (!(endTimestamp > startTimestamp)) return [];

  const segments = [];
  let cursor = startTimestamp;

  while (cursor < endTimestamp) {
    const cursorDate = new Date(cursor);
    // Meia-noite local do dia seguinte ao do cursor — fronteira do pedaço atual.
    const nextMidnight = new Date(
      cursorDate.getFullYear(),
      cursorDate.getMonth(),
      cursorDate.getDate() + 1,
      0, 0, 0, 0
    ).getTime();

    const segmentEnd = Math.min(nextMidnight, endTimestamp);
    segments.push({
      dateKey: _toDateKey(cursorDate),
      startTimestamp: cursor,
      endTimestamp: segmentEnd,
      ms: segmentEnd - cursor,
    });
    cursor = segmentEnd;
  }

  return segments;
}

/**
 * Registra no histórico um período real de execução [dateStart, dateEnd),
 * repartindo automaticamente em um registro por dia local sempre que o
 * período atravessa a meia-noite (ver splitIntervalByLocalDay). Cada pedaço é
 * creditado ao dia em que o tempo efetivamente decorreu.
 *
 * Ponto único de gravação de tempo estudado: todo período que se encerra
 * (pausa, saída da tela, reinício de ciclo, fim de ciclo) deve passar por
 * aqui em vez de chamar createSessionRecord()/saveCompletedSession()
 * diretamente.
 *
 * @param {Object} params
 * @param {number} params.dateStart
 * @param {number} params.dateEnd
 * @param {number} params.configuredMs
 * @param {number} params.restMs
 * @param {string} [params.cycleId]
 * @returns {Promise<Array<Object>>} registros salvos (um por dia envolvido)
 */
export async function saveStudySegment({ dateStart, dateEnd, configuredMs, restMs, cycleId }) {
  const dayChunks = splitIntervalByLocalDay(dateStart, dateEnd);
  const savedRecords = [];

  for (const chunk of dayChunks) {
    if (chunk.ms <= 0) continue;
    const record = createSessionRecord({
      dateStart: chunk.startTimestamp,
      dateEnd: chunk.endTimestamp,
      configuredMs,
      studiedMs: chunk.ms,
      restMs,
      cycleId,
    });
    await saveCompletedSession(record);
    savedRecords.push(record);
  }

  return savedRecords;
}

// ---------- Consulta ----------

/** @returns {Promise<Array<Object>>} todos os períodos já registrados, de todos os dias (já normalizados) */
export async function getAllSessions() {
  return _loadNormalizedSessions();
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
  const sessions = await _loadNormalizedSessions();
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
  const sessions = await _loadNormalizedSessions();
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
  const sessions = await _loadNormalizedSessions();
  const dateKeys = [...new Set(sessions.map((s) => s.date))].sort().reverse();

  return dateKeys.map((dateKey) => {
    const daySessions = sessions.filter((s) => s.date === dateKey);
    const summary = computeDailySummary(daySessions, referenceCycleMs);
    return { dateKey, ...summary };
  });
}

// ---------- Gerenciamento do histórico (excluir / exportar / importar) ----------
//
// Tudo aqui opera sobre a MESMA lista de sessões de storage.js — não existe
// uma segunda estrutura de histórico. "Excluir pela interface" remove
// registros do histórico ativo (STORAGE_KEYS.SESSIONS); não apaga nada de
// um arquivo JSON já exportado anteriormente, que continua servindo como
// backup independente da persistência local.
//
// Importante sobre a data de "hoje" (seção 4 do pedido): como cada sessão
// já é um registro imutável e independente (ver saveStudySegment acima),
// excluir todos os registros de um dia — inclusive hoje — não deixa
// nenhum estado residual. Um novo período de estudo criado depois disso
// simplesmente gera um novo registro para aquele dia, do zero, sem
// nenhuma lógica extra: getDailySummary()/getFullHistorySummary() só
// enxergam o que está salvo agora.

const HISTORY_BACKUP_VERSION = 1;

/**
 * Remove do histórico ativo TODOS os registros de um ou mais dias
 * ("YYYY-MM-DD"). Usado pela lixeira da tela inicial. Não afeta backups já
 * exportados — um arquivo JSON exportado antes da exclusão continua tendo
 * esses registros e pode recriá-los via commitHistoryImport().
 * @param {string|Array<string>} dateKeys
 * @returns {Promise<Array<Object>>} sessões restantes após a exclusão
 */
export async function deleteSessionsForDates(dateKeys) {
  const keys = new Set(Array.isArray(dateKeys) ? dateKeys : [dateKeys]);
  const sessions = await loadSessions();
  const remaining = sessions.filter((s) => !keys.has(s.date));
  await saveSessions(remaining);
  return remaining;
}

/**
 * Monta o backup completo do histórico atual, pronto para ser serializado em
 * JSON e baixado pelo usuário. Guarda os registros exatamente como estão
 * salvos (sem normalizar), preservando id, cycleId, datas e horários
 * originais — o necessário para reconstruir o histórico e seus ciclos numa
 * futura importação sem perda de informação.
 * @returns {Promise<{version: number, exportedAt: string, sessions: Array<Object>}>}
 */
export async function buildHistoryBackup() {
  const sessions = await loadSessions();
  return {
    version: HISTORY_BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    sessions,
  };
}

/**
 * Normaliza (e valida) um registro vindo de um arquivo importado, aceitando
 * tanto o formato atual (dateStart/dateEnd/cycleId) quanto o formato legado
 * de antes do modelo por períodos de execução (startTimestamp/endTimestamp,
 * sem cycleId — ver normalizeSessionRecord()). O objetivo é NUNCA descartar
 * um registro antigo só porque ele usa os nomes de campo de época: desde
 * que dê para recuperar quando ele começou e terminou, o registro é
 * reconstruído (preenchendo o que faltar a partir dessas datas) em vez de
 * jogado fora.
 *
 * Só retorna null quando não há como saber quando aquele estudo aconteceu
 * (sem dateStart/startTimestamp e dateEnd/endTimestamp válidos) — aí sim
 * não há dado nenhum para recuperar.
 *
 * @param {*} raw
 * @returns {Object|null} registro completo no formato atual, ou null se irrecuperável
 */
function _normalizeImportedRecord(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const dateStart = Number.isFinite(raw.dateStart)
    ? raw.dateStart
    : (Number.isFinite(raw.startTimestamp) ? raw.startTimestamp : null);
  const dateEnd = Number.isFinite(raw.dateEnd)
    ? raw.dateEnd
    : (Number.isFinite(raw.endTimestamp) ? raw.endTimestamp : null);

  // Sem início e fim válidos não há o que recuperar: é a única condição que
  // realmente invalida um registro.
  if (dateStart == null || dateEnd == null || dateEnd < dateStart) return null;

  const cycleId = (typeof raw.cycleId === 'string' && raw.cycleId)
    ? raw.cycleId
    : ((typeof raw.id === 'string' && raw.id) ? raw.id : null);

  // Sem id salvo, gera um determinístico a partir das próprias datas (não
  // aleatório) — assim, reimportar o mesmo arquivo de novo continua sendo
  // reconhecido como o mesmo registro (duplicateCount), em vez de duplicar
  // a cada nova tentativa de importação.
  const id = (typeof raw.id === 'string' && raw.id)
    ? raw.id
    : `legacy-${cycleId ?? 'x'}-${dateStart}-${dateEnd}`;

  const date = (typeof raw.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.date))
    ? raw.date
    : _toDateKey(new Date(dateStart));

  const studiedMs = (Number.isFinite(raw.studiedMs) && raw.studiedMs >= 0)
    ? raw.studiedMs
    : Math.max(0, dateEnd - dateStart);
  const configuredMs = (Number.isFinite(raw.configuredMs) && raw.configuredMs > 0)
    ? raw.configuredMs
    : Math.max(studiedMs, 1);
  const restMs = (Number.isFinite(raw.restMs) && raw.restMs >= 0) ? raw.restMs : 0;

  const progress = computeCycleProgress(studiedMs, configuredMs);

  return {
    id,
    cycleId: cycleId ?? id,
    date,
    dateStart,
    dateEnd,
    configuredMs,
    studiedMs,
    restMs,
    completeCycles: Number.isFinite(raw.completeCycles) ? raw.completeCycles : progress.completeCycles,
    partialFraction: Number.isFinite(raw.partialFraction) ? raw.partialFraction : progress.partialFraction,
  };
}

/** Diz se um registro precisou de algum campo reconstruído (formato legado/incompleto), para informar o usuário na prévia da importação. */
function _wasRecordIncomplete(raw) {
  return !(
    Number.isFinite(raw?.dateStart)
    && Number.isFinite(raw?.dateEnd)
    && typeof raw?.id === 'string' && raw.id
    && typeof raw?.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.date)
    && Number.isFinite(raw?.configuredMs) && raw.configuredMs > 0
  );
}

/**
 * Analisa um backup (já parseado de JSON) SEM alterar nada salvo — é a
 * prévia mostrada ao usuário antes de confirmar a importação. Registros com
 * o mesmo "id" de uma sessão já existente no histórico ativo são tratados
 * como já importados (contam em duplicateCount) e ficam de fora de
 * newSessions, exatamente para uma reimportação do mesmo backup nunca
 * duplicar ciclos/registros. Registros com estrutura inválida contam em
 * invalidCount e também ficam de fora.
 * @param {*} data - conteúdo já parseado do arquivo .json escolhido pelo usuário
 * @returns {Promise<{
 *   isValid: boolean,
 *   error: string|null,
 *   newSessions: Array<Object>,
 *   duplicateCount: number,
 *   invalidCount: number,
 *   recoveredCount: number,
 *   totalInFile: number
 * }>}
 */
export async function validateHistoryBackup(data) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.sessions)) {
    return {
      isValid: false,
      error: 'Arquivo inválido: não parece ser um backup de histórico deste app (esperava um objeto com uma lista "sessions").',
      newSessions: [],
      duplicateCount: 0,
      invalidCount: 0,
      recoveredCount: 0,
      totalInFile: 0,
    };
  }

  const existingSessions = await loadSessions();
  const existingIds = new Set(existingSessions.map((s) => s.id));

  const newSessions = [];
  let duplicateCount = 0;
  let invalidCount = 0;
  let recoveredCount = 0;

  for (const raw of data.sessions) {
    const normalized = _normalizeImportedRecord(raw);
    if (!normalized) {
      invalidCount += 1;
      continue;
    }
    if (existingIds.has(normalized.id)) {
      duplicateCount += 1;
      continue;
    }
    if (_wasRecordIncomplete(raw)) recoveredCount += 1;
    newSessions.push(normalized);
  }

  return {
    isValid: true,
    error: null,
    newSessions,
    duplicateCount,
    invalidCount,
    recoveredCount,
    totalInFile: data.sessions.length,
  };
}

/**
 * Aplica uma importação já validada (ver validateHistoryBackup): adiciona ao
 * histórico ativo somente os registros novos — o filtro por id duplicado já
 * foi feito na validação, por isso NUNCA sobrescreve ou apaga um registro
 * existente, só soma o que ainda não estava lá (ex: um dia excluído pela
 * lixeira e recuperado agora a partir do backup).
 * @param {Array<Object>} newSessions - o campo `newSessions` retornado por validateHistoryBackup
 * @returns {Promise<Array<Object>>} histórico completo após a importação
 */
export async function commitHistoryImport(newSessions) {
  if (!newSessions || newSessions.length === 0) return loadSessions();
  const existingSessions = await loadSessions();
  const merged = existingSessions.concat(newSessions);
  await saveSessions(merged);
  return merged;
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
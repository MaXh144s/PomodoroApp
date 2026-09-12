/**
 * preferences.js
 * Preferências do usuário para o app: proporção padrão de estudo/descanso
 * (usada para sugerir o descanso ao criar um novo temporizador) e duração de
 * estudo padrão sugerida.
 *
 * Este módulo é puro (sem I/O, sem DOM) — só regras e cálculos. A
 * persistência (ler/salvar) fica a cargo de storage.js, como todo o resto
 * do app.
 */

export const DEFAULT_RATIO_STUDY_PART = 5; // proporção padrão 5:1 (mesma referência histórica do app)
export const DEFAULT_RATIO_REST_PART = 1;
export const DEFAULT_STUDY_MINUTES = 25;
export const DEFAULT_ALARM_DURATION_SECONDS = 10; // tempo máximo que o alarme toca antes de parar sozinho
export const MIN_ALARM_DURATION_SECONDS = 3;
export const MAX_ALARM_DURATION_SECONDS = 60;

/** Presets de duração de estudo oferecidos na tela de Configurações. */
export const STUDY_DURATION_PRESETS = Object.freeze([25, 50, 60]); // minutos: 25min, 50min, 1h

/** Presets de duração do alarme oferecidos na tela de Preferências. */
export const ALARM_DURATION_PRESETS = Object.freeze([5, 10, 15, 30]); // segundos

/**
 * Valida se um valor (em segundos) é uma duração de alarme aceitável.
 * @param {number} seconds
 * @returns {boolean}
 */
export function isValidAlarmDurationSeconds(seconds) {
  return Number.isFinite(seconds)
    && seconds >= MIN_ALARM_DURATION_SECONDS
    && seconds <= MAX_ALARM_DURATION_SECONDS;
}

/**
 * Restringe um valor de duração do alarme aos limites permitidos, caindo
 * para o padrão quando o valor não for um número válido.
 * @param {number} seconds
 * @returns {number}
 */
export function clampAlarmDurationSeconds(seconds) {
  if (!Number.isFinite(seconds)) return DEFAULT_ALARM_DURATION_SECONDS;
  return Math.min(MAX_ALARM_DURATION_SECONDS, Math.max(MIN_ALARM_DURATION_SECONDS, seconds));
}

/** @returns {{ratioStudyPart: number, ratioRestPart: number, defaultStudyMinutes: number, alarmDurationSeconds: number}} */
export function getDefaultPreferences() {
  return {
    ratioStudyPart: DEFAULT_RATIO_STUDY_PART,
    ratioRestPart: DEFAULT_RATIO_REST_PART,
    defaultStudyMinutes: DEFAULT_STUDY_MINUTES,
    alarmDurationSeconds: DEFAULT_ALARM_DURATION_SECONDS,
  };
}

/**
 * Calcula o descanso sugerido (em ms) para um tempo de estudo, de acordo
 * com uma proporção estudo:descanso (ex.: 5:1 -> a cada 5min de estudo, 1min
 * de descanso).
 * @param {number} studyMs
 * @param {number} ratioStudyPart
 * @param {number} ratioRestPart
 * @returns {number} descanso sugerido em ms
 */
export function computeRestMsForRatio(studyMs, ratioStudyPart, ratioRestPart) {
  _assertPositive(studyMs, 'studyMs');
  _assertPositiveRatioPart(ratioStudyPart, 'ratioStudyPart');
  _assertPositiveRatioPart(ratioRestPart, 'ratioRestPart');
  return Math.round(studyMs * (ratioRestPart / ratioStudyPart));
}

/**
 * Diz se uma proporção estudo:descanso tem o descanso proporcionalmente
 * MAIOR que o padrão recomendado (5:1) — ou seja, se o descanso "pesa" mais
 * do que deveria em relação ao estudo.
 *
 * Comparação feita por produto cruzado (evita imprecisão de ponto flutuante
 * de uma divisão):
 *   ratioRestPart / ratioStudyPart > DEFAULT_RATIO_REST_PART / DEFAULT_RATIO_STUDY_PART
 * equivale a
 *   ratioRestPart * DEFAULT_RATIO_STUDY_PART > ratioStudyPart * DEFAULT_RATIO_REST_PART
 *
 * @param {number} ratioStudyPart
 * @param {number} ratioRestPart
 * @returns {boolean}
 */
export function isRestProportionAboveNormal(ratioStudyPart, ratioRestPart) {
  _assertPositiveRatioPart(ratioStudyPart, 'ratioStudyPart');
  _assertPositiveRatioPart(ratioRestPart, 'ratioRestPart');
  return ratioRestPart * DEFAULT_RATIO_STUDY_PART > ratioStudyPart * DEFAULT_RATIO_REST_PART;
}

/**
 * Mensagem de recomendação para quando o descanso configurado é
 * proporcionalmente maior que o padrão (5:1). Retorna null quando a
 * proporção informada já está dentro do recomendado (não deve exibir nada).
 * @param {number} ratioStudyPart
 * @param {number} ratioRestPart
 * @returns {string|null}
 */
export function buildRatioRecommendation(ratioStudyPart, ratioRestPart) {
  if (!isRestProportionAboveNormal(ratioStudyPart, ratioRestPart)) return null;
  return `Recomendamos uma proporção com menos descanso em relação ao estudo (como ${DEFAULT_RATIO_STUDY_PART}:${DEFAULT_RATIO_REST_PART}) para melhor aproveitamento do estudo.`;
}

// ---------- Validação interna ----------

function _assertPositive(value, name) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} deve ser um número positivo.`);
  }
}

function _assertPositiveRatioPart(value, name) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} deve ser um número positivo.`);
  }
}
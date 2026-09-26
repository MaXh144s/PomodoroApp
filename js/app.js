/**
 * app.js
 * Camada de UI: liga o DOM (index.html) ao PomodoroApp (appstate.js).
 * Não contém regra de negócio — apenas renderização e captura de eventos,
 * delegando tudo (cronômetro, ciclos, histórico, som, persistência) aos
 * módulos já existentes.
 */

import { PomodoroApp, Phase } from './appstate.js';
import {
  getTodaySummary,
  getFullHistorySummary,
  buildDailySummaryLabels,
  getLastNDaysSummary,
  getTodayDateKey,
  getSessionsForDate,
  deleteSessionsForDates,
  deleteSessionsForSubjects,
  buildHistoryBackup,
  validateHistoryBackup,
  commitHistoryImport,
  registerKnownSubject,
  getSubjectSuggestions,
} from './history.js';
import { computeCycleProgress, computeEquivalentCycles, formatDuration, formatCycleCount, normalizeSubjectKey } from './cycles.js';
import {
  getDefaultPreferences,
  computeRestMsForRatio,
  buildRatioRecommendation,
  clampAlarmDurationSeconds,
  isValidAlarmDurationSeconds,
  isValidDailyGoalMinutes,
  CycleTransitionMode,
  isValidCycleTransitionMode,
  DEFAULT_SHOW_SUBJECT_IN_TIMER,
  TodayTotalScope,
  isValidTodayTotalScope,
} from './preferences.js';
import { loadPreferences, savePreferences, loadCustomSound, saveCustomSound, clearCustomSound, saveTheme } from './storage.js';
import { setAlertCustomSound, setAlertMaxDuration, playPreview, stopPreview, seekPreview, getAudioDuration, getAudioWaveform } from './sound.js';

const RING_CIRCUMFERENCE = 2 * Math.PI * 90; // deve bater com o raio do SVG em style.css

// Devem bater com .chart-bar-value e .chart-bar-track em style.css: são a
// referência usada para posicionar (em pixels) as linhas de meta/média
// exatamente na mesma escala das barras do gráfico.
const CHART_VALUE_ROW_HEIGHT_PX = 18; // 14px de altura do texto + 4px de margem
const CHART_TRACK_HEIGHT_PX = 160;

// Cache do tempo total estudado hoje (somente períodos já gravados no
// histórico, sem contar o período que está rodando agora — esse a UI pega ao
// vivo em app.getOpenRunPeriodTodayMs()). Evita ler e parsear o histórico inteiro do
// localStorage a cada tick do cronômetro (4x/seg) — feito assim antes, isso
// empilhava dezenas de milhares de leituras assíncronas ao longo de várias
// horas encadeando sessões, e "Estudado hoje" acabava travando. Agora só é
// recalculado quando muda de fato: ao entrar em estudo/descanso e quando uma
// sessão é salva.
let todayBaseMs = 0; // total do dia, somando todos os assuntos
let todayBaseMsForCurrentSubject = 0; // total do dia, só do assunto do ciclo atual (ver TodayTotalScope)

async function refreshTodayBase() {
  const summary = await getTodaySummary();
  todayBaseMs = summary.totalStudiedMs;

  // `summary.subjects` já vem agrupado por assunto (ver aggregateSessionsBySubject
  // em cycles.js); localizamos o grupo do assunto do ciclo atual pela mesma
  // chave normalizada usada em todo o resto do app, para não depender de
  // digitação idêntica. Sem sessão salva ainda hoje para esse assunto, o
  // total é 0 (ex: primeiro ciclo do dia, ou assunto que mudou agora).
  const subjectKey = normalizeSubjectKey(app.getCurrentSubject());
  const subjectEntry = summary.subjects.find((s) => s.subjectKey === subjectKey);
  todayBaseMsForCurrentSubject = subjectEntry ? subjectEntry.totalStudiedMs : 0;
}

// ---------- Referências de DOM ----------

const views = {
  home: document.getElementById('view-home'),
  config: document.getElementById('view-config'),
  timer: document.getElementById('view-timer'),
  alert: document.getElementById('view-alert'),
  chart: document.getElementById('view-chart'),
  preferences: document.getElementById('view-preferences'),
};

const el = {
  saveIndicator: document.getElementById('save-indicator'),
  btnThemeToggle: document.getElementById('btn-theme-toggle'),

  modalResume: document.getElementById('modal-resume'),
  modalResumeDetail: document.getElementById('modal-resume-detail'),
  modalResumeQuestion: document.getElementById('modal-resume-question'),
  btnResumeSession: document.getElementById('btn-resume-session'),
  btnNewSession: document.getElementById('btn-new-session'),
  btnCloseResumeModal: document.getElementById('btn-close-resume-modal'),

  btnNew: document.getElementById('btn-new'),
  btnChart: document.getElementById('btn-chart'),
  homeTotalTime: document.getElementById('home-total-time'),
  homeMotivational: document.getElementById('home-motivational'),
  homeCycles: document.getElementById('home-cycles'),
  homeSessions: document.getElementById('home-sessions'),
  homeEquivalence: document.getElementById('home-equivalence'),
  homeHistory: document.getElementById('home-history'),
  homeHistoryList: document.getElementById('home-history-list'),

  btnHistoryExport: document.getElementById('btn-history-export'),
  btnHistoryImport: document.getElementById('btn-history-import'),
  inputHistoryImportFile: document.getElementById('input-history-import-file'),
  btnHistoryTrash: document.getElementById('btn-history-trash'),
  historySelectionActions: document.getElementById('history-selection-actions'),
  historySelectionCount: document.getElementById('history-selection-count'),
  btnHistoryDeleteSelected: document.getElementById('btn-history-delete-selected'),
  btnHistorySelectionCancel: document.getElementById('btn-history-selection-cancel'),

  modalDeleteHistory: document.getElementById('modal-delete-history'),
  modalDeleteTitle: document.getElementById('modal-delete-title'),
  modalDeleteDetails: document.getElementById('modal-delete-details'),
  btnDeleteHistoryCancel: document.getElementById('btn-delete-history-cancel'),
  btnDeleteHistoryConfirm: document.getElementById('btn-delete-history-confirm'),

  modalImportHistory: document.getElementById('modal-import-history'),
  modalImportDetails: document.getElementById('modal-import-details'),
  btnImportHistoryCancel: document.getElementById('btn-import-history-cancel'),
  btnImportHistoryConfirm: document.getElementById('btn-import-history-confirm'),

  btnChartBack: document.getElementById('btn-chart-back'),
  chartTitle: document.getElementById('chart-title'),
  chartScopeButtons: Array.from(document.querySelectorAll('#chart-scope [data-chart-scope]')),
  chartSubjectField: document.getElementById('chart-subject-field'),
  chartSubjectInput: document.getElementById('chart-subject-input'),
  chartSubjectSuggestions: document.getElementById('chart-subject-suggestions'),
  chartPlotInner: document.getElementById('chart-plot-inner'),
  chartAxis: document.getElementById('chart-axis'),
  chartGridlines: document.getElementById('chart-gridlines'),
  chartBars: document.getElementById('chart-bars'),
  chartGoalLine: document.getElementById('chart-goal-line'),
  chartAvgLine: document.getElementById('chart-avg-line'),
  chartGoalTag: document.getElementById('chart-goal-tag'),
  chartAvgTag: document.getElementById('chart-avg-tag'),
  chartTooltip: document.getElementById('chart-tooltip'),
  chartTotal: document.getElementById('chart-total'),

  btnPreferences: document.getElementById('btn-preferences'),
  btnPreferencesBack: document.getElementById('btn-preferences-back'),
  preferencesForm: document.getElementById('preferences-form'),
  prefStudyMinutes: document.getElementById('pref-study-minutes'),
  prefDailyGoalHours: document.getElementById('pref-daily-goal-hours'),
  prefRatioStudy: document.getElementById('pref-ratio-study'),
  prefRatioRest: document.getElementById('pref-ratio-rest'),
  prefWarning: document.getElementById('pref-warning'),
  prefPresetButtons: Array.from(document.querySelectorAll('#preferences-form [data-preset-minutes]')),

  prefAlarmDuration: document.getElementById('pref-alarm-duration'),
  prefAlarmPresetButtons: Array.from(document.querySelectorAll('#preferences-form [data-preset-alarm-seconds]')),

  prefTransitionModeButtons: Array.from(document.querySelectorAll('#pref-transition-mode [data-transition-mode]')),
  prefShowSubjectButtons: Array.from(document.querySelectorAll('#pref-show-subject [data-show-subject]')),
  prefTodayTotalScopeButtons: Array.from(document.querySelectorAll('#pref-today-total-scope [data-today-total-scope]')),

  prefSoundFile: document.getElementById('pref-sound-file'),
  prefSoundCurrent: document.getElementById('pref-sound-current'),
  prefSoundWarning: document.getElementById('pref-sound-warning'),
  prefSoundTrim: document.getElementById('pref-sound-trim'),
  trimWaveform: document.getElementById('trim-waveform'),
  trimWindow: document.getElementById('trim-window'),
  trimRange: document.getElementById('pref-sound-trim-range'),
  trimRangeLabel: document.getElementById('trim-range-label'),
  btnSoundPreview: document.getElementById('btn-sound-preview'),
  btnSoundRemove: document.getElementById('btn-sound-remove'),

  btnConfigBack: document.getElementById('btn-config-back'),
  configForm: document.getElementById('config-form'),
  inputStudy: document.getElementById('input-study'),
  inputRest: document.getElementById('input-rest'),
  inputSubject: document.getElementById('input-subject'),
  subjectSuggestions: document.getElementById('subject-suggestions'),

  btnTimerHome: document.getElementById('btn-timer-home'),
  timerState: document.getElementById('timer-state'),
  timerSubject: document.getElementById('timer-subject'),
  timerDisplay: document.querySelector('.timer-display'),
  progressRingFg: document.getElementById('progress-ring-fg'),
  timerRemaining: document.getElementById('timer-remaining'),
  timerConfigured: document.getElementById('timer-configured'),
  timerCycleInfo: document.getElementById('timer-cycle-info'),
  btnToggle: document.getElementById('btn-toggle'),
  btnReset: document.getElementById('btn-reset'),
  timeAdjustButtons: Array.from(document.querySelectorAll('.time-adjust .btn-chip')),
  timerTodayTotal: document.getElementById('timer-today-total'),

  alertIcon: document.getElementById('alert-icon'),
  alertMessage: document.getElementById('alert-message'),
  alertHint: document.getElementById('alert-hint'),
  btnStopSound: document.getElementById('btn-stop-sound'),
  btnSkipAlert: document.getElementById('btn-skip-alert'),
};

el.progressRingFg.style.strokeDasharray = String(RING_CIRCUMFERENCE);

// ---------- Botão de modo claro/escuro ----------
// O botão (#btn-theme-toggle) e as cores do modo escuro já vêm prontos de
// css/dark-mode.css, dirigidos pelo atributo [data-theme] de <html> — o
// mesmo que o script inline no <head> já define antes do CSS renderizar
// (lendo localStorage, para não piscar). Aqui só refletimos o estado no
// atributo aria-pressed do botão (que o CSS usa para animar o toggle) e
// persistimos a escolha manual via storage.js, na mesma chave.

function _applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  el.btnThemeToggle.setAttribute('aria-pressed', String(theme === 'dark'));
}

el.btnThemeToggle.addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';

  // Sem suporte a View Transitions (ou com prefers-reduced-motion): troca
  // instantânea, igual a antes — mesmo fallback usado em showView().
  if (!document.startViewTransition || _prefersReducedMotion()) {
    _applyTheme(next);
    saveTheme(next);
    return;
  }

  // Origem da onda: o centro do próprio botão (não o ponto do clique/toque),
  // para funcionar igual via mouse, toque ou teclado (Enter/Espaço). O raio
  // final cobre o canto mais distante da tela, garantindo que a onda tome
  // conta de toda a viewport antes de terminar.
  const rect = el.btnThemeToggle.getBoundingClientRect();
  const originX = rect.left + rect.width / 2;
  const originY = rect.top + rect.height / 2;
  const endRadius = Math.hypot(
    Math.max(originX, window.innerWidth - originX),
    Math.max(originY, window.innerHeight - originY)
  );

  // Flag lida por motion.css: desliga só o crossfade padrão desta transição
  // específica (a de troca de tela usa data-view-transition, não esta).
  document.documentElement.dataset.themeTransition = 'true';

  const transition = document.startViewTransition(() => {
    _applyTheme(next);
    saveTheme(next);
  });

  transition.ready
    .then(() => {
      // A nova aparência entra recortada por um círculo que cresce a partir
      // do botão — como ela fica por cima da aparência antiga (ordem padrão
      // da View Transitions API), o crescimento do círculo vai "pintando"
      // o novo tema por cima do antigo, feito o efeito de onda pedido.
      document.documentElement.animate(
        {
          clipPath: [
            `circle(0px at ${originX}px ${originY}px)`,
            `circle(${endRadius}px at ${originX}px ${originY}px)`,
          ],
        },
        {
          duration: 650,
          easing: 'cubic-bezier(0.22, 1, 0.36, 1)', // mesma curva de --ease-standard
          pseudoElement: '::view-transition-new(root)',
        }
      );
    })
    .catch(() => {}); // ready pode rejeitar se outra transição começar antes (ex: cliques rápidos)

  transition.finished
    .catch(() => {})
    .finally(() => {
      delete document.documentElement.dataset.themeTransition;
    });
});

_applyTheme(document.documentElement.dataset.theme || 'light');

// ---------- Instância central do app ----------

const app = new PomodoroApp({
  onPhaseChange: (phase) => renderForPhase(phase),
  onTick: (remainingMs, totalMs) => renderTick(remainingMs, totalMs),
  onSessionSaved: () => {
    // Mantém o cache de "estudado hoje" em dia sempre que um período é
    // gravado (pausa, fim do ciclo, Reiniciar, nova configuração). Redesenha
    // o total logo em seguida: ao pausar não há mais ticks para fazê-lo, e o
    // tempo acabou de migrar de "período em execução" para "já gravado".
    refreshTodayBase().then(() => {
      if (app.getPhase() === Phase.STUDY) renderCycleInfo();
    });
  },
});

// ---------- Preferências ----------

// Preferências atuais em memória (proporção estudo:descanso e tempo de
// estudo padrão sugerido ao abrir "Novo temporizador"). Carregadas do
// storage no boot; caem para o padrão do app (5:1, 25min) se o usuário
// nunca tiver configurado nada.
let currentPreferences = getDefaultPreferences();

// Toque customizado atualmente salvo ({name, dataUrl}) ou null (beep padrão).
let savedCustomSound = null;

async function loadCurrentPreferences() {
  const saved = await loadPreferences();
  // Mescla com o padrão em vez de usar `saved` puro: preferências salvas antes
  // de um novo campo existir (ex: cycleTransitionMode) não o têm, e sem isso
  // currentPreferences.cycleTransitionMode ficaria undefined para quem já
  // tinha preferências configuradas.
  currentPreferences = saved ? { ...getDefaultPreferences(), ...saved } : getDefaultPreferences();

  savedCustomSound = await loadCustomSound();
  setAlertCustomSound(
    savedCustomSound ? savedCustomSound.dataUrl : null,
    savedCustomSound ? (savedCustomSound.trimStartSeconds || 0) : 0
  );
  setAlertMaxDuration(currentPreferences.alarmDurationSeconds * 1000);
  app.setCycleTransitionMode(currentPreferences.cycleTransitionMode);
}

function renderPreferencesForm() {
  el.prefStudyMinutes.value = currentPreferences.defaultStudyMinutes;
  el.prefDailyGoalHours.value = (currentPreferences.dailyGoalMinutes ?? 0) / 60;
  el.prefRatioStudy.value = currentPreferences.ratioStudyPart;
  el.prefRatioRest.value = currentPreferences.ratioRestPart;
  el.prefAlarmDuration.value = currentPreferences.alarmDurationSeconds;
  _setTransitionModeButtonsState(currentPreferences.cycleTransitionMode);
  _setShowSubjectButtonsState(currentPreferences.showSubjectInTimer);
  _setTodayTotalScopeButtonsState(currentPreferences.todayTotalScope);
  updatePreferencesWarning();

  pendingCustomSound = undefined; // usuário ainda não mexeu no som nesta visita ao formulário
  pendingAudioDurationSeconds = null; // duração do áudio ativo, buscada sob demanda (ver _updateTrimUI)
  pendingTrimStartSeconds = null; // início do trecho escolhido pelo usuário nesta visita, se houver
  pendingWaveformPeaks = null; // forma de onda do áudio ativo, recalculada sob demanda
  el.prefSoundFile.value = '';
  el.prefSoundWarning.hidden = true;
  _renderSoundStatus();
  _updateTrimUI();
}

// Mostra em tempo real o aviso de "descanso desproporcional" (seção de
// preferências): sempre que a proporção informada tiver o descanso
// proporcionalmente maior que o padrão recomendado (5:1).
function updatePreferencesWarning() {
  const ratioStudyPart = Number(el.prefRatioStudy.value);
  const ratioRestPart = Number(el.prefRatioRest.value);

  if (!(ratioStudyPart > 0) || !(ratioRestPart > 0)) {
    el.prefWarning.hidden = true;
    return;
  }

  const message = buildRatioRecommendation(ratioStudyPart, ratioRestPart);
  el.prefWarning.textContent = message || '';
  el.prefWarning.hidden = !message;
}

// ---------- Toque customizado do alerta ----------

const MAX_SOUND_FILE_BYTES = 2 * 1024 * 1024; // ~2MB: acima disso o localStorage pode recusar salvar

// Estado do formulário de preferências para o som (só persiste ao salvar):
//   undefined -> usuário não mexeu, mantém o que já estava salvo
//   null      -> usuário pediu para remover o toque customizado
//   {name, dataUrl} -> usuário escolheu um novo arquivo
let pendingCustomSound;
let previewPlaying = false;

// Estado da UI de recorte (só existe enquanto o formulário de Preferências
// está aberto): duração total do áudio ativo (buscada sob demanda, já que
// não vem salva junto do som) e o início do trecho escolhido pelo usuário,
// em segundos. null = ainda não calculado/escolhido nesta visita ao formulário.
let pendingAudioDurationSeconds = null;
let pendingTrimStartSeconds = null;
let pendingWaveformPeaks = null; // forma de onda (graves) do áudio ativo, calculada sob demanda

/** Toque "ativo" no momento, considerando o que está pendente no formulário. */
function _activeSoundForPreferencesForm() {
  if (pendingCustomSound === null) return null;
  return pendingCustomSound || savedCustomSound;
}

function _renderSoundStatus() {
  const active = _activeSoundForPreferencesForm();
  el.prefSoundCurrent.textContent = active ? `Toque atual: ${active.name}` : 'Usando o beep padrão do app.';
  el.btnSoundPreview.disabled = !active;
  el.btnSoundRemove.disabled = !active;
}

function _formatSeconds(totalSeconds) {
  const seconds = Math.max(0, Math.round(totalSeconds));
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${minutes}:${String(secs).padStart(2, '0')}`;
}

/** Alarme configurado no momento no próprio formulário (não necessariamente já salvo). */
function _formAlarmDurationSeconds() {
  return clampAlarmDurationSeconds(Number(el.prefAlarmDuration.value));
}

/**
 * Mostra (ou esconde) o seletor de trecho, semelhante ao recorte de música
 * do Instagram: só faz sentido quando o áudio escolhido dura mais que o
 * alarme configurado — nesse caso o usuário escolhe qual janela de N
 * segundos do arquivo vai tocar, em vez de sempre o início dele.
 */
async function _updateTrimUI() {
  const active = _activeSoundForPreferencesForm();
  if (!active) {
    el.prefSoundTrim.hidden = true;
    return;
  }

  if (pendingAudioDurationSeconds == null) {
    try {
      pendingAudioDurationSeconds = await getAudioDuration(active.dataUrl);
    } catch (err) {
      console.warn('[app] Não foi possível calcular a duração do áudio escolhido:', err);
      el.prefSoundTrim.hidden = true;
      return;
    }
  }

  const alarmSeconds = _formAlarmDurationSeconds();
  const duration = pendingAudioDurationSeconds;

  if (!(duration > alarmSeconds)) {
    // Arquivo mais curto (ou igual) que o alarme: toca inteiro e repete, sem trecho a escolher.
    el.prefSoundTrim.hidden = true;
    return;
  }

  el.prefSoundTrim.hidden = false;

  if (pendingWaveformPeaks == null) {
    _renderWaveformPlaceholder();
    try {
      pendingWaveformPeaks = await getAudioWaveform(active.dataUrl);
    } catch (err) {
      console.warn('[app] Não foi possível gerar a visualização do áudio:', err);
      pendingWaveformPeaks = [];
    }
    _renderWaveformBars(pendingWaveformPeaks);
  }

  const maxStart = Math.max(0, duration - alarmSeconds);
  const previousStart = pendingTrimStartSeconds != null ? pendingTrimStartSeconds : (active.trimStartSeconds || 0);
  const start = Math.min(previousStart, maxStart);
  pendingTrimStartSeconds = start;

  el.trimRange.min = '0';
  el.trimRange.max = String(maxStart.toFixed(1));
  el.trimRange.step = '0.1';
  el.trimRange.value = String(start);

  _renderTrimVisual(start, alarmSeconds, duration);
}

/** Barras neutras e "pulsando" enquanto a forma de onda real ainda está sendo calculada. */
function _renderWaveformPlaceholder() {
  const placeholderBars = 60;
  el.trimWaveform.innerHTML = Array.from({ length: placeholderBars })
    .map(() => '<div class="trim-waveform-bar trim-waveform-bar--placeholder" style="height:30%"></div>')
    .join('');
}

/** Desenha a forma de onda (graves) real como barras, uma por pico calculado. */
function _renderWaveformBars(peaks) {
  if (!peaks || peaks.length === 0) {
    el.trimWaveform.innerHTML = '';
    return;
  }
  el.trimWaveform.innerHTML = peaks
    .map((peak) => `<div class="trim-waveform-bar" style="height:${Math.max(12, Math.round(peak * 100))}%"></div>`)
    .join('');
}

function _renderTrimVisual(startSeconds, alarmSeconds, durationSeconds) {
  const leftPct = durationSeconds > 0 ? (startSeconds / durationSeconds) * 100 : 0;
  const widthPct = durationSeconds > 0 ? Math.min(100, (alarmSeconds / durationSeconds) * 100) : 100;
  el.trimWindow.style.left = `${leftPct}%`;
  el.trimWindow.style.width = `${widthPct}%`;
  el.trimRangeLabel.textContent =
    `Tocando de ${_formatSeconds(startSeconds)} a ${_formatSeconds(startSeconds + alarmSeconds)} (de ${_formatSeconds(durationSeconds)} no total)`;
}

function _readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

el.prefSoundFile.addEventListener('change', async () => {
  const file = el.prefSoundFile.files[0];
  if (!file) return;

  el.prefSoundWarning.hidden = true;
  if (file.size > MAX_SOUND_FILE_BYTES) {
    el.prefSoundWarning.textContent = 'Esse arquivo é grande (mais de 2MB) e pode não salvar corretamente, pois o navegador tem um limite de armazenamento. Se der erro ao salvar, tente um arquivo menor.';
    el.prefSoundWarning.hidden = false;
  }

  const dataUrl = await _readFileAsDataUrl(file);
  pendingCustomSound = { name: file.name, dataUrl };
  pendingAudioDurationSeconds = null; // arquivo novo: recalcula a duração e reseta o trecho escolhido
  pendingTrimStartSeconds = null;
  pendingWaveformPeaks = null; // arquivo novo: recalcula a forma de onda também
  _renderSoundStatus();
  await _updateTrimUI();
});

el.btnSoundPreview.addEventListener('click', () => {
  const active = _activeSoundForPreferencesForm();
  if (!active) return;

  if (previewPlaying) {
    stopPreview();
    previewPlaying = false;
    el.btnSoundPreview.textContent = '▶ Tocar';
    return;
  }

  previewPlaying = true;
  el.btnSoundPreview.textContent = '⏸ Parar';

  // Com o seletor de trecho visível, o preview toca exatamente a janela
  // escolhida (mesmo trecho que vai tocar no alarme de verdade); caso
  // contrário, toca o arquivo desde o início, como antes.
  const trimActive = !el.prefSoundTrim.hidden;
  const previewOptions = trimActive
    ? { startSeconds: pendingTrimStartSeconds || 0, durationSeconds: _formAlarmDurationSeconds() }
    : {};

  playPreview(active.dataUrl, () => {
    previewPlaying = false;
    el.btnSoundPreview.textContent = '▶ Tocar';
  }, previewOptions);
});

el.btnSoundRemove.addEventListener('click', () => {
  stopPreview();
  previewPlaying = false;
  el.btnSoundPreview.textContent = '▶ Tocar';

  pendingCustomSound = null;
  pendingAudioDurationSeconds = null;
  pendingTrimStartSeconds = null;
  pendingWaveformPeaks = null;
  el.prefSoundFile.value = '';
  el.prefSoundWarning.hidden = true;
  el.prefSoundTrim.hidden = true;
  el.trimWaveform.innerHTML = '';
  _renderSoundStatus();
});

// Mudar a duração do alarme (digitando ou por preset) redimensiona a janela
// do trecho escolhido, já que o tamanho da janela é sempre igual ao alarme.
el.prefAlarmDuration.addEventListener('input', () => {
  _updateTrimUI();
});

el.prefAlarmPresetButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    el.prefAlarmDuration.value = btn.dataset.presetAlarmSeconds;
    _updateTrimUI();
  });
});

// Reflete visualmente qual modo de transição está selecionado no momento
// (via aria-pressed, estilizado em style.css). Não salva nada por si só —
// isso só acontece no submit do formulário, como as outras preferências.
function _setTransitionModeButtonsState(mode) {
  el.prefTransitionModeButtons.forEach((btn) => {
    btn.setAttribute('aria-pressed', String(btn.dataset.transitionMode === mode));
  });
}

/** @returns {string} o modo de transição atualmente selecionado no formulário */
function _selectedTransitionMode() {
  const active = el.prefTransitionModeButtons.find((btn) => btn.getAttribute('aria-pressed') === 'true');
  return active ? active.dataset.transitionMode : CycleTransitionMode.AUTOMATIC;
}

el.prefTransitionModeButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    _setTransitionModeButtonsState(btn.dataset.transitionMode);
  });
});

// Mesmo padrão do toggle de modo de transição, para mostrar/ocultar o
// assunto do ciclo no cronômetro. Só controla a EXIBIÇÃO — o assunto
// continua salvo no ciclo (history.js) independente deste toggle.
function _setShowSubjectButtonsState(showSubject) {
  el.prefShowSubjectButtons.forEach((btn) => {
    btn.setAttribute('aria-pressed', String((btn.dataset.showSubject === 'true') === showSubject));
  });
}

function _selectedShowSubject() {
  const active = el.prefShowSubjectButtons.find((btn) => btn.getAttribute('aria-pressed') === 'true');
  return active ? active.dataset.showSubject === 'true' : DEFAULT_SHOW_SUBJECT_IN_TIMER;
}

el.prefShowSubjectButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    _setShowSubjectButtonsState(btn.dataset.showSubject === 'true');
  });
});

// Mesmo padrão dos dois toggles acima, para escolher se "Estudado hoje" no
// cronômetro soma todos os assuntos do dia ou só o do ciclo atual.
function _setTodayTotalScopeButtonsState(scope) {
  el.prefTodayTotalScopeButtons.forEach((btn) => {
    btn.setAttribute('aria-pressed', String(btn.dataset.todayTotalScope === scope));
  });
}

function _selectedTodayTotalScope() {
  const active = el.prefTodayTotalScopeButtons.find((btn) => btn.getAttribute('aria-pressed') === 'true');
  return active ? active.dataset.todayTotalScope : TodayTotalScope.ALL;
}

el.prefTodayTotalScopeButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    _setTodayTotalScopeButtonsState(btn.dataset.todayTotalScope);
  });
});

el.trimRange.addEventListener('input', () => {
  pendingTrimStartSeconds = Number(el.trimRange.value) || 0;
  _renderTrimVisual(pendingTrimStartSeconds, _formAlarmDurationSeconds(), pendingAudioDurationSeconds || 0);
  if (previewPlaying) {
    // Só move a posição do áudio que já está tocando (em vez de parar e
    // criar um preview novo a cada pixel arrastado) — evita empilhar várias
    // reproduções ao mesmo tempo enquanto o usuário arrasta o seletor.
    seekPreview(pendingTrimStartSeconds, _formAlarmDurationSeconds());
  }
});

el.btnPreferences.addEventListener('click', () => {
  renderPreferencesForm();
  showView('preferences', 'forward');
});

el.btnPreferencesBack.addEventListener('click', () => {
  stopPreview();
  previewPlaying = false;
  showView('home', 'backward');
});

el.prefRatioStudy.addEventListener('input', updatePreferencesWarning);
el.prefRatioRest.addEventListener('input', updatePreferencesWarning);

el.prefPresetButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    el.prefStudyMinutes.value = btn.dataset.presetMinutes;
  });
});

el.preferencesForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const defaultStudyMinutes = Number(el.prefStudyMinutes.value);
  const dailyGoalHours = Number(el.prefDailyGoalHours.value);
  const dailyGoalMinutes = dailyGoalHours * 60;
  const ratioStudyPart = Number(el.prefRatioStudy.value);
  const ratioRestPart = Number(el.prefRatioRest.value);
  const alarmDurationSeconds = clampAlarmDurationSeconds(Number(el.prefAlarmDuration.value));
  const cycleTransitionMode = _selectedTransitionMode();
  const showSubjectInTimer = _selectedShowSubject();
  const todayTotalScope = _selectedTodayTotalScope();

  if (
    !(defaultStudyMinutes > 0)
    || !isValidDailyGoalMinutes(dailyGoalMinutes)
    || !(ratioStudyPart > 0)
    || !(ratioRestPart > 0)
    || !isValidAlarmDurationSeconds(alarmDurationSeconds)
    || !isValidCycleTransitionMode(cycleTransitionMode)
    || !isValidTodayTotalScope(todayTotalScope)
  ) return;

  currentPreferences = { defaultStudyMinutes, dailyGoalMinutes, ratioStudyPart, ratioRestPart, alarmDurationSeconds, cycleTransitionMode, showSubjectInTimer, todayTotalScope };
  await savePreferences(currentPreferences);
  setAlertMaxDuration(alarmDurationSeconds * 1000);
  app.setCycleTransitionMode(cycleTransitionMode);

  // O trecho escolhido no seletor só vale quando ele está visível (áudio
  // ativo mais longo que o alarme); fora isso o som toca desde o início.
  const trimStartSeconds = !el.prefSoundTrim.hidden ? (pendingTrimStartSeconds || 0) : 0;

  if (pendingCustomSound === null) {
    // Usuário pediu para remover: volta ao beep padrão.
    await clearCustomSound();
    savedCustomSound = null;
    setAlertCustomSound(null);
  } else if (pendingCustomSound) {
    // Usuário escolheu um novo arquivo (com o trecho escolhido, se houver).
    const soundToSave = { ...pendingCustomSound, trimStartSeconds };
    await saveCustomSound(soundToSave);
    savedCustomSound = soundToSave;
    setAlertCustomSound(soundToSave.dataUrl, soundToSave.trimStartSeconds);
  } else if (savedCustomSound && !el.prefSoundTrim.hidden) {
    // Usuário não trocou o arquivo, mas pode ter ajustado o trecho de um som já salvo.
    savedCustomSound = { ...savedCustomSound, trimStartSeconds };
    await saveCustomSound(savedCustomSound);
    setAlertCustomSound(savedCustomSound.dataUrl, savedCustomSound.trimStartSeconds);
  }
  // pendingCustomSound === undefined e sem trecho para ajustar: nada do som muda.

  stopPreview();
  previewPlaying = false;
  showView('home', 'backward');
});

// ---------- Navegação entre telas ----------

// Fica true depois da primeira renderização (boot). Evita animar a troca
// de tela na carga inicial da página, quando não há "de onde" vir.
let navigationReady = false;

function _prefersReducedMotion() {
  return typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function _getCurrentViewName() {
  const entry = Object.entries(views).find(([, node]) => !node.hidden);
  return entry ? entry[0] : null;
}

/**
 * Troca a tela visível. `direction` controla a linguagem de movimento:
 * - 'forward'  -> avançando no fluxo (entra de baixo pra cima)
 * - 'backward' -> voltando (sai pra baixo, ex: seta de voltar)
 * - 'fade'     -> continuação, sem deslocamento (ex: alerta -> cronômetro ao pular)
 * Usa a View Transitions API quando disponível; cai para a troca instantânea
 * de sempre em navegadores sem suporte ou com prefers-reduced-motion ativo.
 *
 * Retorna uma Promise que resolve quando é seguro animar algo na tela
 * recém-mostrada (ex: o anel do cronômetro). Enquanto o crossfade da View
 * Transition está rolando, o navegador exibe uma FOTO congelada da tela
 * nova por cima do DOM real — qualquer mudança de estilo feita antes disso
 * terminar fica escondida atrás dela. Por isso só resolve depois do
 * crossfade (transition.finished), não logo após o DOM mudar.
 */
function showView(name, direction = 'forward') {
  const update = () => {
    Object.entries(views).forEach(([key, node]) => {
      node.hidden = key !== name;
    });
  };

  if (!navigationReady || !document.startViewTransition || _prefersReducedMotion()) {
    update();
    return Promise.resolve();
  }

  document.documentElement.dataset.viewTransition = direction;
  const transition = document.startViewTransition(update);

  // .ready e .updateCallbackDone também podem rejeitar nos mesmos casos que
  // .finished (transição interrompida por outra mais rápida, ou aba escondida
  // no meio da animação) — como ninguém aguarda o resultado delas, sem um
  // catch próprio essas rejeições ficavam "soltas" e apareciam no console como
  // "Uncaught (in promise)" mesmo sendo um caso esperado, não um erro real.
  transition.ready.catch(() => {});
  transition.updateCallbackDone.catch(() => {});

  return transition.finished
    .catch(() => {}) // transições podem ser abortadas (ex: navegação rápida); seguir mesmo assim
    .finally(() => {
      delete document.documentElement.dataset.viewTransition;
    });
}

async function renderForPhase(phase) {
  const previousView = _getCurrentViewName();
  // Vindo do alerta, a troca é sempre uma continuação (fade), nunca um
  // "avançar/voltar" no fluxo de navegação.
  const fromAlert = previousView === 'alert';

  if (phase === Phase.CONFIG) {
    await renderHome();
    // Race condition: enquanto renderHome() buscava dados (async), a fase
    // pode ter avançado de novo (ex: configure() -> startStudy() disparado
    // em seguida pelo handler do formulário). Nesse caso este render ficou
    // obsoleto — não pode sobrescrever a tela que já reflete a fase atual.
    if (app.getPhase() !== phase) return;
    await showView('home', fromAlert ? 'fade' : 'backward');
  } else if (phase === Phase.STUDY || phase === Phase.REST) {
    // renderTimerShell() já deixa o anel pronto em 0 (ver _prepareRingEntrance)
    // quando é uma retomada — assim, o primeiro frame em que a tela aparece
    // já mostra o anel vazio, sem esperar nada.
    await renderTimerShell(phase);
    showView('timer', fromAlert ? 'fade' : 'forward');
    _playRingEntranceIfPending();
  } else if (phase === Phase.STUDY_ALERT || phase === Phase.REST_ALERT) {
    renderAlert(phase);
    _notifyPhaseFinishedIfHidden(phase);
    await showView('alert', 'fade');
  }

  navigationReady = true;
}

// ---------- Tela inicial ----------

async function renderHome() {
  const todaySummary = await getTodaySummary();
  const labels = buildDailySummaryLabels(todaySummary);

  el.homeTotalTime.textContent = labels.totalStudiedLabel;
  el.homeMotivational.textContent = labels.motivational;
  el.homeCycles.textContent = String(labels.totalCompleteCycles);
  el.homeSessions.textContent = String(labels.sessionCount);
  el.homeEquivalence.textContent = todaySummary.totalStudiedMs > 0 ? labels.equivalence : '';

  // Uma nova entrada na tela inicial sempre começa fora do modo de seleção
  // da lixeira — inclusive depois de uma exclusão/importação, já que ambas
  // terminam chamando renderHome() de novo.
  _exitHistorySelectionMode();

  lastFullHistorySummary = await getFullHistorySummary();
  el.btnHistoryTrash.disabled = lastFullHistorySummary.length === 0;
  _renderHistoryList();
}

function _formatDateLabel(dateKey) {
  const [year, month, day] = dateKey.split('-');
  return `${day}/${month}/${year}`;
}

function _formatTime(timestamp) {
  const d = new Date(timestamp);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// ---------- Gerenciamento do histórico (exportar / importar / lixeira) ----------
//
// Tudo aqui opera sobre o mesmo histórico de sessões já usado pelo resto do
// app (history.js/storage.js) — não existe uma lista paralela. O modo de
// seleção só existe enquanto a lixeira está aberta; a exclusão em si
// (deleteSessionsForDates/deleteSessionsForSubjects) e a importação
// (validateHistoryBackup + commitHistoryImport) vivem em history.js.
//
// A seleção tem dois níveis independentes:
// - selectedHistoryDates: dias inteiros (checkbox no cabeçalho do dia).
// - selectedHistorySubjects: assuntos específicos dentro de um dia
//   (checkbox em cada linha de assunto), chaveados como "dateKey::subjectKey"
//   (subjectKey já normalizado, igual ao exposto por aggregateSessionsBySubject
//   em cycles.js). Selecionar o dia inteiro torna redundante qualquer seleção
//   de assunto avulsa dentro dele — por isso o checkbox de cada assunto fica
//   desabilitado (e marcado) enquanto o dia estiver selecionado.

let lastFullHistorySummary = [];
let historySelectionMode = false;
const selectedHistoryDates = new Set();
const selectedHistorySubjects = new Set();
let pendingDeleteDateKeys = null;
let pendingDeleteSubjectEntries = null;
let pendingImportSessions = null;

// Modo compacto: oculta a quebra por assunto de cada dia, deixando só
// data, sessões/ciclos e tempo total visíveis (ver .history-list-compact
// em style.css). O botão é criado aqui via JS — index.html não define um
// elemento próprio para ele — e inserido no cabeçalho do card de
// histórico; como fica dentro de el.homeHistory, some junto com o card
// inteiro quando não há histórico (não precisa de lógica própria pra isso).
let historyCompactMode = false;

const btnHistoryCompactToggle = document.createElement('button');
btnHistoryCompactToggle.type = 'button';
btnHistoryCompactToggle.className = 'history-compact-toggle';
btnHistoryCompactToggle.setAttribute('aria-pressed', 'false');
btnHistoryCompactToggle.setAttribute('aria-label', 'Minimizar histórico');
btnHistoryCompactToggle.title = 'Minimizar';
btnHistoryCompactToggle.innerHTML = '<span class="history-compact-toggle-icon">▾</span>';
btnHistoryCompactToggle.addEventListener('click', () => {
  historyCompactMode = !historyCompactMode;
  btnHistoryCompactToggle.setAttribute('aria-pressed', String(historyCompactMode));
  const label = historyCompactMode ? 'Expandir histórico' : 'Minimizar histórico';
  btnHistoryCompactToggle.setAttribute('aria-label', label);
  btnHistoryCompactToggle.title = historyCompactMode ? 'Expandir' : 'Minimizar';
  el.homeHistoryList.classList.toggle('history-list-compact', historyCompactMode);
});
(el.homeHistory.querySelector('.history-card-header-top') || el.homeHistory).appendChild(btnHistoryCompactToggle);

function _renderHistoryList() {
  const fullHistory = lastFullHistorySummary;

  if (fullHistory.length === 0) {
    el.homeHistory.hidden = true;
    el.homeHistoryList.innerHTML = '';
    return;
  }

  el.homeHistory.hidden = false;
  el.homeHistoryList.innerHTML = fullHistory
    .map((day) => {
      const dayLabels = buildDailySummaryLabels(day);
      const daySelected = selectedHistoryDates.has(day.dateKey);
      const checkbox = historySelectionMode
        ? `<input type="checkbox" class="history-select-checkbox" data-date-key="${day.dateKey}" ${daySelected ? 'checked' : ''} aria-label="Selecionar ${_formatDateLabel(day.dateKey)}">`
        : '';
      const subjectsHtml = day.subjects
        .map((subj) => {
          // Selecionar o dia inteiro já cobre todos os assuntos dele: o
          // checkbox do assunto aparece marcado e desabilitado nesse caso,
          // em vez de deixar duas seleções redundantes (e potencialmente
          // divergentes) coexistindo.
          const subjectKey = `${day.dateKey}::${subj.subjectKey}`;
          const subjectChecked = daySelected || selectedHistorySubjects.has(subjectKey);
          const subjectCheckbox = historySelectionMode
            ? `<input type="checkbox" class="history-select-checkbox history-select-subject-checkbox" data-date-key="${day.dateKey}" data-subject-key="${subj.subjectKey}" ${subjectChecked ? 'checked' : ''} ${daySelected ? 'disabled' : ''} aria-label="Selecionar ${subj.subject} de ${_formatDateLabel(day.dateKey)}">`
            : '';
          return `
            <li class="history-subject-item">
              ${subjectCheckbox}
              <span class="history-subject-name">${subj.subject}</span>
              <span class="history-subject-stats">${subj.sessionCount} sessão(ões) · ${subj.completeCycles} ciclo(s) · ${formatDuration(subj.totalStudiedMs)}</span>
            </li>
          `;
        })
        .join('');
      return `
        <li data-date-key="${day.dateKey}">
          <div class="history-item-header">
            <label class="history-item-label">
              ${checkbox}
              <span>
                <span class="history-date">${_formatDateLabel(day.dateKey)}</span><br>
                <span class="history-detail">${day.sessionCount} sessão(ões) · ${dayLabels.totalCompleteCycles} ciclos completos</span>
              </span>
            </label>
            <span class="history-total-badge">${dayLabels.totalStudiedLabel}</span>
          </div>
          <ul class="history-subjects">${subjectsHtml}</ul>
        </li>
      `;
    })
    .join('');

  if (historySelectionMode) {
    el.homeHistoryList.querySelectorAll('.history-select-checkbox:not(.history-select-subject-checkbox)').forEach((checkbox) => {
      checkbox.addEventListener('change', () => {
        const dateKey = checkbox.dataset.dateKey;
        if (checkbox.checked) {
          selectedHistoryDates.add(dateKey);
          _clearSubjectSelectionsForDate(dateKey);
        } else {
          selectedHistoryDates.delete(dateKey);
        }
        _updateHistorySelectionUI();
        _renderHistoryList();
      });
    });

    el.homeHistoryList.querySelectorAll('.history-select-subject-checkbox').forEach((checkbox) => {
      checkbox.addEventListener('change', () => {
        const key = `${checkbox.dataset.dateKey}::${checkbox.dataset.subjectKey}`;
        if (checkbox.checked) selectedHistorySubjects.add(key);
        else selectedHistorySubjects.delete(key);
        _updateHistorySelectionUI();
      });
    });
  }
}

/** Remove da seleção de assuntos avulsos todos os itens de um dia (usado ao marcar o dia inteiro). */
function _clearSubjectSelectionsForDate(dateKey) {
  for (const key of selectedHistorySubjects) {
    if (key.startsWith(`${dateKey}::`)) selectedHistorySubjects.delete(key);
  }
}

function _updateHistorySelectionUI() {
  const count = selectedHistoryDates.size + selectedHistorySubjects.size;
  el.historySelectionCount.textContent = count > 0 ? `${count} selecionado(s)` : '';
  el.btnHistoryDeleteSelected.disabled = count === 0;
}

function _exitHistorySelectionMode() {
  historySelectionMode = false;
  selectedHistoryDates.clear();
  selectedHistorySubjects.clear();
  el.historySelectionActions.hidden = true;
}

el.btnHistoryTrash.addEventListener('click', () => {
  if (lastFullHistorySummary.length === 0) return;
  historySelectionMode = !historySelectionMode;
  selectedHistoryDates.clear();
  selectedHistorySubjects.clear();
  el.historySelectionActions.hidden = !historySelectionMode;

  // A seleção por assunto depende de ver os assuntos de cada dia, que o
  // modo compacto esconde (ver .history-list-compact em style.css). Ao
  // entrar no modo de seleção, expande automaticamente para não escondam
  // a única forma de selecionar um assunto específico.
  if (historySelectionMode && historyCompactMode) {
    historyCompactMode = false;
    btnHistoryCompactToggle.setAttribute('aria-pressed', 'false');
    btnHistoryCompactToggle.setAttribute('aria-label', 'Minimizar histórico');
    btnHistoryCompactToggle.title = 'Minimizar';
    el.homeHistoryList.classList.remove('history-list-compact');
  }

  _updateHistorySelectionUI();
  _renderHistoryList();
});

el.btnHistorySelectionCancel.addEventListener('click', () => {
  _exitHistorySelectionMode();
  _renderHistoryList();
});

// ---------- Exclusão (com confirmação mostrando o que será excluído) ----------

el.btnHistoryDeleteSelected.addEventListener('click', async () => {
  if (selectedHistoryDates.size === 0 && selectedHistorySubjects.size === 0) return;

  const subjectEntries = Array.from(selectedHistorySubjects).map((key) => {
    const [dateKey, subjectKey] = key.split('::');
    return { dateKey, subjectKey };
  });

  await _openDeleteHistoryModal(Array.from(selectedHistoryDates), subjectEntries);
});

/**
 * @param {Array<string>} dateKeys - dias inteiros a excluir
 * @param {Array<{dateKey: string, subjectKey: string}>} [subjectEntries] - assuntos específicos (dentro de dias que NÃO foram selecionados inteiros) a excluir
 */
async function _openDeleteHistoryModal(dateKeys, subjectEntries = []) {
  pendingDeleteDateKeys = dateKeys;
  pendingDeleteSubjectEntries = subjectEntries;

  const totalCount = dateKeys.length + subjectEntries.length;
  el.modalDeleteTitle.textContent = totalCount === 1
    ? (dateKeys.length === 1 ? 'Excluir histórico do dia' : 'Excluir assunto do histórico')
    : `Excluir ${totalCount} itens do histórico`;

  const daysDetail = await Promise.all(dateKeys.map(async (dateKey) => {
    const daySummary = lastFullHistorySummary.find((d) => d.dateKey === dateKey);
    const labels = daySummary ? buildDailySummaryLabels(daySummary) : null;
    const sessions = await getSessionsForDate(dateKey);
    const periods = sessions
      .slice()
      .sort((a, b) => a.dateStart - b.dateStart)
      .map((s) => `${_formatTime(s.dateStart)}–${_formatTime(s.dateEnd)} (${formatDuration(s.studiedMs)})`)
      .join(', ') || '—';

    return `
      <p class="modal-delete-day">
        <strong>${_formatDateLabel(dateKey)}</strong><br>
        Tempo total estudado: ${labels ? labels.totalStudiedLabel : '—'}<br>
        Ciclos completos: ${labels ? labels.totalCompleteCycles : 0}<br>
        Sessões: ${daySummary ? daySummary.sessionCount : 0}<br>
        Períodos de estudo: ${periods}
      </p>
    `;
  }));

  // Cada item aqui é um assunto dentro de um dia que NÃO foi selecionado
  // por inteiro (ver _clearSubjectSelectionsForDate) — por isso mostra só
  // as sessões daquele assunto, e deixa explícito que o resto do dia fica.
  const subjectsDetail = await Promise.all(subjectEntries.map(async ({ dateKey, subjectKey }) => {
    const daySummary = lastFullHistorySummary.find((d) => d.dateKey === dateKey);
    const subject = daySummary?.subjects.find((s) => s.subjectKey === subjectKey);
    const sessions = await getSessionsForDate(dateKey);
    const periods = sessions
      .filter((s) => normalizeSubjectKey(s.subject) === subjectKey)
      .sort((a, b) => a.dateStart - b.dateStart)
      .map((s) => `${_formatTime(s.dateStart)}–${_formatTime(s.dateEnd)} (${formatDuration(s.studiedMs)})`)
      .join(', ') || '—';

    return `
      <p class="modal-delete-day">
        <strong>${_formatDateLabel(dateKey)} · ${subject ? subject.subject : 'Assunto'}</strong><br>
        Tempo estudado: ${subject ? formatDuration(subject.totalStudiedMs) : '—'}<br>
        Ciclos completos: ${subject ? subject.completeCycles : 0}<br>
        Sessões: ${subject ? subject.sessionCount : 0}<br>
        Períodos de estudo: ${periods}<br>
        <span class="modal-delete-note">Os demais assuntos desse dia não serão afetados.</span>
      </p>
    `;
  }));

  el.modalDeleteDetails.innerHTML = daysDetail.join('') + subjectsDetail.join('');
  el.modalDeleteHistory.hidden = false;
}

function _closeDeleteHistoryModal() {
  el.modalDeleteHistory.hidden = true;
  pendingDeleteDateKeys = null;
  pendingDeleteSubjectEntries = null;
}

el.btnDeleteHistoryCancel.addEventListener('click', _closeDeleteHistoryModal);

el.btnDeleteHistoryConfirm.addEventListener('click', async () => {
  const hasDayDeletes = pendingDeleteDateKeys && pendingDeleteDateKeys.length > 0;
  const hasSubjectDeletes = pendingDeleteSubjectEntries && pendingDeleteSubjectEntries.length > 0;
  if (!hasDayDeletes && !hasSubjectDeletes) return;

  if (hasDayDeletes) await deleteSessionsForDates(pendingDeleteDateKeys);
  if (hasSubjectDeletes) await deleteSessionsForSubjects(pendingDeleteSubjectEntries);

  _closeDeleteHistoryModal();
  await refreshTodayBase();
  await renderHome();
});

// ---------- Exportar histórico (backup .json) ----------

el.btnHistoryExport.addEventListener('click', async () => {
  const backup = await buildHistoryBackup();
  const json = JSON.stringify(backup, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);

  const link = document.createElement('a');
  link.href = url;
  link.download = `pomodoro-historico-${getTodayDateKey()}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
});

// ---------- Importar histórico (backup .json) ----------

el.btnHistoryImport.addEventListener('click', () => {
  el.inputHistoryImportFile.value = '';
  el.inputHistoryImportFile.click();
});

el.inputHistoryImportFile.addEventListener('change', async () => {
  const file = el.inputHistoryImportFile.files[0];
  if (!file) return;

  let parsed;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    _openImportModal({
      isValid: false,
      error: 'Não foi possível ler o arquivo: verifique se é um JSON válido.',
    });
    return;
  }

  _openImportModal(await validateHistoryBackup(parsed));
});

function _openImportModal(result) {
  pendingImportSessions = result.isValid ? result.newSessions : null;

  if (!result.isValid) {
    el.modalImportDetails.innerHTML = `<p class="field-warning">${result.error}</p>`;
    el.btnImportHistoryConfirm.disabled = true;
  } else {
    const parts = [`<p>${result.totalInFile} registro(s) encontrado(s) no arquivo.</p>`];
    parts.push(`<p><strong>${result.newSessions.length}</strong> serão importados (novos, recuperados do backup).</p>`);
    if (result.recoveredCount > 0) {
      parts.push(`<p>${result.recoveredCount} deles são registros antigos (formato anterior) reconstruídos a partir das datas de início e término originais.</p>`);
    }
    if (result.duplicateCount > 0) {
      parts.push(`<p>${result.duplicateCount} já existem no histórico atual e serão ignorados, sem duplicar.</p>`);
    }
    if (result.invalidCount > 0) {
      parts.push(`<p class="field-warning">${result.invalidCount} registro(s) com estrutura inválida serão ignorados.</p>`);
    }
    if (result.newSessions.length === 0) {
      parts.push('<p>Nada novo para importar.</p>');
    }
    el.modalImportDetails.innerHTML = parts.join('');
    el.btnImportHistoryConfirm.disabled = result.newSessions.length === 0;
  }

  el.modalImportHistory.hidden = false;
}

function _closeImportModal() {
  el.modalImportHistory.hidden = true;
  pendingImportSessions = null;
}

el.btnImportHistoryCancel.addEventListener('click', _closeImportModal);

el.btnImportHistoryConfirm.addEventListener('click', async () => {
  if (!pendingImportSessions || pendingImportSessions.length === 0) return;
  await commitHistoryImport(pendingImportSessions);
  _closeImportModal();
  await refreshTodayBase();
  await renderHome();
});

// ---------- Gráfico semanal ----------

const WEEKDAY_LABELS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
const CHART_GRIDLINE_RATIOS = [0.25, 0.5, 0.75]; // linhas de referência, puramente decorativas

// Escopo do gráfico: "all" soma todos os assuntos do dia (comportamento
// histórico); "subject" filtra pelo texto digitado em chartSubjectQuery,
// usando a mesma normalização de assunto do histórico (normalizeSubjectKey,
// aplicada dentro de getLastNDaysSummary em history.js) — assim "matemática",
// " Matemática" e "MATEMÁTICA" contam como a mesma correspondência.
let chartScope = 'all';
let chartSubjectQuery = '';

function _setChartScope(scope) {
  if (scope === chartScope) return;
  chartScope = scope;
  el.chartScopeButtons.forEach((btn) => {
    btn.setAttribute('aria-pressed', String(btn.dataset.chartScope === scope));
  });
  el.chartSubjectField.hidden = scope !== 'subject';
  if (scope === 'subject') el.chartSubjectInput.focus();
}

el.chartScopeButtons.forEach((btn) => {
  btn.addEventListener('click', async () => {
    _setChartScope(btn.dataset.chartScope);
    await renderChart();
  });
});

el.chartSubjectInput.addEventListener('input', async () => {
  chartSubjectQuery = el.chartSubjectInput.value;
  await renderChart();
});

async function renderChart() {
  const trimmedSubject = chartSubjectQuery.trim();
  const isSubjectScope = chartScope === 'subject';
  const subjectFilter = isSubjectScope && trimmedSubject ? trimmedSubject : null;

  el.chartTitle.textContent = subjectFilter
    ? `Tempo estudado em "${trimmedSubject}" por dia`
    : 'Tempo estudado por dia';

  // Modo personalizado sem nada digitado ainda: não faz sentido mostrar o
  // gráfico geral por baixo (confundiria com o resultado de uma busca vazia)
  // nem um gráfico "zerado" — só um convite claro para digitar o assunto.
  if (isSubjectScope && !trimmedSubject) {
    _hideChartTooltip();
    el.chartAxis.hidden = true;
    el.chartBars.innerHTML = '<p class="chart-empty">Digite o nome de um assunto para ver o estudo personalizado.</p>';
    el.chartTotal.textContent = '';
    el.chartGoalLine.hidden = true;
    el.chartAvgLine.hidden = true;
    el.chartGoalTag.hidden = true;
    el.chartAvgTag.hidden = true;
    el.chartGridlines.innerHTML = '';
    return;
  }

  const days = await getLastNDaysSummary(7, undefined, subjectFilter);
  const totals = days.map((d) => d.totalStudiedMs);

  // Meta diária definida em Preferências (0 = sem meta, linha fica escondida).
  // No modo personalizado a meta não se aplica (ela é do dia inteiro, não de
  // um assunto específico), então a linha fica sempre oculta nesse caso.
  const goalMinutes = !subjectFilter ? (currentPreferences.dailyGoalMinutes || 0) : 0;
  const goalMs = goalMinutes > 0 ? goalMinutes * 60 * 1000 : 0;

  // A meta entra no cálculo do teto do gráfico (maxMs) para que a linha de
  // meta sempre caiba na área visível, mesmo em semanas onde nenhum dia
  // ainda chegou perto dela.
  const maxMs = Math.max(...totals, goalMs);

  _hideChartTooltip();

  if (maxMs === 0) {
    const emptyMessage = subjectFilter
      ? `Nenhum estudo de "${trimmedSubject}" registrado nos últimos 7 dias.`
      : 'Nenhum estudo registrado nos últimos 7 dias.';
    el.chartAxis.hidden = true;
    el.chartBars.innerHTML = `<p class="chart-empty">${emptyMessage}</p>`;
    el.chartTotal.textContent = '';
    el.chartGoalLine.hidden = true;
    el.chartAvgLine.hidden = true;
    el.chartGoalTag.hidden = true;
    el.chartAvgTag.hidden = true;
    el.chartGridlines.innerHTML = '';
    return;
  }

  el.chartAxis.hidden = false;
  el.chartGridlines.innerHTML = CHART_GRIDLINE_RATIOS
    .map((ratio) => `<div class="chart-gridline" style="top: ${(1 - ratio) * 100}%"></div>`)
    .join('');

  const todayKey = getTodayDateKey();

  el.chartBars.innerHTML = days
    .map((day) => {
      const [year, month, dayOfMonth] = day.dateKey.split('-').map(Number);
      const weekday = new Date(year, month - 1, dayOfMonth).getDay();
      const hasStudy = day.totalStudiedMs > 0;
      // Altura proporcional ao dia com mais estudo na janela (ou à meta,
      // se ela for maior); um piso mínimo (4%) garante que a barra continue
      // visível/clicável mesmo em dias baixos.
      const heightPct = hasStudy ? Math.max(4, (day.totalStudiedMs / maxMs) * 100) : 2;
      const isToday = day.dateKey === todayKey;

      return `
        <div class="chart-bar-col${isToday ? ' today' : ''}">
          <span class="chart-bar-value">${hasStudy ? formatDuration(day.totalStudiedMs) : ''}</span>
          <div class="chart-bar-track">
            <div class="chart-bar${hasStudy ? ' has-study' : ''}" style="height: ${heightPct}%"></div>
          </div>
          <span class="chart-bar-label">${WEEKDAY_LABELS[weekday]}</span>
        </div>
      `;
    })
    .join('');

  // Tooltip customizado ao passar o mouse (ou tocar) em cada coluna: mostra
  // a data, o tempo estudado e a quantos ciclos do tempo de estudo padrão
  // (Preferências) aquele dia equivale — ex: "2,7 ciclos de 35min".
  const referenceStudyMs = currentPreferences.defaultStudyMinutes * 60 * 1000;
  Array.from(el.chartBars.querySelectorAll('.chart-bar-col')).forEach((col, i) => {
    const day = days[i];
    col.addEventListener('mouseenter', () => _showChartTooltip(col, day, referenceStudyMs));
    col.addEventListener('mouseleave', _hideChartTooltip);
  });

  const weekTotalMs = totals.reduce((sum, ms) => sum + ms, 0);
  // Média simples: soma de todos os dias com estudo dividida pela
  // quantidade desses dias (dias sem nenhum estudo não entram na conta,
  // senão eles "diluiriam" a média para baixo).
  const daysWithStudyCount = totals.filter((ms) => ms > 0).length;
  const avgMs = daysWithStudyCount > 0 ? weekTotalMs / daysWithStudyCount : 0;

  _positionChartMarker(el.chartGoalLine, el.chartGoalTag, goalMs, maxMs, `Meta ${formatDuration(goalMs)}`);
  el.chartGoalLine.hidden = goalMs <= 0;
  el.chartGoalTag.hidden = goalMs <= 0;

  _positionChartMarker(el.chartAvgLine, el.chartAvgTag, avgMs, maxMs, `Média ${formatDuration(avgMs)}`);
  el.chartAvgLine.hidden = false;
  el.chartAvgTag.hidden = false;

  const goalLabel = goalMs > 0 ? ` · Meta: ${formatDuration(goalMs)}/dia` : '';
  el.chartTotal.textContent = `Total da semana: ${formatDuration(weekTotalMs)} · Média: ${formatDuration(avgMs)}/dia${goalLabel}`;
}

/**
 * Posiciona (em pixels) a linha de referência DENTRO da área de plotagem e o
 * selo correspondente na coluna de eixo à esquerda, ambos na mesma altura
 * (mesma referência de escala 0 a maxMs) — assim ficam alinhados entre si
 * sem que o selo tampe as barras ou os valores do gráfico.
 */
function _positionChartMarker(lineEl, tagEl, valueMs, maxMs, text) {
  const ratio = maxMs > 0 ? Math.min(1, valueMs / maxMs) : 0;
  const topPx = CHART_VALUE_ROW_HEIGHT_PX + (1 - ratio) * CHART_TRACK_HEIGHT_PX;
  lineEl.style.top = `${topPx}px`;
  tagEl.style.top = `${topPx}px`;
  tagEl.textContent = text;
}

/** Mostra o tooltip customizado centralizado sobre a coluna do dia com o resumo daquele dia. */
function _showChartTooltip(colEl, day, referenceStudyMs) {
  const hasStudy = day.totalStudiedMs > 0;
  const timeLabel = hasStudy ? formatDuration(day.totalStudiedMs) : 'Sem estudo';
  const equivalentCycles = computeEquivalentCycles(day.totalStudiedMs, referenceStudyMs);
  const cyclesLabel = `${formatCycleCount(equivalentCycles)} ciclos de ${currentPreferences.defaultStudyMinutes}min`;

  el.chartTooltip.innerHTML = `<strong>${_formatDateLabel(day.dateKey)}</strong>${timeLabel}<br>${cyclesLabel}`;

  const plotRect = el.chartPlot.getBoundingClientRect();
  const colRect = colEl.getBoundingClientRect();
  el.chartTooltip.style.left = `${colRect.left - plotRect.left + colRect.width / 2}px`;
  el.chartTooltip.hidden = false;
  el.chartTooltip.classList.add('visible');
}

function _hideChartTooltip() {
  el.chartTooltip.hidden = true;
  el.chartTooltip.classList.remove('visible');
}

el.btnChart.addEventListener('click', async () => {
  await renderChart();
  showView('chart', 'forward');
});

el.btnChartBack.addEventListener('click', () => showView('home', 'backward'));

// ---------- Autocomplete de assunto (sugestões) ----------
//
// Um único comportamento reaproveitado nos dois lugares onde o usuário
// digita um assunto: o campo de assunto ao iniciar um estudo (Configuração)
// e o filtro "Estudo personalizado" (Gráfico). Conforme a pessoa digita,
// mostra os assuntos já conhecidos (ver registerKnownSubject/
// getSubjectSuggestions em history.js) que combinam por prefixo — "p" sugere
// "Programação", "Probabilidade", "Paralelismo"; "pr" mantém as duas
// primeiras; "prog" só "Programação".
function _attachSubjectAutocomplete(inputEl, listEl, onPick) {
  function _hideSuggestions() {
    listEl.hidden = true;
    listEl.innerHTML = '';
  }

  async function _refreshSuggestions() {
    const query = inputEl.value;
    const suggestions = await getSubjectSuggestions(query);
    if (suggestions.length === 0) {
      _hideSuggestions();
      return;
    }
    listEl.innerHTML = suggestions
      .map((subject) => `<li><button type="button" class="subject-suggestion">${subject}</button></li>`)
      .join('');
    listEl.hidden = false;
  }

  // mousedown (em vez de click) + preventDefault: dispara ANTES do blur do
  // input, então a seleção acontece sem o campo perder o foco no meio do
  // caminho (o que faria o dropdown fechar antes do clique ser processado).
  listEl.addEventListener('mousedown', (event) => {
    const button = event.target.closest('.subject-suggestion');
    if (!button) return;
    event.preventDefault();
    inputEl.value = button.textContent;
    _hideSuggestions();
    onPick?.(button.textContent);
  });

  inputEl.addEventListener('input', _refreshSuggestions);
  inputEl.addEventListener('focus', _refreshSuggestions);
  // Pequeno atraso: cobre o caso (ex: toque em telas sensíveis) em que o
  // blur dispara antes do listener de mousedown acima ter processado o clique.
  inputEl.addEventListener('blur', () => setTimeout(_hideSuggestions, 150));
  inputEl.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') _hideSuggestions();
  });
}

// Campo de assunto ao iniciar um estudo: só preenche o próprio campo ao
// escolher uma sugestão, sem nenhum efeito colateral adicional.
_attachSubjectAutocomplete(el.inputSubject, el.subjectSuggestions);

// Campo de assunto do gráfico personalizado: escolher uma sugestão precisa
// também atualizar o filtro e re-renderizar o gráfico (equivalente a digitar
// o texto inteiro), já que o clique não passa pelo input normal do usuário.
_attachSubjectAutocomplete(el.chartSubjectInput, el.chartSubjectSuggestions, async (subject) => {
  chartSubjectQuery = subject;
  await renderChart();
});

// ---------- Configuração ----------

function showConfigView() {
  restManuallyEdited = false;
  el.inputStudy.value = currentPreferences.defaultStudyMinutes;
  el.inputRest.value = _suggestRestMinutes(currentPreferences.defaultStudyMinutes);
  el.inputSubject.value = '';
  showView('config', 'forward');
}

// ---------- Modal de sessão de estudo inacabada ----------

function _openResumeModal() {
  const status = app.getStatus();
  if (status.timer) {
    const studiedMin = Math.max(1, Math.round((status.timer.totalMs - status.timer.remainingMs) / 60000));
    const totalMin = Math.round(status.timer.totalMs / 60000);
    el.modalResumeDetail.textContent = `Você estudou ${studiedMin}min de um ciclo de ${totalMin}min.`;
  } else {
    el.modalResumeDetail.textContent = '';
  }
  el.modalResumeQuestion.textContent = `Deseja continuar o ciclo de "${app.getCurrentSubject()}"?`;
  el.modalResume.hidden = false;
}

function _closeResumeModal() {
  // [hidden] corta a renderização na hora — para a saída também animar
  // (não só a entrada), espera a animação de saída (.closing, ver
  // motion.css) antes de esconder de fato.
  if (_prefersReducedMotion()) {
    el.modalResume.hidden = true;
    return;
  }
  el.modalResume.classList.add('closing');
  setTimeout(() => {
    el.modalResume.hidden = true;
    el.modalResume.classList.remove('closing');
  }, 120); // deve bater com --duration-fast em motion.css
}

el.btnResumeSession.addEventListener('click', async () => {
  _closeResumeModal();
  await renderForPhase(app.getPhase());
});

el.btnNewSession.addEventListener('click', async () => {
  _closeResumeModal();
  await app.finalizeStudyAndReturnToConfig();
  await refreshTodayBase();
  showConfigView();
});

// Clique acidental no "+": fecha o modal sem escolher nada, sem tocar na
// sessão pausada (nem retoma, nem descarta) — o usuário só volta pra onde
// já estava.
// Guard: se o index.html carregado for uma versão antiga (sem o botão "×"
// no modal), el.btnCloseResumeModal vem null — sem este "if", o erro ao
// chamar addEventListener em null interromperia todo o app.js a partir
// daqui, incluindo o carregamento do histórico.
if (el.btnCloseResumeModal) {
  el.btnCloseResumeModal.addEventListener('click', () => {
    _closeResumeModal();
  });
}

el.btnNew.addEventListener('click', async () => {
  // Só se aplica ao estudo (não ao descanso): se houver uma sessão pausada
  // (deixada pela seta de voltar), pergunta se quer continuar ou começar
  // uma nova em vez de simplesmente descartar.
  // Um ciclo pausado de um dia anterior também pode ser continuado: o que
  // ele já estudou está gravado no dia em que aconteceu, e só o que rodar a
  // partir da retomada será contado no dia da retomada.
  if (app.getPhase() === Phase.STUDY) {
    _openResumeModal();
    return;
  }
  showConfigView();
});
el.btnConfigBack.addEventListener('click', () => showView('home', 'backward'));

// Mantém o descanso sugerido na proporção definida em Preferências
// (padrão 5:1) enquanto o usuário não mexer nele manualmente.
let restManuallyEdited = false;

function _suggestRestMinutes(studyMin) {
  const restMs = computeRestMsForRatio(
    studyMin * 60 * 1000,
    currentPreferences.ratioStudyPart,
    currentPreferences.ratioRestPart
  );
  return Math.max(1, Math.round(restMs / 60000));
}

el.inputStudy.addEventListener('input', () => {
  if (restManuallyEdited) return;
  const studyMin = Number(el.inputStudy.value) || 0;
  el.inputRest.value = studyMin > 0 ? _suggestRestMinutes(studyMin) : '';
});

el.inputRest.addEventListener('input', () => {
  restManuallyEdited = true;
});

el.configForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const studyMin = Number(el.inputStudy.value);
  const restMin = Number(el.inputRest.value);
  if (!(studyMin > 0) || !(restMin > 0)) return;

  restManuallyEdited = false;
  _requestNotificationPermissionIfNeeded();
  await registerKnownSubject(el.inputSubject.value);
  await app.configure(studyMin * 60 * 1000, restMin * 60 * 1000, el.inputSubject.value);
  app.startStudy();
});

// ---------- Cronômetro (estudo/descanso) ----------

async function renderTimerShell(phase) {
  const isStudy = phase === Phase.STUDY;
  el.timerState.textContent = isStudy ? 'ESTUDO' : 'DESCANSO';
  el.timerState.classList.toggle('rest', !isStudy);
  el.timerDisplay.classList.toggle('rest', !isStudy);

  if (currentPreferences.showSubjectInTimer) {
    el.timerSubject.textContent = app.getCurrentSubject();
    el.timerSubject.hidden = false;
  } else {
    el.timerSubject.hidden = true;
  }

  // Estudo nunca diminui: some com os botões -1min/-5min nessa fase.
  el.timeAdjustButtons.forEach((btn) => {
    const delta = Number(btn.dataset.delta);
    btn.hidden = isStudy && delta < 0;
  });

  await refreshTodayBase();

  const status = app.getStatus();
  if (status.timer) {
    el.timerRemaining.textContent = _formatClock(status.timer.remainingMs);
    el.timerConfigured.textContent = `de ${formatDuration(status.timer.totalMs)}`;
    _prepareRingEntrance(status.timer.remainingMs, status.timer.totalMs);
  }
  updateToggleButtonLabel();
  renderCycleInfo();
}

function renderTick(remainingMs, totalMs) {
  el.timerRemaining.textContent = _formatClock(remainingMs);
  el.timerConfigured.textContent = `de ${formatDuration(totalMs)}`;
  _setRingProgress(remainingMs, totalMs);
  renderCycleInfo();
}

function _setRingProgress(remainingMs, totalMs) {
  const progress = totalMs > 0 ? 1 - remainingMs / totalMs : 0;
  el.progressRingFg.style.strokeDashoffset = String(RING_CIRCUMFERENCE * (1 - progress));
}

/**
 * Se o ciclo já tem progresso (retomar pelo modal, restaurar após F5, ou
 * voltar pela seta), deixa o anel já em 0 — sem transição — antes mesmo
 * de a tela aparecer, e guarda o valor real pra onde ele deve ir. Assim,
 * o primeiro frame em que a tela do cronômetro fica visível já mostra o
 * anel vazio, e _playRingEntranceIfPending() dispara o preenchimento logo
 * em seguida, sem nenhuma pausa perceptível entre um e outro.
 * Um ciclo recém-iniciado (progresso zero) não precisa de nada disso.
 */
let _pendingRingEntrance = null;

function _prepareRingEntrance(remainingMs, totalMs) {
  const hasProgress = totalMs > 0 && remainingMs < totalMs;

  if (!hasProgress || _prefersReducedMotion()) {
    _pendingRingEntrance = null;
    _setRingProgress(remainingMs, totalMs);
    return;
  }

  _pendingRingEntrance = { remainingMs, totalMs };
  el.progressRingFg.classList.add('ring-catchup');
  el.progressRingFg.style.transition = 'none';
  el.progressRingFg.style.strokeDashoffset = String(RING_CIRCUMFERENCE);
}

/**
 * Chamada logo depois de a tela do cronômetro ficar visível. Um único
 * requestAnimationFrame basta aqui (diferente de antes) porque o anel já
 * foi zerado num passo anterior, ainda com a tela escondida — só
 * precisamos garantir que o navegador pintou esse estado "vazio" already
 * visível antes de soltar a transição para o valor real.
 */
function _playRingEntranceIfPending() {
  if (!_pendingRingEntrance) return;
  const { remainingMs, totalMs } = _pendingRingEntrance;
  _pendingRingEntrance = null;

  requestAnimationFrame(() => {
    el.progressRingFg.style.transition = '';
    _setRingProgress(remainingMs, totalMs);

    const cleanup = () => el.progressRingFg.classList.remove('ring-catchup');
    el.progressRingFg.addEventListener('transitionend', cleanup, { once: true });
    setTimeout(cleanup, 1000); // salvaguarda caso transitionend não dispare
  });
}

function renderCycleInfo() {
  const phase = app.getPhase();
  if (phase !== Phase.STUDY) {
    el.timerCycleInfo.textContent = '';
    el.timerTodayTotal.textContent = '';
    return;
  }

  const status = app.getStatus();
  if (!status.timer) return;

  const studiedMs = status.timer.totalMs - status.timer.remainingMs;
  const configuredMs = status.timer.totalMs;
  const progress = computeCycleProgress(studiedMs, configuredMs);

  el.timerCycleInfo.textContent = progress.completeCycles > 0
    ? `${progress.completeCycles} ciclo(s) + ${formatCycleCount(progress.partialFraction, 2)} concluído`
    : `${formatCycleCount(progress.partialFraction, 2)} ciclo concluído`;

  // todayBaseMs/todayBaseMsForCurrentSubject já incluem todos os períodos
  // gravados (inclusive de pausas anteriores deste mesmo ciclo); só falta
  // somar o período em execução agora — que é sempre do assunto atual, então
  // soma certo nos dois escopos.
  const isSubjectScope = currentPreferences.todayTotalScope === TodayTotalScope.SUBJECT;
  const todayBase = isSubjectScope ? todayBaseMsForCurrentSubject : todayBaseMs;
  const todayLabel = isSubjectScope ? `Estudado hoje de ${app.getCurrentSubject()}` : 'Estudado hoje';
  el.timerTodayTotal.textContent = `${todayLabel}: ${formatDuration(todayBase + app.getOpenRunPeriodTodayMs())}`;
}

function updateToggleButtonLabel() {
  const status = app.getStatus();
  const isRunning = status.timer && status.timer.state === 'RUNNING';
  el.btnToggle.textContent = isRunning ? 'Pausar' : 'Continuar';
}

el.btnToggle.addEventListener('click', () => {
  const status = app.getStatus();
  const isRunning = status.timer && status.timer.state === 'RUNNING';
  const phase = app.getPhase();

  if (phase === Phase.STUDY) {
    isRunning ? app.pauseStudy() : app.resumeStudy();
  } else if (phase === Phase.REST) {
    isRunning ? app.pauseRest() : app.resumeRest();
  }
  updateToggleButtonLabel();
});

el.btnReset.addEventListener('click', async () => {
  const phase = app.getPhase();
  if (phase === Phase.STUDY) await app.resetStudy();
  else if (phase === Phase.REST) app.resetRest();
  await refreshTodayBase(); // garante que o cache já reflete a sessão parcial recém-salva, sem piscar um valor antigo
  updateToggleButtonLabel();
  renderCycleInfo();
});

el.timeAdjustButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    const deltaMs = Number(btn.dataset.delta) * 60 * 1000;
    const phase = app.getPhase();
    try {
      if (phase === Phase.STUDY) app.addStudyTime(deltaMs);
      else if (phase === Phase.REST) app.addRestTime(deltaMs);
    } catch (err) {
      console.warn(err.message);
    }
  });
});

el.btnTimerHome.addEventListener('click', async () => {
  // Durante o estudo, sair pela seta de voltar pausa o cronômetro, o que
  // fecha e grava o período que estava rodando (e só ele — o que já tiver
  // sido gravado em pausas anteriores não é contado de novo). A sessão continua
  // aberta para ser retomada pelo botão "+" — só quem decide se continua
  // ou começa uma nova é o usuário, no modal. No descanso, o cronômetro
  // continua em segundo plano normalmente.
  if (app.getPhase() === Phase.STUDY) {
    await app.pauseStudyIfRunning();
    await refreshTodayBase();
  }
  showView('home', 'backward');
  renderHome();
});

// ---------- Alerta de fim de ciclo ----------

function renderAlert(phase) {
  const isStudyDone = phase === Phase.STUDY_ALERT;
  el.alertIcon.textContent = isStudyDone ? '✅' : '⏰';
  el.alertMessage.textContent = isStudyDone
    ? 'Estudo concluído! Hora de descansar.'
    : 'Descanso concluído! Hora de estudar.';

  // No modo "clicar para continuar" o alarme para sozinho, mas a fase não
  // avança sozinha — esse aviso evita que pareça que o app travou.
  el.alertHint.hidden = currentPreferences.cycleTransitionMode !== CycleTransitionMode.MANUAL;
}

el.btnStopSound.addEventListener('click', () => {
  app.stopAlertSound();
});

el.btnSkipAlert.addEventListener('click', () => {
  app.skipAlert();
});

// ---------- Notificações em segundo plano ----------

/**
 * Pede permissão de notificação na primeira vez que o usuário inicia um
 * estudo (não no carregamento da página, para não assustar/ser ignorado
 * antes de o app mostrar valor). Se o navegador não suportar a API, ou se
 * a pessoa já tiver respondido antes (concedido ou negado), Notification.
 * permission deixa de ser 'default' e isto não faz mais nada nas próximas
 * vezes — não precisa de nenhum controle extra de "já perguntei".
 */
function _requestNotificationPermissionIfNeeded() {
  if (typeof Notification === 'undefined') return;
  if (Notification.permission === 'default') {
    Notification.requestPermission().catch(() => {});
  }
}

/**
 * Dispara uma notificação do navegador + vibração (mobile) quando um ciclo
 * termina enquanto a aba está em segundo plano — o alarme sonoro sozinho
 * não ajuda se a pessoa estiver noutro app/aba e não ouvir o beep.
 * Não faz nada se a aba estiver visível (a tela de alerta já cobre esse
 * caso) ou se a permissão não tiver sido concedida.
 */
function _notifyPhaseFinishedIfHidden(phase) {
  if (document.visibilityState !== 'hidden') return;
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;

  const isStudyDone = phase === Phase.STUDY_ALERT;
  const title = isStudyDone ? 'Estudo concluído! 🍅' : 'Descanso concluído!';
  const body = isStudyDone ? 'Hora de descansar.' : 'Hora de voltar a estudar.';

  if (navigator.vibrate) navigator.vibrate([200, 100, 200]);

  if (navigator.serviceWorker && navigator.serviceWorker.controller) {
    // Via service worker: a notificação continua funcionando mesmo se a
    // aba tiver sido totalmente descarregada da memória pelo navegador.
    navigator.serviceWorker.ready.then((registration) => {
      registration.showNotification(title, { body, icon: './img/icon-192.png', tag: 'pomodoro-alert' });
    });
  } else {
    new Notification(title, { body, icon: './img/icon-192.png', tag: 'pomodoro-alert' });
  }
}

// ---------- Utilitário local ----------

function _formatClock(ms) {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

// ---------- Boot ----------

// Salva o progresso imediatamente ao esconder a aba (trocar de app, minimizar,
// fechar), em vez de esperar o intervalo normal de persistência — vale a
// partir de qualquer tempo já estudado/descansado, mesmo pouco. Mostra um
// pequeno indicador para o usuário confirmar visualmente que foi salvo.
let saveIndicatorHideTimeout = null;

function _showSavingIndicator() {
  clearTimeout(saveIndicatorHideTimeout);
  el.saveIndicator.textContent = '💾 Salvando…';
  el.saveIndicator.hidden = false;
  requestAnimationFrame(() => el.saveIndicator.classList.add('visible'));
}

function _showSavedConfirmation() {
  el.saveIndicator.textContent = '💾 Progresso salvo';
  saveIndicatorHideTimeout = setTimeout(() => {
    el.saveIndicator.classList.remove('visible');
    setTimeout(() => { el.saveIndicator.hidden = true; }, 200);
  }, 1500);
}

document.addEventListener('visibilitychange', () => {
  const phase = app.getPhase();
  if (phase !== Phase.STUDY && phase !== Phase.REST) return;

  if (document.visibilityState === 'hidden') {
    app.persistNow();
    _showSavingIndicator();
  } else if (document.visibilityState === 'visible') {
    // Garante que o alarme dispare sem atraso perceptível mesmo se os
    // timers tiverem sofrido throttling (ou sido suspensos) em segundo
    // plano — ver comentário em CountdownTimer.forceCheck().
    app.checkTimerNow();
    if (!el.saveIndicator.hidden) {
      _showSavedConfirmation();
    }
  }
});

// Fallback: alguns navegadores (principalmente mobile) disparam pagehide
// sem um visibilitychange confiável antes de fechar de fato a aba.
window.addEventListener('pagehide', () => {
  const phase = app.getPhase();
  if (phase === Phase.STUDY || phase === Phase.REST) app.persistNow();
});

// Registra o service worker (cache offline + instalação como PWA). Falha
// silenciosa em navegadores sem suporte — o app continua funcionando
// normalmente sem esse recurso, só sem cache offline.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((err) => {
      console.warn('[app] Falha ao registrar o service worker:', err);
    });
  });
}

(async function init() {
  await loadCurrentPreferences();
  await app.init();
  // init() já dispara onPhaseChange internamente quando não há timer para
  // restaurar; garantimos a primeira renderização também para o caso de
  // restauração de um cronômetro em andamento (também chama onPhaseChange).
  await renderForPhase(app.getPhase());
})();
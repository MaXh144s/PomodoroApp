/**
 * app.js
 * Camada de UI: liga o DOM (index.html) ao PomodoroApp (appstate.js).
 * Não contém regra de negócio — apenas renderização e captura de eventos,
 * delegando tudo (cronômetro, ciclos, histórico, som, persistência) aos
 * módulos já existentes.
 */

import { PomodoroApp, Phase } from './appstate.js';
import { getTodaySummary, getFullHistorySummary, buildDailySummaryLabels, getLastNDaysSummary, getTodayDateKey } from './history.js';
import { computeCycleProgress, formatDuration, formatCycleCount } from './cycles.js';
import {
  getDefaultPreferences,
  computeRestMsForRatio,
  buildRatioRecommendation,
  clampAlarmDurationSeconds,
  isValidAlarmDurationSeconds,
} from './preferences.js';
import { loadPreferences, savePreferences, loadCustomSound, saveCustomSound, clearCustomSound } from './storage.js';
import { setAlertCustomSound, setAlertMaxDuration, playPreview, stopPreview, seekPreview, getAudioDuration, getAudioWaveform } from './sound.js';

const RING_CIRCUMFERENCE = 2 * Math.PI * 90; // deve bater com o raio do SVG em style.css

// Cache do tempo total estudado hoje (somente sessões já concluídas, sem
// contar a sessão em andamento). Evita ler e parsear o histórico inteiro do
// localStorage a cada tick do cronômetro (4x/seg) — feito assim antes, isso
// empilhava dezenas de milhares de leituras assíncronas ao longo de várias
// horas encadeando sessões, e "Estudado hoje" acabava travando. Agora só é
// recalculado quando muda de fato: ao entrar em estudo/descanso e quando uma
// sessão é salva.
let todayBaseMs = 0;

async function refreshTodayBase() {
  const summary = await getTodaySummary();
  todayBaseMs = summary.totalStudiedMs;
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
  btnNew: document.getElementById('btn-new'),
  btnChart: document.getElementById('btn-chart'),
  homeTotalTime: document.getElementById('home-total-time'),
  homeMotivational: document.getElementById('home-motivational'),
  homeCycles: document.getElementById('home-cycles'),
  homeSessions: document.getElementById('home-sessions'),
  homeEquivalence: document.getElementById('home-equivalence'),
  homeHistory: document.getElementById('home-history'),
  homeHistoryList: document.getElementById('home-history-list'),

  btnChartBack: document.getElementById('btn-chart-back'),
  chartBars: document.getElementById('chart-bars'),
  chartTotal: document.getElementById('chart-total'),

  btnPreferences: document.getElementById('btn-preferences'),
  btnPreferencesBack: document.getElementById('btn-preferences-back'),
  preferencesForm: document.getElementById('preferences-form'),
  prefStudyMinutes: document.getElementById('pref-study-minutes'),
  prefRatioStudy: document.getElementById('pref-ratio-study'),
  prefRatioRest: document.getElementById('pref-ratio-rest'),
  prefWarning: document.getElementById('pref-warning'),
  prefPresetButtons: Array.from(document.querySelectorAll('#preferences-form [data-preset-minutes]')),

  prefAlarmDuration: document.getElementById('pref-alarm-duration'),
  prefAlarmPresetButtons: Array.from(document.querySelectorAll('#preferences-form [data-preset-alarm-seconds]')),

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

  btnTimerHome: document.getElementById('btn-timer-home'),
  timerState: document.getElementById('timer-state'),
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
  btnStopSound: document.getElementById('btn-stop-sound'),
  btnSkipAlert: document.getElementById('btn-skip-alert'),
};

el.progressRingFg.style.strokeDasharray = String(RING_CIRCUMFERENCE);

// ---------- Instância central do app ----------

const app = new PomodoroApp({
  onPhaseChange: (phase) => renderForPhase(phase),
  onTick: (remainingMs, totalMs) => renderTick(remainingMs, totalMs),
  onSessionSaved: () => {
    // Mantém o cache de "estudado hoje" em dia sempre que uma sessão é
    // gravada (concluída ou finalizada por Reiniciar/nova configuração).
    refreshTodayBase();
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
  currentPreferences = saved || getDefaultPreferences();

  savedCustomSound = await loadCustomSound();
  setAlertCustomSound(
    savedCustomSound ? savedCustomSound.dataUrl : null,
    savedCustomSound ? (savedCustomSound.trimStartSeconds || 0) : 0
  );
  setAlertMaxDuration(currentPreferences.alarmDurationSeconds * 1000);
}

function renderPreferencesForm() {
  el.prefStudyMinutes.value = currentPreferences.defaultStudyMinutes;
  el.prefRatioStudy.value = currentPreferences.ratioStudyPart;
  el.prefRatioRest.value = currentPreferences.ratioRestPart;
  el.prefAlarmDuration.value = currentPreferences.alarmDurationSeconds;
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
  showView('preferences');
});

el.btnPreferencesBack.addEventListener('click', () => {
  stopPreview();
  previewPlaying = false;
  showView('home');
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
  const ratioStudyPart = Number(el.prefRatioStudy.value);
  const ratioRestPart = Number(el.prefRatioRest.value);
  const alarmDurationSeconds = clampAlarmDurationSeconds(Number(el.prefAlarmDuration.value));

  if (
    !(defaultStudyMinutes > 0)
    || !(ratioStudyPart > 0)
    || !(ratioRestPart > 0)
    || !isValidAlarmDurationSeconds(alarmDurationSeconds)
  ) return;

  currentPreferences = { defaultStudyMinutes, ratioStudyPart, ratioRestPart, alarmDurationSeconds };
  await savePreferences(currentPreferences);
  setAlertMaxDuration(alarmDurationSeconds * 1000);

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
  showView('home');
});

// ---------- Navegação entre telas ----------

function showView(name) {
  Object.entries(views).forEach(([key, node]) => {
    node.hidden = key !== name;
  });
}

async function renderForPhase(phase) {
  if (phase === Phase.CONFIG) {
    await renderHome();
    // Race condition: enquanto renderHome() buscava dados (async), a fase
    // pode ter avançado de novo (ex: configure() -> startStudy() disparado
    // em seguida pelo handler do formulário). Nesse caso este render ficou
    // obsoleto — não pode sobrescrever a tela que já reflete a fase atual.
    if (app.getPhase() !== phase) return;
    showView('home');
  } else if (phase === Phase.STUDY || phase === Phase.REST) {
    await renderTimerShell(phase);
    showView('timer');
  } else if (phase === Phase.STUDY_ALERT || phase === Phase.REST_ALERT) {
    renderAlert(phase);
    showView('alert');
  }
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

  const fullHistory = await getFullHistorySummary();
  if (fullHistory.length === 0) {
    el.homeHistory.hidden = true;
    el.homeHistoryList.innerHTML = '';
    return;
  }

  el.homeHistory.hidden = false;
  el.homeHistoryList.innerHTML = fullHistory
    .map((day) => {
      const dayLabels = buildDailySummaryLabels(day);
      return `
        <li>
          <span>
            <span class="history-date">${_formatDateLabel(day.dateKey)}</span><br>
            <span class="history-detail">${day.sessionCount} sessão(ões) · ${dayLabels.totalCompleteCycles} ciclos completos</span>
          </span>
          <span class="history-detail">${dayLabels.totalStudiedLabel}</span>
        </li>
      `;
    })
    .join('');
}

function _formatDateLabel(dateKey) {
  const [year, month, day] = dateKey.split('-');
  return `${day}/${month}/${year}`;
}

// ---------- Gráfico semanal ----------

const WEEKDAY_LABELS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

async function renderChart() {
  const days = await getLastNDaysSummary(7);
  const maxMs = Math.max(...days.map((d) => d.totalStudiedMs));

  if (maxMs === 0) {
    el.chartBars.innerHTML = '<p class="chart-empty">Nenhum estudo registrado nos últimos 7 dias.</p>';
    el.chartTotal.textContent = '';
    return;
  }

  const todayKey = getTodayDateKey();

  el.chartBars.innerHTML = days
    .map((day) => {
      const [year, month, dayOfMonth] = day.dateKey.split('-').map(Number);
      const weekday = new Date(year, month - 1, dayOfMonth).getDay();
      const hasStudy = day.totalStudiedMs > 0;
      // Altura proporcional ao dia com mais estudo na janela; um piso mínimo
      // (4%) garante que a barra continue visível/clicável mesmo em dias baixos.
      const heightPct = hasStudy ? Math.max(4, (day.totalStudiedMs / maxMs) * 100) : 2;
      const isToday = day.dateKey === todayKey;

      return `
        <div class="chart-bar-col${isToday ? ' today' : ''}">
          <span class="chart-bar-value">${hasStudy ? formatDuration(day.totalStudiedMs) : ''}</span>
          <div class="chart-bar${hasStudy ? ' has-study' : ''}" style="height: ${heightPct}%"></div>
          <span class="chart-bar-label">${WEEKDAY_LABELS[weekday]}</span>
        </div>
      `;
    })
    .join('');

  const weekTotalMs = days.reduce((sum, day) => sum + day.totalStudiedMs, 0);
  el.chartTotal.textContent = `Total da semana: ${formatDuration(weekTotalMs)}`;
}

el.btnChart.addEventListener('click', async () => {
  await renderChart();
  showView('chart');
});

el.btnChartBack.addEventListener('click', () => showView('home'));

// ---------- Configuração ----------

function showConfigView() {
  restManuallyEdited = false;
  el.inputStudy.value = currentPreferences.defaultStudyMinutes;
  el.inputRest.value = _suggestRestMinutes(currentPreferences.defaultStudyMinutes);
  showView('config');
}

el.btnNew.addEventListener('click', showConfigView);
el.btnConfigBack.addEventListener('click', () => showView('home'));

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
  await app.configure(studyMin * 60 * 1000, restMin * 60 * 1000);
  app.startStudy();
});

// ---------- Cronômetro (estudo/descanso) ----------

async function renderTimerShell(phase) {
  const isStudy = phase === Phase.STUDY;
  el.timerState.textContent = isStudy ? 'ESTUDO' : 'DESCANSO';
  el.timerState.classList.toggle('rest', !isStudy);
  el.timerDisplay.classList.toggle('rest', !isStudy);

  // Estudo nunca diminui: some com os botões -1min/-5min nessa fase.
  el.timeAdjustButtons.forEach((btn) => {
    const delta = Number(btn.dataset.delta);
    btn.hidden = isStudy && delta < 0;
  });

  await refreshTodayBase();

  const status = app.getStatus();
  if (status.timer) {
    renderTick(status.timer.remainingMs, status.timer.totalMs);
  }
  updateToggleButtonLabel();
  renderCycleInfo();
}

function renderTick(remainingMs, totalMs) {
  el.timerRemaining.textContent = _formatClock(remainingMs);
  el.timerConfigured.textContent = `de ${formatDuration(totalMs)}`;

  const progress = totalMs > 0 ? 1 - remainingMs / totalMs : 0;
  el.progressRingFg.style.strokeDashoffset = String(RING_CIRCUMFERENCE * (1 - progress));

  renderCycleInfo();
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

  el.timerTodayTotal.textContent = `Estudado hoje: ${formatDuration(todayBaseMs + studiedMs)}`;
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

el.btnTimerHome.addEventListener('click', () => {
  // Volta para a tela inicial sem interromper o cronômetro em andamento.
  showView('home');
  renderHome();
});

// ---------- Alerta de fim de ciclo ----------

function renderAlert(phase) {
  const isStudyDone = phase === Phase.STUDY_ALERT;
  el.alertIcon.textContent = isStudyDone ? '✅' : '⏰';
  el.alertMessage.textContent = isStudyDone
    ? 'Estudo concluído! Hora de descansar.'
    : 'Descanso concluído! Hora de estudar.';
}

el.btnStopSound.addEventListener('click', () => {
  app.stopAlertSound();
});

el.btnSkipAlert.addEventListener('click', () => {
  app.skipAlert();
});

// ---------- Utilitário local ----------

function _formatClock(ms) {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

// ---------- Boot ----------

(async function init() {
  await loadCurrentPreferences();
  await app.init();
  // init() já dispara onPhaseChange internamente quando não há timer para
  // restaurar; garantimos a primeira renderização também para o caso de
  // restauração de um cronômetro em andamento (também chama onPhaseChange).
  await renderForPhase(app.getPhase());
})();
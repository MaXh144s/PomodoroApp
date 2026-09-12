/**
 * app.js
 * Camada de UI: liga o DOM (index.html) ao PomodoroApp (appstate.js).
 * Não contém regra de negócio — apenas renderização e captura de eventos,
 * delegando tudo (cronômetro, ciclos, histórico, som, persistência) aos
 * módulos já existentes.
 */

import { PomodoroApp, Phase, computeDefaultRestMs } from './appstate.js';
import { getTodaySummary, getFullHistorySummary, buildDailySummaryLabels } from './history.js';
import { computeCycleProgress, formatDuration, formatCycleCount } from './cycles.js';

const RING_CIRCUMFERENCE = 2 * Math.PI * 90; // deve bater com o raio do SVG em style.css

// ---------- Referências de DOM ----------

const views = {
  home: document.getElementById('view-home'),
  config: document.getElementById('view-config'),
  timer: document.getElementById('view-timer'),
  alert: document.getElementById('view-alert'),
};

const el = {
  btnNew: document.getElementById('btn-new'),
  homeTotalTime: document.getElementById('home-total-time'),
  homeMotivational: document.getElementById('home-motivational'),
  homeCycles: document.getElementById('home-cycles'),
  homeSessions: document.getElementById('home-sessions'),
  homeEquivalence: document.getElementById('home-equivalence'),
  homeHistory: document.getElementById('home-history'),
  homeHistoryList: document.getElementById('home-history-list'),

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
    // Sessão gravada no histórico; a tela inicial é recalculada quando o
    // usuário voltar para ela (renderHome busca os dados mais recentes).
  },
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
    renderTimerShell(phase);
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

// ---------- Configuração ----------

function showConfigView() {
  showView('config');
}

el.btnNew.addEventListener('click', showConfigView);
el.btnConfigBack.addEventListener('click', () => showView('home'));

// Mantém o descanso sugerido em proporção 5:1 enquanto o usuário não mexer nele manualmente.
let restManuallyEdited = false;

el.inputStudy.addEventListener('input', () => {
  if (restManuallyEdited) return;
  const studyMin = Number(el.inputStudy.value) || 0;
  const restMs = computeDefaultRestMs(studyMin * 60 * 1000);
  el.inputRest.value = Math.max(1, Math.round(restMs / 60000));
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

function renderTimerShell(phase) {
  const isStudy = phase === Phase.STUDY;
  el.timerState.textContent = isStudy ? 'ESTUDO' : 'DESCANSO';
  el.timerState.classList.toggle('rest', !isStudy);
  el.timerDisplay.classList.toggle('rest', !isStudy);

  // Estudo nunca diminui: some com os botões -1min/-5min nessa fase.
  el.timeAdjustButtons.forEach((btn) => {
    const delta = Number(btn.dataset.delta);
    btn.hidden = isStudy && delta < 0;
  });

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

async function renderCycleInfo() {
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

  const todaySummary = await getTodaySummary();
  el.timerTodayTotal.textContent = `Estudado hoje: ${formatDuration(todaySummary.totalStudiedMs + studiedMs)}`;
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
  updateToggleButtonLabel();
  renderCycleInfo(); // reflete o "estudado hoje" já somando a sessão parcial recém-salva
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
  await app.init();
  // init() já dispara onPhaseChange internamente quando não há timer para
  // restaurar; garantimos a primeira renderização também para o caso de
  // restauração de um cronômetro em andamento (também chama onPhaseChange).
  await renderForPhase(app.getPhase());
})();
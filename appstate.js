/**
 * appState.js
 * Orquestrador central do app: liga timer.js, cycles.js (via history.js),
 * storage.js e sound.js numa única máquina de estados.
 *
 * Fluxo de fases (Phase):
 *   CONFIG -> STUDY -> STUDY_ALERT -> REST -> REST_ALERT -> STUDY -> ...
 *
 * Nenhum outro módulo conhece esse fluxo completo — a UI só precisa chamar
 * os métodos públicos desta classe e reagir aos callbacks (onPhaseChange,
 * onTick, onSessionSaved). Toda regra de negócio do prompt mora aqui:
 *   - proporção padrão 5:1 entre estudo e descanso (seção 2);
 *   - estudo nunca diminui, descanso pode aumentar ou diminuir (seções 3 e 5);
 *   - contabilização do ciclo ao terminar o estudo (seção 4);
 *   - alerta sonoro de até 10s, interrompível, em ambas as finalizações
 *     (seções 4 e 6);
 *   - novas configurações não apagam sessões/ciclos anteriores (seções 2 e 8).
 */

import { CountdownTimer, TimerState } from './timer.js';
import { createSessionRecord, saveCompletedSession } from './history.js';
import {
  loadSettings,
  saveSettings,
  loadTimerSnapshot,
  saveTimerSnapshot,
  loadAppState,
  saveAppState,
} from './storage.js';
import { studyFinishedAlert, restFinishedAlert, stopAllAlerts, unlockAudio } from './sound.js';

export const Phase = Object.freeze({
  CONFIG: 'CONFIG',             // nenhum cronômetro ativo, aguardando início
  STUDY: 'STUDY',                // estudo em andamento (rodando ou pausado)
  STUDY_ALERT: 'STUDY_ALERT',    // estudo terminou, alarme tocando/aguardando confirmação
  REST: 'REST',                  // descanso em andamento (rodando ou pausado)
  REST_ALERT: 'REST_ALERT',      // descanso terminou, alarme tocando/aguardando confirmação
});

export const STUDY_REST_RATIO = 5; // proporção padrão 5:1 (seção 2 do prompt)
export const DEFAULT_STUDY_MS = 25 * 60 * 1000;
export const DEFAULT_REST_MS = DEFAULT_STUDY_MS / STUDY_REST_RATIO;

/** Calcula o descanso padrão (proporção 5:1) para um dado tempo de estudo. */
export function computeDefaultRestMs(studyMs) {
  return Math.round(studyMs / STUDY_REST_RATIO);
}

// Snapshot é persistido no máximo a cada N ticks para não sobrecarregar o
// localStorage com escritas a cada 250ms — ainda assim persiste com
// frequência suficiente para não perder mais que ~1s de precisão num reload.
const SNAPSHOT_PERSIST_EVERY_N_TICKS = 4;

export class PomodoroApp {
  /**
   * @param {Object} [callbacks]
   * @param {(phase: string) => void} [callbacks.onPhaseChange]
   * @param {(remainingMs: number, totalMs: number) => void} [callbacks.onTick]
   * @param {(record: Object) => void} [callbacks.onSessionSaved]
   */
  constructor({ onPhaseChange = () => {}, onTick = () => {}, onSessionSaved = () => {} } = {}) {
    this._onPhaseChange = onPhaseChange;
    this._onTick = onTick;
    this._onSessionSaved = onSessionSaved;

    this._settings = { studyMs: DEFAULT_STUDY_MS, restMs: DEFAULT_REST_MS };
    this._phase = Phase.CONFIG;
    this._timer = null;
    this._studyStartTimestamp = null; // início da tentativa de estudo atual (para o registro de sessão)
    this._tickCounter = 0;
  }

  /**
   * Carrega configurações e estado salvos (se existirem) e restaura o
   * cronômetro em andamento, se houver um. Deve ser chamado uma vez, logo
   * após criar a instância e antes de qualquer outra chamada.
   */
  async init() {
    const savedSettings = await loadSettings();
    if (savedSettings) this._settings = savedSettings;

    const savedAppState = await loadAppState();

    if (savedAppState && (savedAppState.phase === Phase.STUDY || savedAppState.phase === Phase.REST)) {
      const snapshot = await loadTimerSnapshot();
      this._phase = savedAppState.phase;
      this._studyStartTimestamp = savedAppState.studyStartTimestamp ?? null;
      if (snapshot) {
        this._restoreTimerFromSnapshot(snapshot);
        return;
      }
    }

    // Sem cronômetro ativo para restaurar (ou fases de alerta não persistem
    // timer): volta para CONFIG, mantendo apenas as configurações salvas.
    this._phase = Phase.CONFIG;
    this._onPhaseChange(this._phase);
  }

  // ---------- Configuração ----------

  /** @returns {{studyMs: number, restMs: number}} configuração atual */
  getSettings() {
    return { ...this._settings };
  }

  /**
   * Define uma nova configuração de estudo/descanso. Trata como uma nova
   * sessão/configuração: se houver um estudo em andamento não finalizado,
   * ele é encerrado e registrado como sessão parcial antes de trocar
   * (preservando o cálculo de ciclo parcial descrito na seção 7 do prompt).
   * Não apaga nenhuma sessão anterior do histórico.
   * @param {number} studyMs
   * @param {number} restMs
   */
  async configure(studyMs, restMs) {
    _assertPositiveMs(studyMs, 'studyMs');
    _assertPositiveMs(restMs, 'restMs');

    await this._finalizeStudyIfInProgress();
    this._destroyTimer();
    stopAllAlerts();

    this._settings = { studyMs, restMs };
    await saveSettings(this._settings);

    this._setPhase(Phase.CONFIG);
    await saveTimerSnapshot(null);
  }

  /** Atalho: configura o estudo e aplica automaticamente o descanso padrão (proporção 5:1). */
  async configureWithDefaultRest(studyMs) {
    return this.configure(studyMs, computeDefaultRestMs(studyMs));
  }

  // ---------- Estudo ----------

  /** Inicia um novo ciclo de estudo com a configuração atual. */
  startStudy() {
    unlockAudio(); // aproveita este clique do usuário para destravar o áudio para o alerta futuro
    this._studyStartTimestamp = Date.now();
    this._timer = new CountdownTimer({
      durationMs: this._settings.studyMs,
      allowDecrease: false, // regra da seção 3: tempo de estudo nunca diminui
      onTick: (remaining, total) => this._handleTick(remaining, total),
      onFinish: () => this._handleStudyFinished(),
    });
    this._timer.start();
    this._setPhase(Phase.STUDY);
    this._persistSnapshotNow();
  }

  pauseStudy() {
    this._requirePhase(Phase.STUDY);
    this._timer.pause();
    this._persistSnapshotNow();
  }

  resumeStudy() {
    this._requirePhase(Phase.STUDY);
    this._timer.resume();
    this._persistSnapshotNow();
  }

  /** Reinicia o ciclo de estudo atual do zero, sem contabilizar nada (seção 3). */
  resetStudy() {
    this._requirePhase(Phase.STUDY);
    this._timer.reset();
    this._studyStartTimestamp = Date.now();
    this._persistSnapshotNow();
  }

  /**
   * Adiciona tempo ao estudo em andamento. Apenas valores positivos são
   * aceitos (regra da seção 3) — o próprio CountdownTimer, criado com
   * allowDecrease:false, já bloquearia negativos, mas validamos aqui
   * também para dar um erro claro em vez de uma falha silenciosa.
   * @param {number} deltaMs - deve ser > 0 (ex: +1min ou +5min em ms)
   */
  addStudyTime(deltaMs) {
    this._requirePhase(Phase.STUDY);
    if (deltaMs <= 0) {
      throw new Error('O tempo de estudo não pode ser diminuído durante a sessão atual.');
    }
    this._timer.addTime(deltaMs);
    this._persistSnapshotNow();
  }

  async _handleStudyFinished() {
    const studiedMs = this._timer.getTotalDurationMs(); // completou 100% do tempo configurado
    const configuredMs = this._timer.getTotalDurationMs();
    const endTimestamp = Date.now();

    await this._finalizeStudySession({ studiedMs, configuredMs, endTimestamp });

    this._destroyTimer();
    this._setPhase(Phase.STUDY_ALERT);
    await saveTimerSnapshot(null); // sem cronômetro ativo durante o alerta

    studyFinishedAlert.play(() => this._continueToRest());
  }

  // ---------- Descanso ----------

  pauseRest() {
    this._requirePhase(Phase.REST);
    this._timer.pause();
    this._persistSnapshotNow();
  }

  resumeRest() {
    this._requirePhase(Phase.REST);
    this._timer.resume();
    this._persistSnapshotNow();
  }

  /** Reinicia o descanso do zero, voltando ao tempo total configurado (seção 5). */
  resetRest() {
    this._requirePhase(Phase.REST);
    this._timer.reset();
    this._persistSnapshotNow();
  }

  /**
   * Ajusta o tempo de descanso. Diferente do estudo, aceita valores
   * positivos (+1min/+5min) e negativos (-1min/-5min) — regra da seção 5.
   * @param {number} deltaMs
   */
  addRestTime(deltaMs) {
    this._requirePhase(Phase.REST);
    this._timer.addTime(deltaMs);
    this._persistSnapshotNow();
  }

  async _handleRestFinished() {
    this._destroyTimer();
    this._setPhase(Phase.REST_ALERT);
    await saveTimerSnapshot(null);

    restFinishedAlert.play(() => this._continueToStudy());
  }

  // ---------- Alertas (seções 4 e 6: interromper ou pular o som) ----------

  /**
   * Interrompe o alarme que estiver tocando (estudo ou descanso finalizado)
   * sem avançar de fase — o usuário só quer silenciar o bipe.
   */
  stopAlertSound() {
    stopAllAlerts();
  }

  /**
   * Pula o alerta e avança imediatamente para a próxima fase
   * (estudo -> descanso, ou descanso -> próximo estudo).
   * Funciona tanto para "esperar os 10s" (chamado automaticamente pelo
   * AlertPlayer) quanto para "pular manualmente".
   */
  skipAlert() {
    if (this._phase === Phase.STUDY_ALERT) {
      studyFinishedAlert.stop();
      this._continueToRest();
    } else if (this._phase === Phase.REST_ALERT) {
      restFinishedAlert.stop();
      this._continueToStudy();
    }
  }

  _continueToRest() {
    if (this._phase !== Phase.STUDY_ALERT) return; // já avançou (evita corrida entre auto-stop e skip manual)
    this._timer = new CountdownTimer({
      durationMs: this._settings.restMs,
      allowDecrease: true, // regra da seção 5: descanso pode diminuir
      onTick: (remaining, total) => this._handleTick(remaining, total),
      onFinish: () => this._handleRestFinished(),
    });
    this._timer.start();
    this._setPhase(Phase.REST);
    this._persistSnapshotNow();
  }

  _continueToStudy() {
    if (this._phase !== Phase.REST_ALERT) return;
    this.startStudy();
  }

  // ---------- Consulta de status (para a UI) ----------

  getPhase() {
    return this._phase;
  }

  /**
   * @returns {{
   *   phase: string,
   *   settings: {studyMs: number, restMs: number},
   *   timer: {remainingMs: number, totalMs: number, progress: number, state: string} | null
   * }}
   */
  getStatus() {
    return {
      phase: this._phase,
      settings: this.getSettings(),
      timer: this._timer
        ? {
            remainingMs: this._timer.getRemainingMs(),
            totalMs: this._timer.getTotalDurationMs(),
            progress: this._timer.getProgress(),
            state: this._timer.getState(),
          }
        : null,
    };
  }

  /** Libera recursos (timers, alarmes). Chamar ao desmontar o app, se aplicável. */
  destroy() {
    this._destroyTimer();
    stopAllAlerts();
  }

  // ---------- Internos ----------

  /**
   * Se houver um estudo em andamento (rodando ou pausado) ainda não
   * finalizado, encerra-o agora e salva como sessão parcial — é o que
   * permite o cenário da seção 7/8 do prompt: trocar de configuração no
   * meio do dia sem perder o progresso já estudado naquele tempo.
   */
  async _finalizeStudyIfInProgress() {
    if (this._phase !== Phase.STUDY || !this._timer) return;

    const remaining = this._timer.getRemainingMs();
    const configuredMs = this._timer.getTotalDurationMs();
    const studiedMs = configuredMs - remaining;
    const endTimestamp = Date.now();

    await this._finalizeStudySession({ studiedMs, configuredMs, endTimestamp });
  }

  async _finalizeStudySession({ studiedMs, configuredMs, endTimestamp }) {
    if (studiedMs <= 0) return; // nada efetivamente estudado, não vale registrar

    const record = createSessionRecord({
      startTimestamp: this._studyStartTimestamp ?? endTimestamp - studiedMs,
      endTimestamp,
      configuredMs,
      studiedMs,
      restMs: this._settings.restMs,
    });

    await saveCompletedSession(record);
    this._onSessionSaved(record);
  }

  _handleTick(remaining, total) {
    this._onTick(remaining, total);
    this._tickCounter += 1;
    if (this._tickCounter % SNAPSHOT_PERSIST_EVERY_N_TICKS === 0) {
      this._persistSnapshotNow();
    }
  }

  _restoreTimerFromSnapshot(snapshot) {
    const onFinish = this._phase === Phase.STUDY
      ? () => this._handleStudyFinished()
      : () => this._handleRestFinished();

    this._timer = CountdownTimer.restore(snapshot, {
      onTick: (remaining, total) => this._handleTick(remaining, total),
      onFinish,
    });

    this._onPhaseChange(this._phase);

    // Se o tempo já tiver se esgotado enquanto a aba estava fechada,
    // finaliza imediatamente (regra descrita em timer.js/restore()).
    if (this._timer.isFinished()) {
      if (this._phase === Phase.STUDY) this._handleStudyFinished();
      else this._handleRestFinished();
    }
  }

  _persistSnapshotNow() {
    saveAppState({ phase: this._phase, studyStartTimestamp: this._studyStartTimestamp });
    if (this._timer) {
      saveTimerSnapshot(this._timer.serialize());
    } else {
      saveTimerSnapshot(null);
    }
  }

  _setPhase(phase) {
    this._phase = phase;
    this._onPhaseChange(phase);
    this._persistSnapshotNow();
  }

  _destroyTimer() {
    if (this._timer) {
      this._timer.destroy();
      this._timer = null;
    }
  }

  _requirePhase(expectedPhase) {
    if (this._phase !== expectedPhase || !this._timer) {
      throw new Error(`Ação inválida: esperado estar na fase ${expectedPhase}, mas está em ${this._phase}.`);
    }
  }
}

function _assertPositiveMs(value, name) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} deve ser um número positivo em milissegundos.`);
  }
}
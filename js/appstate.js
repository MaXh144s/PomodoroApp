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
 *   - contabilização do estudo por PERÍODOS DE EXECUÇÃO (ver abaixo);
 *   - alerta sonoro de até 10s, interrompível, em ambas as finalizações
 *     (seções 4 e 6);
 *   - novas configurações não apagam sessões/ciclos anteriores (seções 2 e 8).
 *
 * ---------- Contabilização por períodos de execução ----------
 * Um ciclo de estudo pode ser pausado e retomado quantas vezes for preciso,
 * inclusive em dias diferentes. Cada trecho em que o cronômetro REALMENTE
 * esteve rodando é um período, com dateStart (início ou retomada) e dateEnd
 * (pausa ou fim do ciclo). Regras:
 *   1. Um período abre quando o cronômetro passa a rodar (iniciar/retomar).
 *   2. Fecha quando ele para de rodar (pausar, sair pela seta, reiniciar,
 *      trocar de configuração, ou o ciclo terminar) — e nesse momento, e só
 *      nesse, o tempo dateEnd - dateStart é gravado no histórico, no(s) dia(s)
 *      em que decorreu (o que atravessa a meia-noite é repartido).
 *   3. Enquanto o ciclo está pausado, NADA é contabilizado: virar o dia, ligar
 *      o PC ou abrir o app não geram tempo de estudo. O tempo restante do
 *      ciclo nunca é creditado por antecipação.
 *   4. Como cada período é gravado ao fechar, o que já foi contabilizado nunca
 *      é contabilizado de novo — não existe mais "checkpoint" a reconciliar.
 */

import { CountdownTimer, TimerState, clockNow, clockToRealTime } from './timer.js';
import { saveStudySegment, splitIntervalByLocalDay, getTodayDateKey } from './history.js';
import {
  loadSettings,
  saveSettings,
  loadTimerSnapshot,
  saveTimerSnapshot,
  loadAppState,
  saveAppState,
} from './storage.js';
import { studyFinishedAlert, restFinishedAlert, stopAllAlerts, unlockAudio } from './sound.js';
import { CycleTransitionMode, DEFAULT_CYCLE_TRANSITION_MODE, isValidCycleTransitionMode } from './preferences.js';

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

// Versão do formato do estado persistido (appState). Ausente = formato antigo,
// baseado em "checkpoint" — ver _settleStudyPeriodOnRestore().
const ACCOUNTING_VERSION = 2;

// O snapshot é persistido no máximo uma vez por este intervalo (tempo REAL),
// para não escrever no localStorage a cada tick de 250ms. Baseado em tempo, e
// não em contagem de ticks, porque com a aba em segundo plano o navegador
// espaça os ticks (até ~1 por minuto): contar ticks deixaria o "último
// batimento" salvo defasado em vários minutos, e é ele que define até onde
// um período conta como executado se o app for fechado sem aviso.
const SNAPSHOT_PERSIST_MIN_INTERVAL_MS = 1000;

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
    this._cycleTransitionMode = DEFAULT_CYCLE_TRANSITION_MODE;
    this._phase = Phase.CONFIG;
    this._timer = null;
    this._cycleId = null;   // identifica o ciclo atual; todos os períodos dele no histórico compartilham este id
    this._runPeriod = null; // período de execução em aberto: { startClock } (relógio do cronômetro) — null se o estudo não está rodando
    this._lastPersistAt = 0;
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
      if (snapshot) {
        this._phase = savedAppState.phase;
        this._cycleId = savedAppState.cycleId ?? _newCycleId();
        this._runPeriod = savedAppState.runStartClock != null
          ? { startClock: savedAppState.runStartClock }
          : null;
        await this._restoreTimerFromSnapshot(snapshot, savedAppState);
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
   * sessão/configuração: se houver um período de estudo em execução, ele é
   * fechado e registrado antes de trocar (o que já tinha sido registrado em
   * pausas anteriores permanece). Não apaga nenhuma sessão anterior do
   * histórico.
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

  /**
   * Define o modo de transição entre ciclos ao fim do alarme (ver
   * CycleTransitionMode em preferences.js). Pode ser trocado a qualquer
   * momento, inclusive com um alerta já tocando — só afeta o que acontece
   * quando o alarme atual (ou o próximo) parar sozinho.
   * @param {string} mode
   */
  setCycleTransitionMode(mode) {
    this._cycleTransitionMode = isValidCycleTransitionMode(mode) ? mode : DEFAULT_CYCLE_TRANSITION_MODE;
  }

  // ---------- Estudo ----------

  /** Inicia um novo ciclo de estudo com a configuração atual. */
  startStudy() {
    unlockAudio(); // aproveita este clique do usuário para destravar o áudio para o alerta futuro
    this._cycleId = _newCycleId();
    this._timer = new CountdownTimer({
      durationMs: this._settings.studyMs,
      allowDecrease: false, // regra da seção 3: tempo de estudo nunca diminui
      onTick: (remaining, total) => this._handleTick(remaining, total),
      onFinish: () => this._handleStudyFinished(),
    });
    this._beginRunPeriod();
    this._timer.start();
    this._setPhase(Phase.STUDY);
    this._persistSnapshotNow();
  }

  /**
   * Pausa o estudo. Fecha o período de execução em aberto e registra no
   * histórico exatamente o tempo em que o cronômetro esteve rodando; o ciclo
   * continua inacabado e pausado, e nada mais é contabilizado até retomar.
   * @returns {Promise<void>} resolve quando o período já foi gravado
   */
  pauseStudy() {
    this._requirePhase(Phase.STUDY);
    if (this._timer.getState() !== TimerState.RUNNING) return Promise.resolve();

    const period = this._closeRunPeriod();
    this._timer.pause();
    this._persistSnapshotNow();
    return this._savePeriod(period);
  }

  /** Retoma o estudo pausado, abrindo um NOVO período de execução. */
  resumeStudy() {
    this._requirePhase(Phase.STUDY);
    const state = this._timer.getState();
    if (state !== TimerState.PAUSED && state !== TimerState.IDLE) return;

    this._beginRunPeriod();
    this._timer.resume();
    this._persistSnapshotNow();
  }

  /**
   * Reinicia o ciclo de estudo atual. O tempo já estudado NÃO é perdido: o
   * que já foi registrado em pausas anteriores permanece, e o período em
   * execução (se o cronômetro estava rodando) é fechado e registrado agora.
   * Depois disso o cronômetro volta ao tempo total configurado, parado, como
   * um NOVO ciclo (novo cycleId).
   */
  async resetStudy() {
    this._requirePhase(Phase.STUDY);

    const period = this._closeRunPeriod();
    this._timer.reset();
    this._cycleId = _newCycleId();
    this._persistSnapshotNow();
    await this._savePeriod(period);
  }

  /**
   * Adiciona tempo ao estudo em andamento. Apenas valores positivos são
   * aceitos (regra da seção 3) — o próprio CountdownTimer, criado com
   * allowDecrease:false, já bloquearia negativos, mas validamos aqui
   * também para dar um erro claro em vez de uma falha silenciosa.
   * Não afeta a contabilização: só o tempo de execução real é registrado.
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
    // O período termina no instante em que o ciclo ERA para terminar, e não
    // quando o app percebeu — se o tick de término chegar atrasado (aba em
    // segundo plano, restauração), o intervalo entre os dois não é estudo.
    const scheduledEnd = this._timer.getScheduledEndTimestamp();
    const now = clockNow();
    const period = this._closeRunPeriod(scheduledEnd != null ? Math.min(now, scheduledEnd) : now);
    await this._savePeriod(period);

    this._destroyTimer();
    this._setPhase(Phase.STUDY_ALERT);
    await saveTimerSnapshot(null); // sem cronômetro ativo durante o alerta

    studyFinishedAlert.play(() => this._handleAlertAutoStop(() => this._continueToRest()));
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

    restFinishedAlert.play(() => this._handleAlertAutoStop(() => this._continueToStudy()));
  }

  // ---------- Alertas (seções 4 e 6: interromper ou pular o som) ----------

  /**
   * Chamado quando o alarme (estudo ou descanso) para sozinho ao fim do
   * tempo configurado (AlertPlayer.play/onAutoStop).
   *
   * No modo AUTOMATIC (padrão histórico), avança normalmente para a
   * próxima fase, chamando `continueFn`.
   *
   * No modo MANUAL, o alarme já parou de tocar, mas a fase de alerta
   * permanece aberta — `continueFn` não é chamado. Só avança quando o
   * usuário tocar em "Continuar" (skipAlert()). Isso evita que um novo
   * ciclo de estudo (que conta tempo) comece sozinho enquanto a pessoa não
   * está por perto para retomar.
   * @param {() => void} continueFn
   */
  _handleAlertAutoStop(continueFn) {
    if (this._cycleTransitionMode === CycleTransitionMode.MANUAL) return;
    continueFn();
  }

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

  /**
   * Chamado ao sair pela seta de voltar durante o estudo: se o cronômetro
   * estiver rodando, pausa (fechando e registrando o período em execução).
   * A sessão continua aberta (fase permanece STUDY) para poder ser retomada
   * depois pelo botão "+" — só é encerrada de vez quando o usuário escolhe
   * "Nova sessão" (finalizeStudyAndReturnToConfig()), reinicia o ciclo
   * (resetStudy()) ou o estudo termina normalmente.
   * Não faz nada se a fase atual não for STUDY.
   */
  async pauseStudyIfRunning() {
    if (this._phase !== Phase.STUDY || !this._timer) return;

    if (this._timer.getState() === TimerState.RUNNING) {
      await this.pauseStudy();
    } else {
      this._persistSnapshotNow();
    }
  }

  /**
   * Finaliza o estudo em andamento (se houver), registrando o período que
   * estiver aberto, e volta a fase para CONFIG — sem alterar as configurações
   * salvas (diferente de configure(), não recebe nova duração).
   *
   * Usado quando o usuário, ao ver o modal de "sessão inacabada" (disparado
   * pelo botão "+"), escolhe começar uma nova sessão em vez de continuar a
   * anterior. O tempo do ciclo abandonado já está todo no histórico (cada
   * período foi gravado ao fechar); nada é somado por causa do abandono.
   *
   * Não faz nada se a fase atual não for STUDY — descanso não é finalizado
   * por aqui, continua rodando em segundo plano normalmente.
   */
  async finalizeStudyAndReturnToConfig() {
    if (this._phase !== Phase.STUDY) return;

    await this._finalizeStudyIfInProgress();
    this._destroyTimer();
    stopAllAlerts();

    this._setPhase(Phase.CONFIG);
    await saveTimerSnapshot(null);
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

  /**
   * Tempo de estudo do período em execução que ainda NÃO está no histórico
   * (só a parte que cai em hoje, caso o período tenha atravessado a
   * meia-noite). É 0 com o ciclo pausado. A UI soma isto ao total de hoje já
   * gravado para mostrar "Estudado hoje" ao vivo, sem contar duas vezes o que
   * pausas anteriores já registraram.
   * @returns {number} ms
   */
  getOpenRunPeriodTodayMs() {
    if (!this._runPeriod) return 0;

    const endClock = clockNow();
    const durationMs = endClock - this._runPeriod.startClock;
    if (!(durationMs > 0)) return 0;

    const dateEnd = clockToRealTime(endClock);
    const todayKey = getTodayDateKey();
    return splitIntervalByLocalDay(dateEnd - durationMs, dateEnd)
      .filter((chunk) => chunk.dateKey === todayKey)
      .reduce((total, chunk) => total + chunk.ms, 0);
  }

  /**
   * Força a persistência imediata do snapshot atual (fase + cronômetro),
   * sem esperar o intervalo normal de persistência. Usado ao detectar que a
   * aba está sendo escondida/fechada. Não fecha o período em execução: o
   * cronômetro continua rodando em segundo plano, e o snapshot serve de
   * "último batimento" caso o app seja encerrado sem aviso.
   * Não faz nada se não houver fase de estudo/descanso ativa.
   */
  persistNow() {
    if (this._phase !== Phase.STUDY && this._phase !== Phase.REST) return;
    this._persistSnapshotNow();
  }

  /**
   * Força uma checagem imediata do cronômetro ativo (ver comentário em
   * timer.js/forceCheck()). Chamar ao a aba voltar a ficar visível: garante
   * que o alarme dispare sem atraso perceptível mesmo se os timers tiverem
   * sofrido throttling (ou sido suspensos) enquanto a aba estava escondida.
   * Não faz nada se não houver cronômetro ativo (fases de alerta, config etc.).
   */
  checkTimerNow() {
    if (this._timer) this._timer.forceCheck();
  }

  /** Libera recursos (timers, alarmes). Chamar ao desmontar o app, se aplicável. */
  destroy() {
    this._destroyTimer();
    stopAllAlerts();
  }

  // ---------- Períodos de execução ----------

  /** Abre um período de execução: o cronômetro de estudo está prestes a rodar. */
  _beginRunPeriod() {
    this._runPeriod = { startClock: clockNow() };
  }

  /**
   * Fecha o período de execução em aberto (se houver) e devolve o que deve ser
   * gravado no histórico — sem gravar. Síncrono de propósito: quem chama
   * captura o período no mesmo instante em que o cronômetro para, e só depois
   * espera a gravação (_savePeriod).
   * @param {number} [endClock] - fim do período no relógio do cronômetro (padrão: agora)
   * @returns {{dateStart: number, dateEnd: number, configuredMs: number, restMs: number, cycleId: string} | null}
   */
  _closeRunPeriod(endClock = clockNow()) {
    const period = this._runPeriod;
    this._runPeriod = null;
    if (!period || !this._timer) return null;

    const durationMs = endClock - period.startClock;
    if (!(durationMs > 0)) return null;

    const dateEnd = clockToRealTime(endClock);
    return {
      dateStart: dateEnd - durationMs,
      dateEnd,
      configuredMs: this._timer.getTotalDurationMs(),
      restMs: this._settings.restMs,
      cycleId: this._cycleId,
    };
  }

  /**
   * Grava um período já fechado. saveStudySegment reparte por dia local: se
   * o período atravessou a meia-noite, salva um registro por dia, cada um só
   * com o tempo que realmente decorreu naquele dia (ver history.js).
   */
  async _savePeriod(period) {
    if (!period) return;
    const records = await saveStudySegment(period);
    records.forEach((record) => this._onSessionSaved(record));
  }

  /**
   * Se houver um período de estudo em execução, fecha-o agora e grava — é o
   * que permite trocar de configuração no meio do dia sem perder o que o
   * cronômetro estava contando. Se o ciclo estiver pausado não há nada a
   * gravar: o que foi estudado já foi registrado quando ele pausou.
   */
  async _finalizeStudyIfInProgress() {
    if (this._phase !== Phase.STUDY || !this._timer) return;
    await this._savePeriod(this._closeRunPeriod());
  }

  // ---------- Internos ----------

  _handleTick(remaining, total) {
    this._onTick(remaining, total);
    if (Date.now() - this._lastPersistAt >= SNAPSHOT_PERSIST_MIN_INTERVAL_MS) {
      this._persistSnapshotNow();
    }
  }

  /**
   * Restaura o cronômetro a partir do snapshot salvo.
   *
   * ESTUDO: o tempo em que o app ficou fechado (PC desligado, aba fechada,
   * virada de dia) NÃO conta como execução. O cronômetro é restaurado como
   * estava no último batimento salvo (snapshot.savedClockAt), e, se um período
   * estava aberto, ele é fechado e gravado nesse instante. O ciclo volta
   * pausado, inclusive se foi deixado de um dia para o outro — pode ser
   * retomado normalmente; só o que rodar a partir da retomada será contado.
   *
   * DESCANSO: não entra na contabilização de estudo; mantém o comportamento
   * antigo (continua contando pelo relógio enquanto o app esteve fechado).
   */
  async _restoreTimerFromSnapshot(snapshot, savedAppState) {
    const isStudy = this._phase === Phase.STUDY;
    const heartbeatClock = snapshot.savedClockAt ?? snapshot.savedAt ?? clockNow();

    const onFinish = isStudy
      ? () => this._handleStudyFinished()
      : () => this._handleRestFinished();

    this._timer = CountdownTimer.restore(
      snapshot,
      {
        onTick: (remaining, total) => this._handleTick(remaining, total),
        onFinish,
      },
      isStudy ? { asOfMs: heartbeatClock } : {}
    );

    if (isStudy) {
      await this._settleStudyPeriodOnRestore(snapshot, savedAppState, heartbeatClock);
    }

    this._onPhaseChange(this._phase);
    this._persistSnapshotNow(); // regrava já no formato atual

    // Se o tempo já tiver se esgotado (no último batimento, para o estudo),
    // finaliza imediatamente (regra descrita em timer.js/restore()).
    if (this._timer.isFinished()) {
      if (isStudy) await this._handleStudyFinished();
      else this._handleRestFinished();
    }
  }

  /**
   * Fecha, ao restaurar, o período de estudo que ficou em aberto no snapshot.
   *
   * Formato atual: o período é fechado no último batimento (o app não estava
   * mais rodando depois disso). Se o cronômetro já tinha chegado ao fim nesse
   * ponto, o período é deixado aberto para _handleStudyFinished() fechá-lo no
   * término previsto.
   *
   * Formato antigo (sem accountingVersion): o estado não tinha períodos, só um
   * "checkpoint" do quanto do ciclo já havia sido gravado. Para não perder o
   * que ficou sem registro no momento da atualização — inclusive um ciclo
   * pausado à noite, que o código antigo nunca gravava ao pausar —, grava-se
   * uma única vez a diferença (tempo decorrido do ciclo - checkpoint),
   * terminando no instante em que o snapshot foi salvo, ou seja, no dia em
   * que o estudo de fato aconteceu.
   */
  async _settleStudyPeriodOnRestore(snapshot, savedAppState, heartbeatClock) {
    const isCurrentFormat = savedAppState.accountingVersion === ACCOUNTING_VERSION;

    if (isCurrentFormat) {
      if (this._runPeriod && !this._timer.isFinished()) {
        await this._savePeriod(this._closeRunPeriod(heartbeatClock));
      }
      return;
    }

    // ----- formato antigo -----
    this._runPeriod = null;

    const remainingMs = snapshot.state === TimerState.RUNNING
      ? CountdownTimer.computeRemainingMsFromSnapshot(snapshot, heartbeatClock)
      : snapshot.remainingAtPause;
    const elapsedMs = snapshot.totalDuration - remainingMs;
    const unrecordedMs = elapsedMs - (savedAppState.studyCheckpointMs ?? 0);
    if (!(unrecordedMs > 0)) return;

    const dateEnd = snapshot.savedAt ?? Date.now();
    await this._savePeriod({
      dateStart: dateEnd - unrecordedMs,
      dateEnd,
      configuredMs: snapshot.totalDuration,
      restMs: this._settings.restMs,
      cycleId: this._cycleId,
    });
  }

  _persistSnapshotNow() {
    this._lastPersistAt = Date.now();
    saveAppState({
      accountingVersion: ACCOUNTING_VERSION,
      phase: this._phase,
      cycleId: this._cycleId,
      runStartClock: this._runPeriod ? this._runPeriod.startClock : null,
    });
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

function _newCycleId() {
  return `cycle-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
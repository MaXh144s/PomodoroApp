/**
 * timer.js
 * Núcleo do cronômetro baseado em timestamps (Date.now()),
 * resistente a troca de aba e a throttling de setInterval do navegador.
 *
 * Não depende de contagem regressiva por decremento: a cada tick,
 * recalcula o tempo restante comparando o timestamp atual com o
 * timestamp de término previsto (endTimestamp). Isso garante que,
 * mesmo que o navegador pause os timers em segundo plano, ao voltar
 * para a aba o tempo restante é recalculado corretamente.
 *
 * Este módulo NÃO conhece regras de "estudo" ou "descanso" — apenas
 * um contador regressivo genérico. As regras de negócio (ex: estudo
 * não pode diminuir) ficam a cargo de quem usa este módulo.
 */

export const TimerState = Object.freeze({
  IDLE: 'IDLE',
  RUNNING: 'RUNNING',
  PAUSED: 'PAUSED',
  FINISHED: 'FINISHED',
});

/**
 * "Agora" usado pelo cronômetro para toda a matemática de tempo restante.
 * Em uso normal é idêntico a Date.now(). Se o script opcional de debug
 * (js/debug.js — não versionado, cada dev adiciona no próprio .gitignore)
 * tiver sido carregado, ele expõe window.__pomodoroTimeScale com um
 * relógio acelerado (2x a 100x), permitindo testar ciclos inteiros em
 * segundos em vez de esperar o tempo real. Sem esse script, o
 * comportamento é exatamente o mesmo de sempre — nenhuma dependência é
 * criada aqui, só uma checagem de um global opcional.
 */
function _now() {
  const debugClock = typeof window !== 'undefined' ? window.__pomodoroTimeScale : null;
  return debugClock ? debugClock.now() : Date.now();
}

/**
 * Converte uma duração restante (no relógio de _now(), que pode estar
 * acelerado pelo painel de debug opcional) no delay real de setTimeout
 * correspondente. Sem isso, o timeout dedicado de término (ver
 * _scheduleFinishTimeout) demoraria tempo real demais para disparar
 * sempre que a aceleração de debug estivesse ativa.
 */
function _realDelayFor(remainingMs) {
  const debugClock = typeof window !== 'undefined' ? window.__pomodoroTimeScale : null;
  if (!debugClock || typeof debugClock.getScale !== 'function') return remainingMs;
  const scale = debugClock.getScale() || 1;
  return remainingMs / scale;
}

/**
 * Relógio usado pelo cronômetro (igual a Date.now() em uso normal; acelerado
 * quando o painel de debug está ativo). Exportado para que quem contabiliza
 * períodos de execução (appstate.js) meça o tempo na MESMA base que o
 * cronômetro usa, senão o tempo registrado divergiria do tempo do timer
 * quando o debug estiver acelerando o relógio.
 */
export function clockNow() {
  return _now();
}

/**
 * Converte um instante do relógio do cronômetro (valor de clockNow()) no
 * instante real (Date.now()) correspondente — necessário para gravar datas
 * de verdade no histórico. Sem o painel de debug os dois relógios são o
 * mesmo e o valor volta idêntico (sem nenhum erro de arredondamento); com
 * ele, desfaz a aceleração para cair na data real em que aquilo aconteceu.
 */
export function clockToRealTime(clockMs) {
  const debugClock = typeof window !== 'undefined' ? window.__pomodoroTimeScale : null;
  if (!debugClock) return clockMs;
  const scale = typeof debugClock.getScale === 'function' ? (debugClock.getScale() || 1) : 1;
  return Date.now() - (debugClock.now() - clockMs) / scale;
}

export class CountdownTimer {
  /**
   * @param {Object} options
   * @param {number} options.durationMs - duração inicial em ms
   * @param {boolean} [options.allowDecrease=true] - se falso, addTime() com valor negativo é ignorado (uso: cronômetro de estudo)
   * @param {number} [options.tickIntervalMs=250] - intervalo de verificação (não decrementa, apenas "acorda" e recalcula)
   * @param {(remainingMs:number, totalMs:number) => void} [options.onTick]
   * @param {() => void} [options.onFinish]
   */
  constructor({
    durationMs,
    allowDecrease = true,
    tickIntervalMs = 250,
    onTick = () => {},
    onFinish = () => {},
  }) {
    if (!Number.isFinite(durationMs) || durationMs <= 0) {
      throw new Error('durationMs deve ser um número positivo em milissegundos.');
    }

    this._totalDuration = durationMs;
    this._allowDecrease = allowDecrease;
    this._tickIntervalMs = tickIntervalMs;
    this._onTick = onTick;
    this._onFinish = onFinish;

    this._state = TimerState.IDLE;
    this._endTimestamp = null;            // definido quando RUNNING
    this._remainingAtPause = durationMs;  // válido quando IDLE/PAUSED

    this._intervalId = null;
    this._finishTimeoutId = null; // timeout único agendado exatamente para o instante de término (ver _scheduleFinishTimeout)
    this._finished = false;
    this._scheduledEndTimestamp = null; // instante (relógio de _now()) em que o ciclo ERA para terminar; preenchido ao finalizar
  }

  // ---------- Ações públicas ----------

  start() {
    if (this._state === TimerState.RUNNING) return;
    this._finished = false;
    this._endTimestamp = _now() + this._remainingAtPause;
    this._state = TimerState.RUNNING;
    this._scheduleTicks();
    this._tick();
  }

  pause() {
    if (this._state !== TimerState.RUNNING) return;
    this._remainingAtPause = this._computeRemaining();
    this._clearTicks();
    this._state = TimerState.PAUSED;
  }

  resume() {
    // IDLE acontece logo após reset(): o cronômetro está parado com o tempo
    // total pronto para rodar, funcionalmente equivalente a estar pausado.
    // Sem isso, "Continuar" depois de "Reiniciar" não tinha efeito nenhum.
    if (this._state !== TimerState.PAUSED && this._state !== TimerState.IDLE) return;
    this.start();
  }

  /** Reinicia o ciclo atual, voltando ao tempo total configurado (mantém a duração). */
  reset() {
    this._clearTicks();
    this._finished = false;
    this._remainingAtPause = this._totalDuration;
    this._endTimestamp = null;
    this._state = TimerState.IDLE;
    this._emitTick();
  }

  /**
   * Reconfigura a duração total (ex: nova sessão), reiniciando do zero.
   * @param {number} newDurationMs
   */
  setDuration(newDurationMs) {
    if (!Number.isFinite(newDurationMs) || newDurationMs <= 0) {
      throw new Error('newDurationMs deve ser um número positivo em milissegundos.');
    }
    this._clearTicks();
    this._finished = false;
    this._totalDuration = newDurationMs;
    this._remainingAtPause = newDurationMs;
    this._endTimestamp = null;
    this._state = TimerState.IDLE;
    this._emitTick();
  }

  /**
   * Adiciona (ou remove, se permitido) tempo ao ciclo atual.
   * @param {number} deltaMs - positivo para adicionar, negativo para remover
   * @returns {boolean} false se a operação foi bloqueada (ex: diminuir tempo de estudo)
   */
  addTime(deltaMs) {
    if (deltaMs < 0 && !this._allowDecrease) {
      return false;
    }

    this._totalDuration = Math.max(0, this._totalDuration + deltaMs);

    if (this._state === TimerState.RUNNING) {
      const remaining = Math.max(0, this._computeRemaining() + deltaMs);
      this._endTimestamp = _now() + remaining;
      if (remaining <= 0) {
        this._forceFinish();
        this._emitTick();
        return true;
      }
      this._scheduleFinishTimeout();
    } else {
      this._remainingAtPause = Math.max(0, this._remainingAtPause + deltaMs);
      if (this._remainingAtPause <= 0 && deltaMs < 0) {
        this._forceFinish();
        this._emitTick();
        return true;
      }
    }

    this._emitTick();
    return true;
  }

  /** Para o timer e limpa intervalos (chamar ao desmontar/destruir a instância). */
  destroy() {
    this._clearTicks();
  }

  /**
   * Força uma checagem imediata do tempo restante, sem esperar o próximo
   * tick agendado (polling ou timeout dedicado). Usado ao a aba voltar a
   * ficar visível: cobre o caso extremo em que o navegador chegou a
   * suspender o JS por completo em segundo plano (nem o polling nem o
   * timeout dedicado rodaram) — como o cálculo é sempre por timestamp,
   * não importa quanto tempo passou, o alarme dispara na hora certa assim
   * que o app volta a rodar. Não faz nada se o cronômetro não estiver rodando.
   */
  forceCheck() {
    if (this._state === TimerState.RUNNING) this._tick();
  }

  // ---------- Consultas ----------

  getRemainingMs() {
    if (this._state === TimerState.RUNNING) return this._computeRemaining();
    return this._remainingAtPause;
  }

  getTotalDurationMs() {
    return this._totalDuration;
  }

  getState() {
    return this._state;
  }

  /**
   * Instante previsto de término do ciclo que acabou de finalizar (no relógio
   * de _now()), ou null se o cronômetro não terminou rodando. Quem contabiliza
   * o estudo usa isto como fim do período de execução: se o tick de término
   * chegar atrasado (aba em segundo plano, máquina suspensa), o tempo entre o
   * término previsto e o momento em que o app percebeu NÃO é estudo.
   */
  getScheduledEndTimestamp() {
    return this._scheduledEndTimestamp;
  }

  /** Progresso de 0 a 1 (0 = início, 1 = concluído). */
  getProgress() {
    const remaining = this.getRemainingMs();
    if (this._totalDuration <= 0) return 1;
    return 1 - remaining / this._totalDuration;
  }

  isFinished() {
    return this._finished;
  }

  /**
   * Serializa o estado essencial para persistência (localStorage),
   * permitindo restaurar corretamente após reload — mesmo que a aba
   * tenha ficado fechada por minutos.
   */
  serialize() {
    return {
      state: this._state,
      totalDuration: this._totalDuration,
      remainingAtPause: this._remainingAtPause,
      endTimestamp: this._endTimestamp,
      allowDecrease: this._allowDecrease,
      savedAt: Date.now(),
      // Mesmo instante, mas no relógio do cronômetro (_now()). É o "último
      // momento em que o app estava vivo e rodando": ao restaurar um
      // snapshot RUNNING, o tempo depois disto (app fechado, PC desligado)
      // não conta como execução. Ver restore().
      savedClockAt: _now(),
    };
  }

  /**
   * Calcula quanto tempo realmente resta com base num snapshot salvo,
   * comparando o endTimestamp previsto com o momento atual. Sem isso,
   * restore() de um snapshot RUNNING (o caso normal — o snapshot é salvo
   * enquanto o cronômetro roda) lançava erro, quebrando a restauração
   * inteira após um F5/reload e fazendo parecer que o ciclo foi perdido.
   */
  static computeRemainingMsFromSnapshot(snapshot, atMs = _now()) {
    if (snapshot.endTimestamp == null) return snapshot.remainingAtPause;
    return Math.max(0, snapshot.endTimestamp - atMs);
  }

  /**
   * Restaura um timer a partir de um snapshot salvo, recalculando quanto
   * tempo passou desde então. Se o tempo já tiver se esgotado enquanto a
   * aba estava fechada, marca isFinished() = true — quem chamar deve
   * verificar isso e tratar a finalização manualmente (contabilizar
   * ciclo, disparar som, etc.), pois isso é regra de negócio externa.
   *
   * @param {Object} snapshot
   * @param {Object} [callbacks]
   * @param {Object} [options]
   * @param {number} [options.asOfMs] - calcula o tempo restante como estava neste
   *   instante (no relógio de _now()) em vez de "agora". Usado para NÃO contar
   *   como execução o tempo em que o app ficou fechado: passa-se o último
   *   batimento salvo (snapshot.savedClockAt). Padrão: agora (comportamento antigo).
   */
  static restore(snapshot, callbacks = {}, { asOfMs = _now() } = {}) {
    const timer = new CountdownTimer({
      durationMs: snapshot.totalDuration,
      allowDecrease: snapshot.allowDecrease,
      onTick: callbacks.onTick,
      onFinish: callbacks.onFinish,
    });

    if (snapshot.state === TimerState.RUNNING) {
      const remainingNow = CountdownTimer.computeRemainingMsFromSnapshot(snapshot, asOfMs);

      if (remainingNow <= 0) {
        timer._totalDuration = snapshot.totalDuration;
        timer._remainingAtPause = 0;
        timer._state = TimerState.IDLE;
        timer._finished = true;
        timer._scheduledEndTimestamp = snapshot.endTimestamp ?? null;
      } else {
        timer._remainingAtPause = remainingNow;
        timer._state = TimerState.PAUSED; // volta pausado; quem usa decide se retoma automaticamente
      }
    } else {
      timer._state = snapshot.state;
      timer._remainingAtPause = snapshot.remainingAtPause;
    }

    return timer;
  }

  // ---------- Internos ----------

  _computeRemaining() {
    if (this._endTimestamp == null) return this._remainingAtPause;
    return Math.max(0, this._endTimestamp - _now());
  }

  _scheduleTicks() {
    this._clearTicks();
    this._intervalId = setInterval(() => this._tick(), this._tickIntervalMs);
    this._scheduleFinishTimeout();
  }

  _clearTicks() {
    if (this._intervalId != null) {
      clearInterval(this._intervalId);
      this._intervalId = null;
    }
    this._clearFinishTimeout();
  }

  /**
   * Agenda um setTimeout único, para o instante exato em que o cronômetro
   * termina — em paralelo ao polling de _scheduleTicks() (usado só para
   * atualizar a UI a cada 250ms). Existe porque, com a aba em segundo
   * plano, navegadores throttlam MUITO mais agressivamente um intervalo
   * repetido de disparo curto do que um timeout avulso: o polling sozinho
   * podia deixar o app minutos sem perceber que o tempo acabou (e, com
   * isso, sem tocar o alarme) até a aba voltar ao primeiro plano. Um
   * timeout dedicado, agendado direto para a hora certa, tende a dessa
   * forma disparar bem mais perto do previsto mesmo em segundo plano.
   */
  _scheduleFinishTimeout() {
    this._clearFinishTimeout();
    if (this._state !== TimerState.RUNNING) return;
    const remaining = this._computeRemaining();
    this._finishTimeoutId = setTimeout(() => this._tick(), Math.max(0, _realDelayFor(remaining)));
  }

  _clearFinishTimeout() {
    if (this._finishTimeoutId != null) {
      clearTimeout(this._finishTimeoutId);
      this._finishTimeoutId = null;
    }
  }

  _tick() {
    if (this._state !== TimerState.RUNNING) return;
    const remaining = this._computeRemaining();
    this._emitTick(remaining);
    if (remaining <= 0) {
      this._forceFinish();
    }
  }

  _emitTick(remaining = this.getRemainingMs()) {
    this._onTick(remaining, this._totalDuration);
  }

  _forceFinish() {
    this._clearTicks();
    this._scheduledEndTimestamp = this._endTimestamp;
    this._remainingAtPause = 0;
    this._endTimestamp = null;
    this._state = TimerState.FINISHED;
    this._finished = true;
    this._onTick(0, this._totalDuration);
    this._onFinish();
  }
}
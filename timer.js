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
    this._finished = false;
  }

  // ---------- Ações públicas ----------

  start() {
    if (this._state === TimerState.RUNNING) return;
    this._finished = false;
    this._endTimestamp = Date.now() + this._remainingAtPause;
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
    if (this._state !== TimerState.PAUSED) return;
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
      this._endTimestamp = Date.now() + remaining;
      if (remaining <= 0) {
        this._forceFinish();
        this._emitTick();
        return true;
      }
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
    };
  }

  /**
   * Restaura um timer a partir de um snapshot salvo, recalculando quanto
   * tempo passou desde então. Se o tempo já tiver se esgotado enquanto a
   * aba estava fechada, marca isFinished() = true — quem chamar deve
   * verificar isso e tratar a finalização manualmente (contabilizar
   * ciclo, disparar som, etc.), pois isso é regra de negócio externa.
   */
  static restore(snapshot, callbacks = {}) {
    const timer = new CountdownTimer({
      durationMs: snapshot.totalDuration,
      allowDecrease: snapshot.allowDecrease,
      onTick: callbacks.onTick,
      onFinish: callbacks.onFinish,
    });

    if (snapshot.state === TimerState.RUNNING) {
      const remainingNow = CountdownTimer.computeRemainingMsFromSnapshot(snapshot);

      if (remainingNow <= 0) {
        timer._totalDuration = snapshot.totalDuration;
        timer._remainingAtPause = 0;
        timer._state = TimerState.IDLE;
        timer._finished = true;
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
    return Math.max(0, this._endTimestamp - Date.now());
  }

  _scheduleTicks() {
    this._clearTicks();
    this._intervalId = setInterval(() => this._tick(), this._tickIntervalMs);
  }

  _clearTicks() {
    if (this._intervalId != null) {
      clearInterval(this._intervalId);
      this._intervalId = null;
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
    this._remainingAtPause = 0;
    this._endTimestamp = null;
    this._state = TimerState.FINISHED;
    this._finished = true;
    this._onTick(0, this._totalDuration);
    this._onFinish();
  }
}
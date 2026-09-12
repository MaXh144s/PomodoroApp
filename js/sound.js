/**
 * sound.js
 * Alertas sonoros de fim de ciclo (estudo ou descanso).
 *
 * Usa a Web Audio API (não um <audio> com arquivo externo) para gerar o
 * beep, evitando depender de assets externos. Toca em pulsos por até
 * ~10 segundos, pode ser interrompido a qualquer momento pelo usuário,
 * e continua tocando mesmo se a aba perder o foco — dentro do que os
 * navegadores permitem (a maioria não pausa Web Audio em background,
 * diferente de setInterval/setTimeout, que podem sofrer throttling).
 *
 * Limitação conhecida do navegador: por política de autoplay, o
 * AudioContext só pode ser criado/retomado após uma interação do
 * usuário (clique, toque etc.). Por isso este módulo expõe unlockAudio(),
 * que deve ser chamada uma vez em qualquer clique inicial do usuário
 * (ex: o botão "+" ou "Iniciar"), garantindo que o beep funcione depois
 * mesmo se disparado por um timer sem interação direta no momento exato.
 */

let _sharedContext = null;

/**
 * Garante que existe um AudioContext ativo, criando-o (ou retomando-o,
 * se estiver suspenso) na primeira interação do usuário.
 * Chamar isso dentro de um handler de clique/toque, o mais cedo possível.
 * @returns {AudioContext|null} null se o navegador não suportar Web Audio
 */
export function unlockAudio() {
  if (typeof window === 'undefined') return null;

  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) {
    console.warn('[sound] Web Audio API não suportada neste navegador.');
    return null;
  }

  if (!_sharedContext) {
    _sharedContext = new AudioContextClass();
  }
  if (_sharedContext.state === 'suspended') {
    _sharedContext.resume().catch((err) => console.warn('[sound] Falha ao retomar AudioContext:', err));
  }
  return _sharedContext;
}

/**
 * Player de alerta sonoro: toca pulsos de beep por até `maxDurationMs`,
 * podendo ser interrompido em qualquer momento com stop().
 */
export class AlertPlayer {
  /**
   * @param {Object} [options]
   * @param {number} [options.frequency=880] - tom do beep em Hz
   * @param {number} [options.beepDurationMs=200] - duração de cada beep individual
   * @param {number} [options.intervalMs=700] - intervalo entre o início de cada beep
   * @param {number} [options.maxDurationMs=10000] - tempo máximo total do alerta (10s por padrão)
   * @param {number} [options.volume=0.3] - volume de 0 a 1
   */
  constructor({
    frequency = 880,
    beepDurationMs = 200,
    intervalMs = 700,
    maxDurationMs = 10000,
    volume = 0.3,
  } = {}) {
    this._frequency = frequency;
    this._beepDurationMs = beepDurationMs;
    this._intervalMs = intervalMs;
    this._maxDurationMs = maxDurationMs;
    this._volume = volume;

    this._playing = false;
    this._intervalId = null;
    this._stopTimeoutId = null;
    this._activeNodes = []; // osciladores/ganhos ativos, para poder cortar na hora do stop()
  }

  /**
   * Inicia o alerta. Se já estiver tocando, não faz nada (evita sobrepor
   * dois alarmes ao mesmo tempo).
   * @param {() => void} [onAutoStop] - chamado quando o alerta termina
   *        naturalmente após maxDurationMs (não quando o usuário interrompe manualmente)
   */
  play(onAutoStop = () => {}) {
    if (this._playing) return;

    const ctx = unlockAudio();
    if (!ctx) return; // navegador sem suporte: falha silenciosamente, não quebra o app

    this._playing = true;
    this._emitBeep(ctx);
    this._intervalId = setInterval(() => this._emitBeep(ctx), this._intervalMs);

    this._stopTimeoutId = setTimeout(() => {
      this.stop();
      onAutoStop();
    }, this._maxDurationMs);
  }

  /**
   * Interrompe o alerta imediatamente (chamado quando o usuário decide
   * parar o som ou pular direto para o próximo ciclo).
   */
  stop() {
    if (!this._playing) return;

    clearInterval(this._intervalId);
    clearTimeout(this._stopTimeoutId);
    this._intervalId = null;
    this._stopTimeoutId = null;

    // Corta imediatamente qualquer nó de áudio ainda em execução.
    for (const node of this._activeNodes) {
      try {
        node.oscillator.stop();
      } catch {
        // Já pode ter parado naturalmente; ignorar.
      }
    }
    this._activeNodes = [];
    this._playing = false;
  }

  isPlaying() {
    return this._playing;
  }

  // ---------- Internos ----------

  _emitBeep(ctx) {
    const oscillator = ctx.createOscillator();
    const gainNode = ctx.createGain();

    oscillator.type = 'sine';
    oscillator.frequency.value = this._frequency;
    gainNode.gain.value = this._volume;

    oscillator.connect(gainNode);
    gainNode.connect(ctx.destination);

    const now = ctx.currentTime;
    const durationSec = this._beepDurationMs / 1000;

    // Fade-out suave no final do beep, para evitar "clique" audível.
    gainNode.gain.setValueAtTime(this._volume, now);
    gainNode.gain.exponentialRampToValueAtTime(0.001, now + durationSec);

    oscillator.start(now);
    oscillator.stop(now + durationSec);

    const nodeRef = { oscillator, gainNode };
    this._activeNodes.push(nodeRef);

    oscillator.onended = () => {
      this._activeNodes = this._activeNodes.filter((n) => n !== nodeRef);
    };
  }
}

// ---------- Instâncias prontas para uso, com tons diferentes para cada evento ----------

/** Alerta de "estudo concluído" — tom mais agudo. */
export const studyFinishedAlert = new AlertPlayer({ frequency: 880 });

/** Alerta de "descanso concluído" — tom levemente mais grave, para diferenciar ao ouvido. */
export const restFinishedAlert = new AlertPlayer({ frequency: 660 });

/**
 * Para qualquer alerta que esteja tocando (estudo ou descanso).
 * Útil para garantir que nunca fiquem dois alarmes simultâneos.
 */
export function stopAllAlerts() {
  studyFinishedAlert.stop();
  restFinishedAlert.stop();
}
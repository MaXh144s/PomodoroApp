/**
 * sound.js
 * Alertas sonoros de fim de ciclo (estudo ou descanso).
 *
 * Por padrão usa a Web Audio API (não um <audio> com arquivo externo) para
 * gerar o beep, evitando depender de assets externos. Toca em pulsos por até
 * ~10 segundos, pode ser interrompido a qualquer momento pelo usuário,
 * e continua tocando mesmo se a aba perder o foco — dentro do que os
 * navegadores permitem (a maioria não pausa Web Audio em background,
 * diferente de setInterval/setTimeout, que podem sofrer throttling).
 *
 * Opcionalmente, o usuário pode escolher um arquivo de áudio (ex: .mp3) nas
 * Preferências para usar como toque no lugar do beep gerado — ver
 * setAlertCustomSound(). Nesse caso o alerta toca esse arquivo em loop pelo
 * mesmo tempo máximo (maxDurationMs), em vez de gerar pulsos sintéticos.
 *
 * Limitação conhecida do navegador: por política de autoplay, o
 * AudioContext só pode ser criado/retomado após uma interação do
 * usuário (clique, toque etc.). Por isso este módulo expõe unlockAudio(),
 * que deve ser chamada uma vez em qualquer clique inicial do usuário
 * (ex: o botão "+" ou "Iniciar"), garantindo que o beep funcione depois
 * mesmo se disparado por um timer sem interação direta no momento exato.
 * Áudios customizados tocados via <audio> seguem a mesma regra, mas
 * qualquer clique anterior na página já costuma ser suficiente para liberá-los.
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

    this._customAudioSrc = null; // dataURL do áudio customizado, se o usuário escolheu um
    this._customAudioEl = null;  // elemento <audio> em execução, quando customAudioSrc está ativo
    this._customAudioTrimStartSec = 0; // a partir de qual segundo do arquivo o trecho escolhido começa
    this._customAudioTimeUpdateHandler = null; // referência para poder remover o listener no stop()
  }

  /**
   * Define (ou remove, passando null) um áudio customizado para este alerta.
   * Quando definido, play() toca o trecho de `trimStartSeconds` até
   * `trimStartSeconds + maxDurationMs` desse arquivo (repetindo esse
   * trecho, se necessário, até completar maxDurationMs) em vez de gerar o
   * beep sintético. Isso permite ao usuário escolher qual parte de um
   * áudio mais longo que o alarme deve tocar (semelhante ao recorte de
   * música do Instagram), em vez de sempre começar do início do arquivo.
   * @param {string|null} dataUrlOrNull
   * @param {number} [trimStartSeconds=0] - segundo do arquivo em que o trecho escolhido começa
   */
  setCustomSource(dataUrlOrNull, trimStartSeconds = 0) {
    this._customAudioSrc = dataUrlOrNull;
    this._customAudioTrimStartSec = Math.max(0, trimStartSeconds || 0);
  }

  /**
   * Define o tempo máximo (em ms) que o alerta toca antes de parar sozinho.
   * Vale tanto para o beep sintético quanto para um áudio customizado.
   * @param {number} ms
   */
  setMaxDuration(ms) {
    this._maxDurationMs = ms;
  }

  /**
   * Inicia o alerta. Se já estiver tocando, não faz nada (evita sobrepor
   * dois alarmes ao mesmo tempo).
   * @param {() => void} [onAutoStop] - chamado quando o alerta termina
   *        naturalmente após maxDurationMs (não quando o usuário interrompe manualmente)
   */
  play(onAutoStop = () => {}) {
    if (this._playing) return;

    if (this._customAudioSrc) {
      this._playCustom(onAutoStop);
      return;
    }

    this._playBeep(onAutoStop);
  }

  /**
   * Toca o trecho escolhido do áudio customizado (a partir de
   * _customAudioTrimStartSec), repetindo esse trecho se ele for mais curto
   * que maxDurationMs, por até maxDurationMs no total.
   */
  _playCustom(onAutoStop) {
    const audio = new Audio(this._customAudioSrc);
    audio.loop = false; // o loop é controlado manualmente para respeitar o trecho escolhido (trimStart), não sempre voltar ao início do arquivo
    audio.volume = 0.8; // toques customizados costumam precisar de mais volume que o beep sintético

    const trimStartSec = this._customAudioTrimStartSec;

    const onTimeUpdate = () => {
      // Ao chegar perto do fim do arquivo, volta para o início do trecho
      // escolhido em vez de para o início do arquivo (0s) — é o que faz o
      // trecho selecionado repetir em vez do arquivo inteiro.
      if (Number.isFinite(audio.duration) && audio.currentTime >= audio.duration - 0.05) {
        audio.currentTime = trimStartSec;
      }
    };
    audio.addEventListener('timeupdate', onTimeUpdate);
    audio.addEventListener('ended', () => {
      audio.currentTime = trimStartSec;
      audio.play().catch(() => {});
    });
    this._customAudioTimeUpdateHandler = onTimeUpdate;

    const begin = () => {
      audio.currentTime = trimStartSec;
      audio.play().catch((err) => {
        // Falha ao tocar o arquivo (formato inválido, autoplay bloqueado etc.):
        // volta para o beep padrão nesta chamada, sem quebrar o alerta.
        console.warn('[sound] Falha ao tocar áudio customizado, usando beep padrão:', err);
        this._playing = false;
        this._customAudioEl = null;
        this._playBeep(onAutoStop);
      });
    };

    this._playing = true;
    this._customAudioEl = audio;

    // currentTime só pode ser ajustado com segurança depois que os metadados
    // (incluindo a duração) forem carregados.
    if (audio.readyState >= 1) {
      begin();
    } else {
      audio.addEventListener('loadedmetadata', begin, { once: true });
    }

    this._stopTimeoutId = setTimeout(() => {
      this.stop();
      onAutoStop();
    }, this._maxDurationMs);
  }

  /** Toca o beep sintético gerado via Web Audio API (comportamento padrão). */
  _playBeep(onAutoStop) {
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

    clearTimeout(this._stopTimeoutId);
    this._stopTimeoutId = null;

    if (this._customAudioEl) {
      if (this._customAudioTimeUpdateHandler) {
        this._customAudioEl.removeEventListener('timeupdate', this._customAudioTimeUpdateHandler);
        this._customAudioTimeUpdateHandler = null;
      }
      this._customAudioEl.pause();
      this._customAudioEl.currentTime = 0;
      this._customAudioEl = null;
      this._playing = false;
      return;
    }

    clearInterval(this._intervalId);
    this._intervalId = null;

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

/**
 * Define o toque customizado usado pelos dois alertas (estudo e descanso).
 * Passar null volta ao beep sintético padrão.
 * @param {string|null} dataUrlOrNull
 * @param {number} [trimStartSeconds=0] - segundo do arquivo em que o trecho escolhido pelo usuário começa
 */
export function setAlertCustomSound(dataUrlOrNull, trimStartSeconds = 0) {
  studyFinishedAlert.setCustomSource(dataUrlOrNull, trimStartSeconds);
  restFinishedAlert.setCustomSource(dataUrlOrNull, trimStartSeconds);
}

/**
 * Define o tempo máximo (em ms) que os dois alertas tocam antes de parar
 * sozinhos, caso o usuário não interrompa ou pule manualmente antes disso.
 * @param {number} ms
 */
export function setAlertMaxDuration(ms) {
  studyFinishedAlert.setMaxDuration(ms);
  restFinishedAlert.setMaxDuration(ms);
}

/**
 * Analisa um áudio e devolve uma "forma de onda" simplificada com foco nos
 * graves — aplica um filtro passa-baixa antes de medir a amplitude, para que
 * a visualização acompanhe o "corpo"/batida da música (que é o que dá uma
 * referência visual útil) em vez do volume geral, que fica dominado por
 * agudos e vira uma barra quase uniforme. Usada para desenhar o fundo do
 * seletor de trecho, para o usuário enxergar onde estão os trechos mais
 * fortes do áudio em vez de uma barra lisa e sem referência nenhuma.
 * @param {string} dataUrl
 * @param {number} [samples=90] - quantas barras a visualização deve ter
 * @returns {Promise<number[]>} valores normalizados entre 0 e 1, um por barra
 */
export async function getAudioWaveform(dataUrl, samples = 90) {
  const OfflineCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!OfflineCtx && !AudioContextClass) {
    throw new Error('Web Audio API não suportada neste navegador.');
  }

  const response = await fetch(dataUrl);
  const arrayBuffer = await response.arrayBuffer();

  // Contexto usado só para decodificar os bytes do arquivo em amostras de
  // áudio — nunca toca nada, então não precisa de interação do usuário.
  const decodeCtx = OfflineCtx ? new OfflineCtx(1, 1, 44100) : new AudioContextClass();
  const audioBuffer = await decodeCtx.decodeAudioData(arrayBuffer);

  const channelData = OfflineCtx
    ? await _lowpassFilteredChannelData(audioBuffer, OfflineCtx)
    : audioBuffer.getChannelData(0); // sem OfflineAudioContext disponível, usa a amplitude "crua" (sem isolar graves)

  return _computeWaveformPeaks(channelData, samples);
}

/** Renderiza o áudio por um filtro passa-baixa (~200Hz) e devolve os dados do canal filtrado. */
async function _lowpassFilteredChannelData(audioBuffer, OfflineCtx) {
  const offlineCtx = new OfflineCtx(1, audioBuffer.length, audioBuffer.sampleRate);
  const source = offlineCtx.createBufferSource();
  source.buffer = audioBuffer;

  const lowpass = offlineCtx.createBiquadFilter();
  lowpass.type = 'lowpass';
  lowpass.frequency.value = 200; // realça graves/batida, que é o que dá "corpo" visual à onda

  source.connect(lowpass);
  lowpass.connect(offlineCtx.destination);
  source.start(0);

  const filteredBuffer = await offlineCtx.startRendering();
  return filteredBuffer.getChannelData(0);
}

/** Reduz os dados de amplitude a N picos normalizados (0 a 1), um por barra da visualização. */
function _computeWaveformPeaks(channelData, samples) {
  const blockSize = Math.max(1, Math.floor(channelData.length / samples));
  const peaks = [];

  for (let i = 0; i < samples; i++) {
    const start = i * blockSize;
    const end = Math.min(channelData.length, start + blockSize);
    let sum = 0;
    for (let j = start; j < end; j++) sum += Math.abs(channelData[j]);
    peaks.push(end > start ? sum / (end - start) : 0);
  }

  const max = Math.max(...peaks, 0.0001);
  return peaks.map((v) => v / max);
}

// ---------- Preview (tela de Preferências) ----------
//
// Toca uma única vez um arquivo de áudio para o usuário conferir como fica
// antes de salvar como toque do alerta. Independente do AlertPlayer acima:
// não tem loop nem limite de 10s, só toca o arquivo até o fim ou até stopPreview().

let _previewAudio = null;
let _previewStopTimeoutId = null;
let _previewOnEnded = null;
let _previewPendingBeginHandler = null;

/**
 * @param {string} dataUrl - áudio a tocar (ex: resultado de FileReader.readAsDataURL)
 * @param {() => void} [onEnded] - chamado quando o áudio termina sozinho (não quando é interrompido manualmente)
 * @param {Object} [options]
 * @param {number} [options.startSeconds=0] - segundo em que o preview deve começar (útil para ouvir só o trecho escolhido)
 * @param {number|null} [options.durationSeconds=null] - se informado, o preview para sozinho após esse tempo
 *        (em vez de tocar o arquivo inteiro) — usado para simular exatamente o trecho que o alarme vai tocar
 */
export function playPreview(dataUrl, onEnded = () => {}, { startSeconds = 0, durationSeconds = null } = {}) {
  stopPreview();

  const audio = new Audio(dataUrl);
  audio.volume = 0.8;

  const finish = () => {
    if (_previewStopTimeoutId) {
      clearTimeout(_previewStopTimeoutId);
      _previewStopTimeoutId = null;
    }
    _previewAudio = null;
    _previewOnEnded = null;
    onEnded();
  };
  audio.addEventListener('ended', finish);

  const begin = () => {
    _previewPendingBeginHandler = null;
    audio.currentTime = startSeconds || 0;
    audio.play().catch((err) => {
      // AbortError é esperado quando o preview é pausado/trocado logo em
      // seguida (ex: arrastar o seletor de trecho rapidamente) — não é uma
      // falha real, só o play() anterior sendo cancelado.
      if (err.name !== 'AbortError') {
        console.warn('[sound] Falha ao tocar preview do áudio:', err);
      }
      if (_previewAudio === audio) _previewAudio = null;
    });

    if (durationSeconds != null) {
      _previewStopTimeoutId = setTimeout(() => {
        audio.removeEventListener('ended', finish);
        stopPreview();
        onEnded();
      }, durationSeconds * 1000);
    }
  };

  _previewAudio = audio;
  _previewOnEnded = onEnded;

  if (audio.readyState >= 1) {
    begin();
  } else {
    // Guarda a referência para poder cancelar esse "play adiado" caso o
    // preview seja interrompido antes dos metadados carregarem — sem isso,
    // um preview antigo abandonado podia começar a tocar sozinho mais tarde.
    _previewPendingBeginHandler = begin;
    audio.addEventListener('loadedmetadata', begin, { once: true });
  }
}

/** Interrompe o preview em andamento, se houver. */
export function stopPreview() {
  if (_previewStopTimeoutId) {
    clearTimeout(_previewStopTimeoutId);
    _previewStopTimeoutId = null;
  }
  if (!_previewAudio) return;

  if (_previewPendingBeginHandler) {
    _previewAudio.removeEventListener('loadedmetadata', _previewPendingBeginHandler);
    _previewPendingBeginHandler = null;
  }

  _previewAudio.pause();
  _previewAudio.currentTime = 0;
  _previewAudio = null;
  _previewOnEnded = null;
}

/**
 * Move o preview que já está tocando para um novo início, sem recriar o
 * elemento de áudio. Usado ao arrastar o seletor de trecho com o preview em
 * andamento: evita empilhar vários play()/pause() (um por evento de arraste),
 * que é o que causava o som travar tocando várias vezes ou pausar sem motivo.
 * Se não houver preview tocando no momento, não faz nada.
 * @param {number} startSeconds - novo ponto de início, em segundos
 * @param {number|null} [durationSeconds=null] - reinicia a contagem para parar sozinho, a partir de agora
 * @returns {boolean} true se havia um preview tocando para mover
 */
export function seekPreview(startSeconds, durationSeconds = null) {
  if (!_previewAudio) return false;

  if (_previewStopTimeoutId) {
    clearTimeout(_previewStopTimeoutId);
    _previewStopTimeoutId = null;
  }

  try {
    _previewAudio.currentTime = startSeconds || 0;
  } catch {
    return false; // metadados ainda não carregados; ignora este movimento, o próximo evento tenta de novo
  }

  if (_previewAudio.paused) {
    _previewAudio.play().catch(() => {});
  }

  if (durationSeconds != null) {
    const onEnded = _previewOnEnded || (() => {});
    _previewStopTimeoutId = setTimeout(() => {
      stopPreview();
      onEnded();
    }, durationSeconds * 1000);
  }

  return true;
}

/**
 * Descobre a duração (em segundos) de um áudio a partir do seu dataURL,
 * sem tocá-lo. Usado para montar a UI de recorte (saber até onde o
 * usuário pode arrastar o início do trecho escolhido).
 * @param {string} dataUrl
 * @returns {Promise<number>}
 */
export function getAudioDuration(dataUrl) {
  return new Promise((resolve, reject) => {
    const audio = new Audio(dataUrl);
    audio.addEventListener('loadedmetadata', () => resolve(audio.duration), { once: true });
    audio.addEventListener('error', () => reject(new Error('Não foi possível ler a duração do áudio.')), { once: true });
  });
}

/** @returns {boolean} true se um preview estiver tocando no momento */
export function isPreviewPlaying() {
  return _previewAudio != null;
}
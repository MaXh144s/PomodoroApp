/**
 * bg-web.js
 * Fundo animado do app, com uma cena diferente por tema — ambas no mesmo
 * <canvas>, alternando conforme [data-theme] em <html>:
 *
 * - Tema claro: uma "teia" tecnológica. Nós à deriva, ligados por fios que
 *   surgem e somem conforme os nós se aproximam; pulsos de luz laranja
 *   correm pelos fios (como dados atravessando uma rede); os nós-chave
 *   ("hubs") têm um anel que pulsa; e o ponteiro (mouse/dedo) vira um nó
 *   extra que puxa fios até os vizinhos.
 * - Tema escuro: um céu estrelado com uma "teia em onda" teal/ciano cruzando
 *   a parte inferior da tela — nós à deriva horizontal lenta, ligados por
 *   fios quando próximos, cuja altura segue uma soma de senoides que se
 *   desloca com o tempo (dá o efeito de onda, como uma malha ao vento).
 *   Alguns nós são "hubs" com brilho pulsante mais forte, como os pontos de
 *   destaque da referência visual. Estrelas cintilam em ritmos levemente
 *   diferentes entre si por cima da onda (evita um "piscar" sincronizado) e,
 *   de vez em quando, uma estrela cadente cruza a tela na diagonal.
 *
 * É procedural (canvas 2D), não um GIF/vídeo: nunca "reinicia", é nítido em
 * qualquer tela e pesa poucos KB. Tudo é desenhado com transparência baixa
 * para ficar atrás dos cards sem atrapalhar a leitura.
 *
 * Autocontido: cria o próprio <canvas> (fixo, atrás de todo o conteúdo) e não
 * depende de nenhum outro módulo do app nem de CSS externo. Basta carregá-lo:
 *   <script type="module" src="./js/bg-web.js"></script>
 *
 * Comportamento:
 * - A simulação da cena que não está visível fica pausada (só a do tema
 *   ativo roda a cada quadro), então trocar de tema não pesa o dobro.
 * - Pausa com a aba em segundo plano.
 * - prefers-reduced-motion: desenha um único quadro estático, sem animar.
 */

const TAU = Math.PI * 2;

const CONFIG = Object.freeze({
  frameIntervalMs: 24,   // ~40fps: o movimento é lento, não precisa de 60 e poupa bateria
  speedMinPx: 6,         // velocidade dos nós, em px/s
  speedMaxPx: 16,
  hubEvery: 6,           // 1 nó em cada N é um "hub" (anel laranja)
  offscreenMarginPx: 20, // nós quicam um pouco fora da tela, para os fios chegarem às bordas
  maxPulses: 6,
  maxPulseHops: 6,       // quantos fios um pulso percorre antes de sumir
  pulseSpeedPx: 95,      // velocidade dos pulsos, em px/s
  resizeHeightThresholdPx: 120, // ignora variações pequenas de altura (barra de endereço do celular)

  // ---- Tema escuro: céu estrelado ----
  starAreaPerStarPx2: 9000, // 1 estrela a cada N px² de tela (quanto menor, mais denso)
  starCountMin: 70,
  starCountMax: 220,
  starRadiusMinPx: 0.6,
  starRadiusMaxPx: 1.8,
  starTwinkleMinSec: 2.4,  // período de cintilação por estrela (varia por estrela para não sincronizar)
  starTwinkleMaxSec: 6,
  starAlphaMin: 0.25,      // brilho no ponto mais "apagado" da cintilação
  starAlphaMax: 0.9,       // brilho no ponto mais "aceso"
  maxShootingStars: 2,
  shootingStarSpawnChancePerSec: 0.18,
  shootingStarSpeedMinPx: 480,
  shootingStarSpeedMaxPx: 760,
  shootingStarTrailLengthPx: 110,

  // ---- Tema escuro: teia em onda (plexus ondulado na parte de baixo) ----
  waveNodeAreaPerNodePx2: 5200, // nós por área de tela (menor = mais nós = mais conexões)
  waveNodeCountMin: 60,
  waveNodeCountMax: 220,
  waveMaxDistPx: 118,          // distância máxima para dois nós da onda se ligarem por um fio
  waveBandCenterRatio: 0.66,  // centro vertical da faixa da onda (proporção da altura da tela)
  waveBandLiftPx: 40,         // desloca a faixa um pouco pra cima do centro (como na referência)
  waveDriftMinPx: 3,          // deriva horizontal lenta dos nós, em px/s
  waveDriftMaxPx: 10,
  waveFrequency1: 0.006,      // "comprimento de onda" da senoide principal (por px de x)
  waveFrequency2: 0.014,      // segunda senoide, mais curta, soma-se à primeira para parecer orgânico
  waveAmplitude1Px: 46,
  waveAmplitude2Px: 22,
  waveSpeed1: 0.5,            // velocidade com que a onda "corre" ao longo do tempo (rad/s)
  waveSpeed2: 0.32,
  waveBobAmplitudePx: 6,      // pequeno "respirar" vertical independente por nó, por cima da onda
  waveNodeMinRadiusPx: 0.9,   // raio dos nós menores/comuns
  waveNodeMaxRadiusPx: 2.6,   // raio dos nós maiores (antes de qualquer brilho de conexão)
  waveLineMinWidthPx: 0.4,    // espessura mínima de um fio (nós distantes/pequenos)
  waveLineMaxWidthPx: 2.6,    // espessura máxima (nós próximos e "grandes")
  waveGlowDegreeThreshold: 0.62, // fração do maior nº de conexões da tela a partir da qual um nó "acende" (0 a 1)
  waveHubGlowRadiusPx: 16,    // raio-base do brilho dos nós mais conectados
});

// Cores em "r, g, b" para compor rgba() com alfas diferentes.
const COLORS = Object.freeze({
  line: '70, 95, 130',    // azul-acinzentado: fios e nós comuns (tema claro)
  accent: '226, 87, 43',  // laranja da marca: hubs, pulsos e ponteiro (tema claro)
  star: '210, 236, 233',   // branco levemente esverdeado: estrelas (tema escuro)
  shootingStar: '255, 255, 255',
  webDark: '64, 224, 208',       // teal: fios e nós comuns da teia em onda (tema escuro)
  webDarkAccent: '140, 250, 232', // ciano claro: brilho dos hubs da teia em onda (tema escuro)
});

const root = document.documentElement;
const reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');

let canvas = null;
let ctx = null;
let width = 0;
let height = 0;
let maxDist = 140; // distância máxima (px) para dois nós se ligarem por um fio

/** @type {Array<{x:number,y:number,vx:number,vy:number,hub:boolean,phase:number}>} */
let nodes = [];
/** @type {Array<{a:number,b:number,t:number,hops:number}>} */
let pulses = [];
const pointer = { x: 0, y: 0, active: false };

/** @type {Array<{x:number,y:number,radius:number,baseAlpha:number,twinkleSpeed:number,phase:number}>} */
let stars = [];
/** @type {Array<{x:number,y:number,vx:number,vy:number,life:number}>} */
let shootingStars = [];

/** @type {Array<{x:number,y:number,vx:number,ampMul:number,wavePhase:number,bobPhase:number,bobSpeed:number,hub:boolean}>} */
let waveNodes = [];
let waveTime = 0; // acumulador de tempo próprio da onda (avança só quando a cena roda; parado = onda "congelada")

let running = false;
let rafId = null;
let lastTs = 0;

// ---------- Utilidades ----------

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function rand(min, max) {
  return min + Math.random() * (max - min);
}

function isDarkTheme() {
  return root.dataset.theme === 'dark';
}

// ---------- Nós e pulsos ----------

function makeNode(index) {
  const angle = Math.random() * TAU;
  const speed = rand(CONFIG.speedMinPx, CONFIG.speedMaxPx);
  return {
    x: Math.random() * width,
    y: Math.random() * height,
    vx: Math.cos(angle) * speed,
    vy: Math.sin(angle) * speed,
    hub: index % CONFIG.hubEvery === 0,
    phase: Math.random() * TAU,
  };
}

/** Quantidade de nós proporcional à área da tela (menos densa no celular). */
function targetNodeCount() {
  const areaPerNode = width < 600 ? 16000 : 13000;
  return clamp(Math.round((width * height) / areaPerNode), 26, 100);
}

/** Sorteia um vizinho ligado a `index` por um fio visível, exceto `exclude`. Retorna -1 se não houver. */
function pickNeighbor(index, exclude) {
  const from = nodes[index];
  const limit = maxDist * 0.95;
  const candidates = [];
  for (let i = 0; i < nodes.length; i += 1) {
    if (i === index || i === exclude) continue;
    if (Math.hypot(nodes[i].x - from.x, nodes[i].y - from.y) < limit) candidates.push(i);
  }
  if (candidates.length === 0) return -1;
  return candidates[Math.floor(Math.random() * candidates.length)];
}

function spawnPulse() {
  const a = Math.floor(Math.random() * nodes.length);
  const b = pickNeighbor(a, -1);
  if (b >= 0) pulses.push({ a, b, t: 0, hops: 0 });
}

// ---------- Estrelas e estrelas cadentes (tema escuro) ----------

function makeStar() {
  return {
    x: Math.random() * width,
    y: Math.random() * height,
    radius: rand(CONFIG.starRadiusMinPx, CONFIG.starRadiusMaxPx),
    baseAlpha: rand(CONFIG.starAlphaMin, CONFIG.starAlphaMax),
    // rad/s: cada estrela cintila num ritmo levemente diferente, para não
    // parecerem piscar todas juntas.
    twinkleSpeed: TAU / rand(CONFIG.starTwinkleMinSec, CONFIG.starTwinkleMaxSec),
    phase: Math.random() * TAU,
  };
}

/** Quantidade de estrelas proporcional à área da tela. */
function targetStarCount() {
  return clamp(Math.round((width * height) / CONFIG.starAreaPerStarPx2), CONFIG.starCountMin, CONFIG.starCountMax);
}

/** Nasce sempre num canto superior e desce na diagonal, como uma estrela cadente clássica. */
function spawnShootingStar() {
  const fromLeft = Math.random() < 0.5;
  const speed = rand(CONFIG.shootingStarSpeedMinPx, CONFIG.shootingStarSpeedMaxPx);
  const descentAngle = rand(0.35, 0.75); // inclinação descendente, em radianos

  shootingStars.push({
    x: fromLeft ? rand(-40, width * 0.5) : rand(width * 0.5, width + 40),
    y: rand(-40, height * 0.35),
    vx: Math.cos(descentAngle) * speed * (fromLeft ? 1 : -1),
    vy: Math.sin(descentAngle) * speed,
    life: 0,
  });
}

// ---------- Teia em onda (tema escuro) ----------

function makeWaveNode(index) {
  return {
    x: Math.random() * (width + 2 * CONFIG.offscreenMarginPx) - CONFIG.offscreenMarginPx,
    vx: (Math.random() < 0.5 ? -1 : 1) * rand(CONFIG.waveDriftMinPx, CONFIG.waveDriftMaxPx),
    y: 0, // calculado a cada quadro em updateWaveWeb, a partir da posição x e do tempo
    ampMul: rand(0.7, 1.3),        // varia a amplitude por nó, pra não ficar tudo igual
    wavePhase: Math.random() * TAU, // desloca a fase da onda por nó (evita "fileiras" alinhadas)
    bobPhase: Math.random() * TAU,
    bobSpeed: rand(0.4, 0.9),       // rad/s do "respirar" vertical próprio de cada nó
    sizeMul: Math.random(),         // 0..1: define o raio do nó e engrossa um pouco os fios que ele puxa
  };
}

/** Quantidade de nós da onda proporcional à área da tela. */
function targetWaveNodeCount() {
  return clamp(Math.round((width * height) / CONFIG.waveNodeAreaPerNodePx2), CONFIG.waveNodeCountMin, CONFIG.waveNodeCountMax);
}

// ---------- Simulação ----------

/** Escolhe qual simulação roda a cada quadro — só a do tema ativo. */
function update(dt) {
  if (isDarkTheme()) {
    updateStars(dt);
    updateWaveWeb(dt);
    return;
  }
  updateWeb(dt);
}

function updateStars(dt) {
  if (shootingStars.length < CONFIG.maxShootingStars
    && Math.random() < dt * CONFIG.shootingStarSpawnChancePerSec) {
    spawnShootingStar();
  }

  for (let i = shootingStars.length - 1; i >= 0; i -= 1) {
    const s = shootingStars[i];
    s.x += s.vx * dt;
    s.y += s.vy * dt;
    s.life += dt;
    // Sai da tela (ou de uma margem generosa) por qualquer lado: descarta.
    if (s.x < -100 || s.x > width + 100 || s.y > height + 100) {
      shootingStars.splice(i, 1);
    }
  }
}

/**
 * Move os nós da onda lateralmente (deriva lenta, quicando nas bordas) e
 * recalcula a altura de cada um a partir de uma soma de duas senoides sobre
 * x — a segunda mais curta e mais rápida, para dar um aspecto orgânico em
 * vez de uma onda perfeitamente regular — mais um "respirar" vertical bem
 * sutil e independente por nó. Como a altura é recalculada (não integrada
 * por velocidade), a forma nunca diverge nem precisa de reset.
 */
function updateWaveWeb(dt) {
  waveTime += dt;
  const m = CONFIG.offscreenMarginPx;
  const bandCenterY = height * CONFIG.waveBandCenterRatio - CONFIG.waveBandLiftPx;

  for (const n of waveNodes) {
    n.x += n.vx * dt;
    if (n.x < -m) { n.x = -m; n.vx = Math.abs(n.vx); }
    else if (n.x > width + m) { n.x = width + m; n.vx = -Math.abs(n.vx); }

    const wave =
      Math.sin(n.x * CONFIG.waveFrequency1 + waveTime * CONFIG.waveSpeed1 + n.wavePhase) * CONFIG.waveAmplitude1Px +
      Math.sin(n.x * CONFIG.waveFrequency2 - waveTime * CONFIG.waveSpeed2 + n.wavePhase * 1.7) * CONFIG.waveAmplitude2Px;
    const bob = Math.sin(waveTime * n.bobSpeed + n.bobPhase) * CONFIG.waveBobAmplitudePx;

    n.y = bandCenterY + wave * n.ampMul + bob;
  }
}

function updateWeb(dt) {
  const m = CONFIG.offscreenMarginPx;

  for (const n of nodes) {
    n.x += n.vx * dt;
    n.y += n.vy * dt;
    if (n.x < -m) { n.x = -m; n.vx = Math.abs(n.vx); }
    else if (n.x > width + m) { n.x = width + m; n.vx = -Math.abs(n.vx); }
    if (n.y < -m) { n.y = -m; n.vy = Math.abs(n.vy); }
    else if (n.y > height + m) { n.y = height + m; n.vy = -Math.abs(n.vy); }
  }

  if (pulses.length < CONFIG.maxPulses && Math.random() < dt * 0.9) spawnPulse();

  for (let i = pulses.length - 1; i >= 0; i -= 1) {
    const p = pulses[i];
    const a = nodes[p.a];
    const b = nodes[p.b];
    const len = Math.hypot(b.x - a.x, b.y - a.y);

    // Os nós se afastaram e o fio "rompeu": o pulso se dissipa.
    if (len > maxDist) { pulses.splice(i, 1); continue; }

    p.t += (CONFIG.pulseSpeedPx * dt) / Math.max(len, 1);
    if (p.t >= 1) {
      p.hops += 1;
      const next = p.hops >= CONFIG.maxPulseHops ? -1 : pickNeighbor(p.b, p.a);
      if (next < 0) { pulses.splice(i, 1); continue; }
      p.a = p.b;
      p.b = next;
      p.t = 0;
    }
  }
}

// ---------- Desenho ----------

function drawLinks() {
  const maxDist2 = maxDist * maxDist;
  ctx.lineWidth = 1;

  for (let i = 0; i < nodes.length; i += 1) {
    const a = nodes[i];
    for (let j = i + 1; j < nodes.length; j += 1) {
      const b = nodes[j];
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      const d2 = dx * dx + dy * dy;
      if (d2 >= maxDist2) continue;

      const k = 1 - Math.sqrt(d2) / maxDist;
      ctx.strokeStyle = `rgba(${COLORS.line}, ${(0.32 * Math.pow(k, 1.3)).toFixed(3)})`;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
  }
}

function drawPointer() {
  if (!pointer.active) return;
  const reach = maxDist * 1.1;

  ctx.lineWidth = 1;
  for (const n of nodes) {
    const d = Math.hypot(n.x - pointer.x, n.y - pointer.y);
    if (d >= reach) continue;
    ctx.strokeStyle = `rgba(${COLORS.accent}, ${(0.5 * (1 - d / reach)).toFixed(3)})`;
    ctx.beginPath();
    ctx.moveTo(pointer.x, pointer.y);
    ctx.lineTo(n.x, n.y);
    ctx.stroke();
  }

  ctx.fillStyle = `rgba(${COLORS.accent}, 0.8)`;
  ctx.beginPath();
  ctx.arc(pointer.x, pointer.y, 2.4, 0, TAU);
  ctx.fill();
}

function drawNodes(time) {
  for (const n of nodes) {
    if (n.hub) {
      const ringRadius = 4.5 + Math.sin(time * 0.0015 + n.phase) * 1.1;
      ctx.strokeStyle = `rgba(${COLORS.accent}, 0.35)`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(n.x, n.y, ringRadius, 0, TAU);
      ctx.stroke();

      ctx.fillStyle = `rgba(${COLORS.accent}, 0.75)`;
      ctx.beginPath();
      ctx.arc(n.x, n.y, 2.1, 0, TAU);
      ctx.fill();
    } else {
      ctx.fillStyle = `rgba(${COLORS.line}, 0.45)`;
      ctx.beginPath();
      ctx.arc(n.x, n.y, 1.5, 0, TAU);
      ctx.fill();
    }
  }
}

function drawPulses() {
  for (const p of pulses) {
    const a = nodes[p.a];
    const b = nodes[p.b];

    // Surge no primeiro fio e some no último, em vez de "piscar" do nada.
    let alpha = 1;
    if (p.hops === 0) alpha = Math.min(1, p.t * 4);
    if (p.hops === CONFIG.maxPulseHops - 1) alpha *= 1 - p.t;

    const x = a.x + (b.x - a.x) * p.t;
    const y = a.y + (b.y - a.y) * p.t;
    const tailT = Math.max(0, p.t - 0.22);
    const tx = a.x + (b.x - a.x) * tailT;
    const ty = a.y + (b.y - a.y) * tailT;

    // Rastro (cometa)
    const trail = ctx.createLinearGradient(tx, ty, x, y);
    trail.addColorStop(0, `rgba(${COLORS.accent}, 0)`);
    trail.addColorStop(1, `rgba(${COLORS.accent}, ${(0.55 * alpha).toFixed(3)})`);
    ctx.strokeStyle = trail;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(tx, ty);
    ctx.lineTo(x, y);
    ctx.stroke();

    // Brilho
    const glow = ctx.createRadialGradient(x, y, 0, x, y, 9);
    glow.addColorStop(0, `rgba(${COLORS.accent}, ${(0.5 * alpha).toFixed(3)})`);
    glow.addColorStop(1, `rgba(${COLORS.accent}, 0)`);
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(x, y, 9, 0, TAU);
    ctx.fill();

    // Núcleo
    ctx.fillStyle = `rgba(${COLORS.accent}, ${(0.95 * alpha).toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(x, y, 1.8, 0, TAU);
    ctx.fill();
  }
}

function drawStars(time) {
  for (const st of stars) {
    // 0..1, com um leve piso: nunca apaga totalmente (starAlphaMin cuida disso).
    const twinkle = 0.5 + 0.5 * Math.sin(time * 0.001 * st.twinkleSpeed + st.phase);
    const alpha = st.baseAlpha * (0.55 + 0.45 * twinkle);
    ctx.fillStyle = `rgba(${COLORS.star}, ${alpha.toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(st.x, st.y, st.radius, 0, TAU);
    ctx.fill();
  }
}

function drawShootingStars() {
  for (const s of shootingStars) {
    const speed = Math.hypot(s.vx, s.vy) || 1;
    const tx = s.x - (s.vx / speed) * CONFIG.shootingStarTrailLengthPx;
    const ty = s.y - (s.vy / speed) * CONFIG.shootingStarTrailLengthPx;
    const fadeIn = Math.min(1, s.life * 6); // surge suavemente ao nascer, em vez de aparecer do nada

    const trail = ctx.createLinearGradient(tx, ty, s.x, s.y);
    trail.addColorStop(0, `rgba(${COLORS.shootingStar}, 0)`);
    trail.addColorStop(1, `rgba(${COLORS.shootingStar}, ${(0.85 * fadeIn).toFixed(3)})`);
    ctx.strokeStyle = trail;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(tx, ty);
    ctx.lineTo(s.x, s.y);
    ctx.stroke();

    ctx.fillStyle = `rgba(${COLORS.shootingStar}, ${(0.9 * fadeIn).toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(s.x, s.y, 1.4, 0, TAU);
    ctx.fill();
  }
}

/**
 * Desenha a teia em onda do tema escuro: fios entre nós próximos, com
 * espessura e opacidade variando conforme a distância (mais perto = mais
 * grosso/opaco) e o tamanho dos dois nós envolvidos. Ao mesmo tempo, conta
 * quantas conexões cada nó tem (seu "grau") — os nós que acabam no meio de
 * mais conexões (onde a malha fica mais densa) acendem com um brilho radial
 * pulsante, proporcional a esse grau: a luz nasce da própria geometria da
 * teia a cada quadro, e não de posições fixas, então os pontos de destaque
 * se deslocam junto com a onda.
 */
function drawWaveMesh(time) {
  const maxDist2 = CONFIG.waveMaxDistPx * CONFIG.waveMaxDistPx;
  const degree = new Array(waveNodes.length).fill(0);

  for (let i = 0; i < waveNodes.length; i += 1) {
    const a = waveNodes[i];
    for (let j = i + 1; j < waveNodes.length; j += 1) {
      const b = waveNodes[j];
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      const d2 = dx * dx + dy * dy;
      if (d2 >= maxDist2) continue;

      const k = 1 - Math.sqrt(d2) / CONFIG.waveMaxDistPx; // 1 = colados, 0 = no limite de alcance
      degree[i] += 1;
      degree[j] += 1;

      const sizeFactor = (a.sizeMul + b.sizeMul) / 2;
      ctx.lineWidth = CONFIG.waveLineMinWidthPx
        + (CONFIG.waveLineMaxWidthPx - CONFIG.waveLineMinWidthPx) * (0.7 * k + 0.3 * sizeFactor);
      ctx.strokeStyle = `rgba(${COLORS.webDark}, ${(0.22 + 0.34 * Math.pow(k, 1.3) + 0.08 * sizeFactor).toFixed(3)})`;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
  }

  let maxDegree = 1; // evita divisão por zero; garante que a escala de brilho é relativa a esta tela
  for (const d of degree) if (d > maxDegree) maxDegree = d;

  for (let i = 0; i < waveNodes.length; i += 1) {
    const n = waveNodes[i];
    const degreeRatio = degree[i] / maxDegree; // 0..1: quão concentrado de conexões este nó está, agora
    const radius = CONFIG.waveNodeMinRadiusPx
      + (CONFIG.waveNodeMaxRadiusPx - CONFIG.waveNodeMinRadiusPx) * n.sizeMul;

    if (degreeRatio >= CONFIG.waveGlowDegreeThreshold) {
      // Quanto mais acima do limiar, mais forte o brilho — e não é liga/desliga.
      const intensity = (degreeRatio - CONFIG.waveGlowDegreeThreshold) / (1 - CONFIG.waveGlowDegreeThreshold);
      const pulse = 0.75 + 0.25 * Math.sin(time * 0.0018 + n.wavePhase);
      const glowRadius = CONFIG.waveHubGlowRadiusPx * (0.6 + intensity * 0.9) * pulse;

      const glow = ctx.createRadialGradient(n.x, n.y, 0, n.x, n.y, glowRadius);
      glow.addColorStop(0, `rgba(${COLORS.webDarkAccent}, ${(0.35 + intensity * 0.5) .toFixed(3)})`);
      glow.addColorStop(1, `rgba(${COLORS.webDarkAccent}, 0)`);
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(n.x, n.y, glowRadius, 0, TAU);
      ctx.fill();

      ctx.fillStyle = `rgba(${COLORS.webDarkAccent}, 0.9)`;
      ctx.beginPath();
      ctx.arc(n.x, n.y, radius * 1.3, 0, TAU);
      ctx.fill();
    } else {
      ctx.fillStyle = `rgba(${COLORS.webDark}, ${(0.4 + degreeRatio * 0.35).toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(n.x, n.y, radius, 0, TAU);
      ctx.fill();
    }
  }
}

/** Escolhe qual cena desenhar a cada quadro, conforme o tema ativo. */
function draw(time) {
  ctx.clearRect(0, 0, width, height);
  if (isDarkTheme()) {
    drawStars(time);
    drawShootingStars();
    drawWaveMesh(time);
    return;
  }
  drawLinks();
  drawPointer();
  drawNodes(time);
  drawPulses();
}

// ---------- Ciclo de animação ----------

function frame(ts) {
  rafId = requestAnimationFrame(frame);
  if (ts - lastTs < CONFIG.frameIntervalMs) return;

  // Limita o dt: ao voltar de uma aba em segundo plano, evita um "salto" dos nós.
  const dt = Math.min((ts - lastTs) / 1000, 0.05);
  lastTs = ts;
  update(dt);
  draw(ts);
}

function start() {
  if (running) return;
  running = true;
  lastTs = performance.now();
  rafId = requestAnimationFrame(frame);
}

function stop() {
  running = false;
  if (rafId != null) cancelAnimationFrame(rafId);
  rafId = null;
}

/** Reavalia visibilidade da aba e preferência de movimento, e liga/desliga a animação.
 *  A troca entre as duas cenas (teia / céu estrelado) é decidida a cada quadro
 *  em update()/draw(), então trocar de tema não precisa passar por aqui. */
function sync() {
  if (document.hidden) {
    stop();
    return;
  }

  if (reducedMotionQuery.matches) {
    stop();
    pulses = [];
    shootingStars = [];
    updateWaveWeb(0); // fixa a forma da onda (sem isso, os nós ficariam no topo, nunca posicionados)
    draw(0); // um quadro estático, sem movimento
    return;
  }

  start();
}

// ---------- Tamanho ----------

function resize() {
  const w = root.clientWidth;
  const h = window.innerHeight;
  if (!w || !h) return;

  // No celular a barra de endereço recolhe/expande e muda a altura por
  // dezenas de px a cada rolagem: ignora, para não realocar o canvas à toa.
  if (width && w === width && Math.abs(h - height) < CONFIG.resizeHeightThresholdPx) return;

  const ratioX = width ? w / width : 1;
  const ratioY = height ? h / height : 1;
  width = w;
  height = h;

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  maxDist = clamp(Math.hypot(w, h) * 0.12, 110, 170);

  for (const n of nodes) {
    n.x *= ratioX;
    n.y *= ratioY;
  }

  const target = targetNodeCount();
  while (nodes.length < target) nodes.push(makeNode(nodes.length));
  if (nodes.length > target) nodes.length = target;
  pulses = pulses.filter((p) => p.a < nodes.length && p.b < nodes.length);

  for (const st of stars) {
    st.x *= ratioX;
    st.y *= ratioY;
  }
  const targetStars = targetStarCount();
  while (stars.length < targetStars) stars.push(makeStar());
  if (stars.length > targetStars) stars.length = targetStars;
  shootingStars = []; // em voo com coordenadas da proporção antiga: mais simples descartar que reescalar

  for (const wn of waveNodes) {
    wn.x *= ratioX;
  }
  const targetWaveNodes = targetWaveNodeCount();
  while (waveNodes.length < targetWaveNodes) waveNodes.push(makeWaveNode(waveNodes.length));
  if (waveNodes.length > targetWaveNodes) waveNodes.length = targetWaveNodes;
  updateWaveWeb(0); // posiciona os nós (y depende da altura da tela) antes do próximo desenho

  if (!running) draw(0); // repinta (o clear do resize apagou o quadro)
}

// ---------- Inicialização ----------

function init() {
  canvas = document.createElement('canvas');
  canvas.id = 'bg-web';
  canvas.setAttribute('aria-hidden', 'true');
  // z-index negativo: fica acima do fundo da página (background do body) e
  // abaixo de todo o conteúdo, sem precisar mexer em nenhum CSS existente.
  canvas.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;z-index:-1;pointer-events:none;';

  ctx = canvas.getContext('2d');
  if (!ctx) return; // sem canvas 2D: o app segue normal, só sem o fundo animado

  document.body.prepend(canvas);
  resize();

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(resize, 150);
  });

  window.addEventListener('pointermove', (event) => {
    pointer.x = event.clientX;
    pointer.y = event.clientY;
    pointer.active = true;
  }, { passive: true });
  window.addEventListener('pointerup', (event) => {
    if (event.pointerType === 'touch') pointer.active = false;
  }, { passive: true });
  window.addEventListener('pointerout', (event) => {
    if (!event.relatedTarget) pointer.active = false; // ponteiro saiu da janela
  }, { passive: true });

  document.addEventListener('visibilitychange', sync);
  reducedMotionQuery.addEventListener('change', sync);
  new MutationObserver(sync).observe(root, { attributes: true, attributeFilter: ['data-theme'] });

  sync();
}

init();
/**
 * sw.js
 * Service worker do Pomodoro: cache estático para uso offline e instalação
 * como PWA. O app não depende de nenhuma rede (tudo é localStorage), então
 * a estratégia é simples — cache-first para tudo que é do próprio app,
 * com fallback pra rede só caso apareça um arquivo novo não cacheado.
 *
 * Ao publicar uma mudança nos arquivos do app, incremente CACHE_VERSION
 * para que os clientes baixem os arquivos atualizados em vez de continuar
 * servindo a versão antiga do cache.
 */

const CACHE_VERSION = 'pomodoro-v6';

const CORE_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './css/style.css',
  './css/motion.css',
  './css/depth.css',
  './js/app.js',
  './js/appstate.js',
  './js/cycles.js',
  './js/history.js',
  './js/preferences.js',
  './js/storage.js',
  './js/timer.js',
  './js/sound.js',
  './img/favicon.png',
  './img/icon-192.png',
  './img/icon-512.png',
  './img/icon-512-maskable.png',
  './img/icon-download.png',
  './img/icon-upload.png',
  './img/icon-trash.png',
  './img/icon-chart.png',
  './img/icon-settings.png',
  './img/icon-new-cycle.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(CORE_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_VERSION)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Só intercepta GET do próprio domínio — deixa qualquer outra coisa
  // (ex: extensões, chamadas de outra origem) passar direto pela rede.
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) {
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;

      return fetch(request)
        .then((response) => {
          // Guarda uma cópia no cache para a próxima vez ficar disponível
          // offline também (ex: js/debug.js, que existe só em dev e não
          // está na lista fixa acima).
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(request, clone));
          }
          return response;
        })
        .catch(() => {
          // Sem rede e sem cache para esse arquivo: não há como servir.
          // Para navegação de página, cai para o index.html já cacheado.
          if (request.mode === 'navigate') {
            return caches.match('./index.html');
          }
          return undefined;
        });
    })
  );
});
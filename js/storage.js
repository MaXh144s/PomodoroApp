/**
 * storage.js
 * Camada de persistência do app.
 *
 * Hoje usa localStorage, mas expõe uma interface abstrata (get/set/remove/clear)
 * para que, no futuro, seja possível trocar por IndexedDB ou uma API remota
 * sem alterar quem consome este módulo — basta implementar a mesma interface
 * em outra classe e trocar a instância exportada em `storage`.
 *
 * Todas as chaves usadas pelo app ficam centralizadas em STORAGE_KEYS,
 * evitando strings "mágicas" espalhadas pelo código.
 */

export const STORAGE_KEYS = Object.freeze({
  SETTINGS: 'pomodoro:settings',       // configuração atual (estudo/descanso em ms)
  SESSIONS: 'pomodoro:sessions',       // histórico de sessões concluídas
  TIMER_SNAPSHOT: 'pomodoro:timerSnapshot', // snapshot do CountdownTimer em andamento
  APP_STATE: 'pomodoro:appState',      // estado da máquina de estados (fase atual, etc.)
  PREFERENCES: 'pomodoro:preferences', // preferências do usuário (proporção padrão e duração inicial sugerida)
  CUSTOM_SOUND: 'pomodoro:customSound', // toque customizado (dataURL de áudio) escolhido pelo usuário para o alerta
  THEME: 'pomodoro:theme',             // tema escolhido manualmente ('light' | 'dark'); ausente = segue o sistema
  KNOWN_SUBJECTS: 'pomodoro:knownSubjects', // assuntos já digitados pelo usuário, usados para sugestão/autocomplete
});

/**
 * Interface abstrata de armazenamento. Qualquer implementação (localStorage,
 * IndexedDB, API remota) deve seguir este contrato: get/set/remove são
 * assíncronos (retornam Promise) para que trocar a implementação depois
 * não exija mudar quem chama.
 */
class StorageDriver {
  // eslint-disable-next-line no-unused-vars
  async get(key) { throw new Error('get() não implementado'); }
  // eslint-disable-next-line no-unused-vars
  async set(key, value) { throw new Error('set() não implementado'); }
  // eslint-disable-next-line no-unused-vars
  async remove(key) { throw new Error('remove() não implementado'); }
  async clear() { throw new Error('clear() não implementado'); }
}

/**
 * Implementação usando localStorage do navegador.
 * Serializa/deserializa JSON automaticamente.
 */
class LocalStorageDriver extends StorageDriver {
  async get(key) {
    try {
      const raw = window.localStorage.getItem(key);
      if (raw == null) return null;
      return JSON.parse(raw);
    } catch (err) {
      console.error(`[storage] Falha ao ler "${key}":`, err);
      return null;
    }
  }

  async set(key, value) {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (err) {
      // Pode falhar por quota excedida (ex: histórico muito grande) ou
      // por localStorage indisponível (modo privado em alguns navegadores).
      console.error(`[storage] Falha ao salvar "${key}":`, err);
      return false;
    }
  }

  async remove(key) {
    try {
      window.localStorage.removeItem(key);
      return true;
    } catch (err) {
      console.error(`[storage] Falha ao remover "${key}":`, err);
      return false;
    }
  }

  async clear() {
    try {
      // Remove só as chaves do app, para não afetar outros dados que
      // eventualmente existam no mesmo domínio.
      Object.values(STORAGE_KEYS).forEach((key) => window.localStorage.removeItem(key));
      return true;
    } catch (err) {
      console.error('[storage] Falha ao limpar dados do app:', err);
      return false;
    }
  }
}

/**
 * Driver em memória, usado como fallback quando localStorage não está
 * disponível (ex: alguns navegadores em modo privado lançam exceção mesmo
 * ao tentar acessar window.localStorage). Garante que o app não quebra,
 * apenas perde a persistência entre reloads.
 */
class MemoryStorageDriver extends StorageDriver {
  constructor() {
    super();
    this._data = new Map();
  }

  async get(key) {
    return this._data.has(key) ? this._data.get(key) : null;
  }

  async set(key, value) {
    this._data.set(key, value);
    return true;
  }

  async remove(key) {
    this._data.delete(key);
    return true;
  }

  async clear() {
    this._data.clear();
    return true;
  }
}

function _isLocalStorageAvailable() {
  try {
    const testKey = '__pomodoro_storage_test__';
    window.localStorage.setItem(testKey, '1');
    window.localStorage.removeItem(testKey);
    return true;
  } catch {
    return false;
  }
}

/**
 * Instância única (singleton) usada pelo resto do app.
 * Escolhe automaticamente localStorage ou o fallback em memória.
 */
export const storage = _isLocalStorageAvailable()
  ? new LocalStorageDriver()
  : new MemoryStorageDriver();

// ---------- Funções de conveniência para as chaves conhecidas do app ----------

/** @returns {Promise<object|null>} configuração salva (ou null se nunca configurado) */
export async function loadSettings() {
  return storage.get(STORAGE_KEYS.SETTINGS);
}

/** @param {object} settings */
export async function saveSettings(settings) {
  return storage.set(STORAGE_KEYS.SETTINGS, settings);
}

/** @returns {Promise<Array<object>>} lista de sessões salvas (nunca null, sempre array) */
export async function loadSessions() {
  const sessions = await storage.get(STORAGE_KEYS.SESSIONS);
  return Array.isArray(sessions) ? sessions : [];
}

/** @param {Array<object>} sessions */
export async function saveSessions(sessions) {
  return storage.set(STORAGE_KEYS.SESSIONS, sessions);
}

/** Adiciona uma sessão ao final do histórico existente, sem apagar as anteriores. */
export async function appendSession(session) {
  const sessions = await loadSessions();
  sessions.push(session);
  await saveSessions(sessions);
  return sessions;
}

/** @returns {Promise<object|null>} snapshot do timer em andamento, se houver */
export async function loadTimerSnapshot() {
  return storage.get(STORAGE_KEYS.TIMER_SNAPSHOT);
}

/** @param {object|null} snapshot - passar null para limpar (ex: ao finalizar) */
export async function saveTimerSnapshot(snapshot) {
  if (snapshot == null) return storage.remove(STORAGE_KEYS.TIMER_SNAPSHOT);
  return storage.set(STORAGE_KEYS.TIMER_SNAPSHOT, snapshot);
}

/** @returns {Promise<object|null>} estado da máquina de estados (fase, config ativa etc.) */
export async function loadAppState() {
  return storage.get(STORAGE_KEYS.APP_STATE);
}

/** @param {object} appState */
export async function saveAppState(appState) {
  return storage.set(STORAGE_KEYS.APP_STATE, appState);
}

/** @returns {Promise<object|null>} preferências salvas (ou null se o usuário nunca configurou) */
export async function loadPreferences() {
  return storage.get(STORAGE_KEYS.PREFERENCES);
}

/** @param {object} preferences */
export async function savePreferences(preferences) {
  return storage.set(STORAGE_KEYS.PREFERENCES, preferences);
}

/** @returns {Promise<{name: string, dataUrl: string}|null>} toque customizado salvo (ou null se estiver usando o beep padrão) */
export async function loadCustomSound() {
  return storage.get(STORAGE_KEYS.CUSTOM_SOUND);
}

/** @param {{name: string, dataUrl: string}} sound */
export async function saveCustomSound(sound) {
  return storage.set(STORAGE_KEYS.CUSTOM_SOUND, sound);
}

/** Remove o toque customizado, voltando ao beep padrão gerado pelo app. */
export async function clearCustomSound() {
  return storage.remove(STORAGE_KEYS.CUSTOM_SOUND);
}

/** @returns {Promise<'light'|'dark'|null>} tema escolhido manualmente pelo usuário (ou null se nunca escolheu — quem chama deve cair para a preferência do sistema) */
export async function loadTheme() {
  return storage.get(STORAGE_KEYS.THEME);
}

/** @param {'light'|'dark'} theme */
export async function saveTheme(theme) {
  return storage.set(STORAGE_KEYS.THEME, theme);
}

/** Apaga todos os dados do app (configurações, sessões, snapshots, estado). */
export async function clearAllData() {
  return storage.clear();
}

/** @returns {Promise<Array<string>>} assuntos já digitados pelo usuário (nunca null, sempre array) */
export async function loadKnownSubjects() {
  const subjects = await storage.get(STORAGE_KEYS.KNOWN_SUBJECTS);
  return Array.isArray(subjects) ? subjects : [];
}

/** @param {Array<string>} subjects */
export async function saveKnownSubjects(subjects) {
  return storage.set(STORAGE_KEYS.KNOWN_SUBJECTS, subjects);
}
(function fileStorageBridge(global) {
  const STORAGE_URL = "/__shaker__/storage";
  const MANIFEST_KEY = "__shaker_file_storage_manifest__";
  const MAX_INIT_RETRIES = 6;
  const RETRY_DELAY_MS = 1200;
  const PULL_SYNC_INTERVAL_MS = 2500;
  let bridgeEnabled = false;
  let patchApplied = false;
  let internalWrite = false;
  let initAttemptCount = 0;
  let persistQueue = Promise.resolve(false);
  let pullSyncTimerId = null;

  function parseJsonSafely(text, fallback = null) {
    try {
      return JSON.parse(String(text || ""));
    } catch (error) {
      return fallback;
    }
  }

  function readManifest() {
    const raw = global.localStorage.getItem(MANIFEST_KEY);
    const parsed = parseJsonSafely(raw, []);
    return Array.isArray(parsed) ? parsed : [];
  }

  function writeManifest(keys) {
    global.localStorage.setItem(MANIFEST_KEY, JSON.stringify(keys));
  }

  function applySnapshot(snapshot) {
    const storage = snapshot && typeof snapshot === "object" ? snapshot : {};
    const keys = Object.keys(storage);
    const previousKeys = readManifest();

    internalWrite = true;
    try {
      previousKeys.forEach((key) => {
        if (!Object.prototype.hasOwnProperty.call(storage, key)) {
          global.localStorage.removeItem(key);
        }
      });

      keys.forEach((key) => {
        global.localStorage.setItem(key, String(storage[key] ?? ""));
      });

      writeManifest(keys);
    } finally {
      internalWrite = false;
    }
  }

  function buildSnapshot() {
    const snapshot = {};
    for (let index = 0; index < global.localStorage.length; index += 1) {
      const key = global.localStorage.key(index);
      if (!key || key === MANIFEST_KEY) continue;
      snapshot[key] = global.localStorage.getItem(key);
    }
    return snapshot;
  }

  async function request(method, payload) {
    const response = await global.fetch(STORAGE_URL, {
      method,
      cache: "no-store",
      credentials: "same-origin",
      headers: method === "GET"
        ? { "Cache-Control": "no-store" }
        : {
            "Cache-Control": "no-store",
            "Content-Type": "application/json; charset=utf-8"
          },
      body: payload ? JSON.stringify(payload) : undefined
    });

    if (!response.ok) {
      throw new Error(`Storage request failed with ${response.status}`);
    }

    return response.json();
  }

  function persistSnapshot() {
    if (!bridgeEnabled || internalWrite) return Promise.resolve(false);
    persistQueue = persistQueue.catch(() => false).then(() => request("POST", { storage: buildSnapshot() }).then(() => {
      global.dispatchEvent(new CustomEvent("shaker-storage-status-changed"));
      return true;
    }).catch(() => {
      bridgeEnabled = false;
      scheduleRetry();
      global.dispatchEvent(new CustomEvent("shaker-storage-status-changed"));
      return false;
    }));
    return persistQueue;
  }

  function patchStorageMethods() {
    if (patchApplied || !global.Storage || !global.localStorage) return;

    const originalSetItem = Storage.prototype.setItem;
    const originalRemoveItem = Storage.prototype.removeItem;
    const originalClear = Storage.prototype.clear;

    Storage.prototype.setItem = function patchedSetItem(key, value) {
      const result = originalSetItem.call(this, key, value);
      if (this === global.localStorage && key !== MANIFEST_KEY) {
        persistSnapshot();
      }
      return result;
    };

    Storage.prototype.removeItem = function patchedRemoveItem(key) {
      const result = originalRemoveItem.call(this, key);
      if (this === global.localStorage && key !== MANIFEST_KEY) {
        persistSnapshot();
      }
      return result;
    };

    Storage.prototype.clear = function patchedClear() {
      const result = originalClear.call(this);
      if (this === global.localStorage) {
        persistSnapshot();
      }
      return result;
    };

    patchApplied = true;
  }

  function parseStoredValue(value) {
    const text = String(value ?? "");
    const trimmed = text.trim();
    if (!trimmed) return text;
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      const parsed = parseJsonSafely(trimmed, null);
      if (parsed !== null) return parsed;
    }
    return text;
  }

  function scoreValue(value) {
    if (value == null) return 0;
    if (Array.isArray(value)) return value.length * 10;
    if (typeof value === "object") return Object.keys(value).length * 5;
    if (typeof value === "string") return value.trim() ? value.length : 0;
    if (typeof value === "number") return value === 0 ? 0 : 1;
    if (typeof value === "boolean") return value ? 1 : 0;
    return 0;
  }

  function choosePreferredValue(localValue, remoteValue) {
    const parsedLocal = parseStoredValue(localValue);
    const parsedRemote = parseStoredValue(remoteValue);
    return scoreValue(parsedLocal) > scoreValue(parsedRemote) ? localValue : remoteValue;
  }

  function mergeSnapshots(localSnapshot, remoteSnapshot) {
    const merged = { ...(remoteSnapshot || {}) };
    Object.keys(localSnapshot || {}).forEach((key) => {
      if (!Object.prototype.hasOwnProperty.call(merged, key)) {
        merged[key] = localSnapshot[key];
        return;
      }
      merged[key] = choosePreferredValue(localSnapshot[key], merged[key]);
    });
    return merged;
  }

  function snapshotsEqual(left, right) {
    return JSON.stringify(left || {}) === JSON.stringify(right || {});
  }

  async function pullLatestSnapshot() {
    if (!bridgeEnabled || internalWrite) return false;

    try {
      const response = await request("GET");
      if (!response || response.ok !== true || response.fileBacked !== true) {
        return false;
      }

      const remoteSnapshot = response.storage && typeof response.storage === "object" ? response.storage : {};
      const localSnapshot = buildSnapshot();
      if (snapshotsEqual(localSnapshot, remoteSnapshot)) {
        return false;
      }

      applySnapshot(remoteSnapshot);
      global.dispatchEvent(new CustomEvent("shaker-storage-status-changed"));
      return true;
    } catch (error) {
      bridgeEnabled = false;
      scheduleRetry();
      global.dispatchEvent(new CustomEvent("shaker-storage-status-changed"));
      return false;
    }
  }

  function ensurePullSync() {
    if (pullSyncTimerId || !global.setInterval) return;
    pullSyncTimerId = global.setInterval(() => {
      if (global.document?.hidden) return;
      pullLatestSnapshot();
    }, PULL_SYNC_INTERVAL_MS);
  }

  async function initialize() {
    if (!global.localStorage) return;

    try {
      const response = await request("GET");
      if (!response || response.ok !== true || response.fileBacked !== true) {
        scheduleRetry();
        return;
      }

      const localSnapshot = buildSnapshot();
      const remoteSnapshot = response.storage && typeof response.storage === "object" ? response.storage : {};
      const mergedSnapshot = mergeSnapshots(localSnapshot, remoteSnapshot);

      applySnapshot(mergedSnapshot);
      bridgeEnabled = true;
      patchStorageMethods();
      ensurePullSync();

      const mergedChanged = JSON.stringify(mergedSnapshot) !== JSON.stringify(remoteSnapshot);
      if (mergedChanged || (Object.keys(remoteSnapshot).length === 0 && global.localStorage.length > 0)) {
        persistSnapshot();
      }

      global.dispatchEvent(new CustomEvent("shaker-storage-status-changed"));
    } catch (error) {
      bridgeEnabled = false;
      scheduleRetry();
    }
  }

  function scheduleRetry() {
    if (bridgeEnabled) return;
    if (initAttemptCount >= MAX_INIT_RETRIES) return;
    initAttemptCount += 1;
    global.setTimeout(() => {
      initialize();
    }, RETRY_DELAY_MS);
  }

  initialize();
  global.addEventListener("focus", () => {
    pullLatestSnapshot();
  });
  global.document?.addEventListener("visibilitychange", () => {
    if (!global.document.hidden) {
      pullLatestSnapshot();
    }
  });

  global.ShakerFileStorage = {
    isFileBacked() {
      return bridgeEnabled;
    },
    persistNow() {
      return persistSnapshot();
    },
    pullNow() {
      return pullLatestSnapshot();
    }
  };
})(window);

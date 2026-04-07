(function serverSession(global) {
  const MANAGEMENT_ROOT = "/__shaker__";
  const CONFIG_URL = `${MANAGEMENT_ROOT}/config`;
  const REGISTER_URL = `${MANAGEMENT_ROOT}/register`;
  const RELEASE_URL = `${MANAGEMENT_ROOT}/release`;
  const SHUTDOWN_URL = `${MANAGEMENT_ROOT}/shutdown`;
  const WINDOW_ID_KEY = "shaker_server_window_id";
  const MAX_START_RETRIES = 6;
  const START_RETRY_MS = 1200;

  let serverConfig = null;
  let serverConfigPromise = null;
  let registered = false;
  let releaseSent = false;
  let shutdownRequested = false;
  let managementUnavailable = false;
  let startAttemptCount = 0;

  function canManageServer() {
    const protocol = String(global.location?.protocol || "").toLowerCase();
    return protocol === "http:" || protocol === "https:";
  }

  function getWindowId() {
    try {
      const existing = global.sessionStorage.getItem(WINDOW_ID_KEY);
      if (existing) return existing;

      const generated = global.crypto?.randomUUID
        ? global.crypto.randomUUID()
        : `shaker-${Date.now()}-${Math.random().toString(16).slice(2)}`;

      global.sessionStorage.setItem(WINDOW_ID_KEY, generated);
      return generated;
    } catch (error) {
      return `shaker-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    }
  }

  async function requestJson(url, options = {}) {
    const response = await global.fetch(url, {
      cache: "no-store",
      credentials: "same-origin",
      ...options
    });

    if (!response.ok) {
      const error = new Error(`Request failed: ${response.status}`);
      error.status = response.status;
      throw error;
    }

    return response.json();
  }

  function sendBeaconRequest(url) {
    if (!global.navigator?.sendBeacon) return false;

    try {
      return global.navigator.sendBeacon(url, new Blob([""], { type: "text/plain;charset=UTF-8" }));
    } catch (error) {
      return false;
    }
  }

  function buildActionUrl(baseUrl) {
    const separator = baseUrl.includes("?") ? "&" : "?";
    return `${baseUrl}${separator}clientId=${encodeURIComponent(getWindowId())}`;
  }

  async function loadServerConfig() {
    if (!canManageServer()) return null;
    if (managementUnavailable) return null;
    if (serverConfig) return serverConfig;
    if (serverConfigPromise) return serverConfigPromise;

    serverConfigPromise = requestJson(CONFIG_URL)
      .then((config) => {
        serverConfig = config && typeof config === "object" ? config : null;
        managementUnavailable = !(serverConfig && serverConfig.managed === true);
        return serverConfig;
      })
      .catch((error) => {
        const status = Number(error?.status || 0);
        if (status === 404 || status === 405 || status === 501) {
          managementUnavailable = true;
        }
        return null;
      })
      .finally(() => {
        serverConfigPromise = null;
      });

    return serverConfigPromise;
  }

  async function registerCurrentWindow() {
    const config = await loadServerConfig();
    if (!config || config.managed !== true || shutdownRequested) return false;
    if (registered) return true;

    try {
      await requestJson(buildActionUrl(REGISTER_URL), { method: "POST", keepalive: true });
      registered = true;
      releaseSent = false;
      return true;
    } catch (error) {
      const status = Number(error?.status || 0);
      if (status === 404 || status === 405 || status === 501) {
        managementUnavailable = true;
        serverConfig = { managed: false };
      }
      return false;
    }
  }

  async function releaseCurrentWindow(reason = "pagehide") {
    const config = await loadServerConfig();
    if (!config || config.managed !== true || !registered || shutdownRequested || releaseSent) return false;

    releaseSent = true;
    registered = false;
    const releaseUrl = `${buildActionUrl(RELEASE_URL)}&reason=${encodeURIComponent(reason)}`;

    if (sendBeaconRequest(releaseUrl)) {
      return true;
    }

    try {
      await global.fetch(releaseUrl, {
        method: "POST",
        keepalive: true,
        cache: "no-store",
        credentials: "same-origin"
      });
      return true;
    } catch (error) {
      const status = Number(error?.status || 0);
      if (status === 404 || status === 405 || status === 501) {
        managementUnavailable = true;
        serverConfig = { managed: false };
      }
      return false;
    }
  }

  async function shutdownServer(reason = "logout") {
    const config = await loadServerConfig();
    if (!config || config.managed !== true) return false;

    shutdownRequested = true;
    registered = false;
    releaseSent = true;

    const shutdownUrl = `${SHUTDOWN_URL}?reason=${encodeURIComponent(reason)}`;
    try {
      const response = await global.fetch(shutdownUrl, {
        method: "POST",
        keepalive: true,
        cache: "no-store",
        credentials: "same-origin"
      });
      if (!response.ok) {
        if (response.status === 404 || response.status === 405 || response.status === 501) {
          managementUnavailable = true;
          serverConfig = { managed: false };
          return false;
        }
        return false;
      }
      return true;
    } catch (error) {
      const status = Number(error?.status || 0);
      if (status === 404 || status === 405 || status === 501) {
        managementUnavailable = true;
        serverConfig = { managed: false };
        return false;
      }
      return sendBeaconRequest(shutdownUrl);
    }
  }

  function prepareForcedLoginLaunch() {
    try {
      const url = new URL(global.location.href);
      const forceLogin = url.searchParams.get("forceLogin") === "1";
      if (!forceLogin) return false;

      if (typeof global.clearAuthentication === "function") {
        global.clearAuthentication();
      }

      url.searchParams.delete("forceLogin");
      url.searchParams.delete("source");
      const cleanUrl = `${url.pathname}${url.search}${url.hash}`;
      global.history.replaceState(null, "", cleanUrl || "index.html");
      return true;
    } catch (error) {
      return false;
    }
  }

  function installLifecycleHandlers() {
    global.addEventListener("pagehide", () => {
      releaseCurrentWindow("pagehide");
    });

    global.addEventListener("beforeunload", () => {
      releaseCurrentWindow("beforeunload");
    });
  }

  function start() {
    if (!canManageServer()) return;
    registerCurrentWindow().finally(() => {
      global.dispatchEvent(new CustomEvent("shaker-storage-status-changed"));
      if (!registered && !shutdownRequested && startAttemptCount < MAX_START_RETRIES) {
        startAttemptCount += 1;
        global.setTimeout(start, START_RETRY_MS);
      }
    });
  }

  installLifecycleHandlers();
  global.addEventListener("DOMContentLoaded", start);

  global.ShakerServerSession = {
    loadServerConfig,
    prepareForcedLoginLaunch,
    registerCurrentWindow,
    releaseCurrentWindow,
    shutdownServer,
    supportsManagedShutdown() {
      return !managementUnavailable && !!(serverConfig && serverConfig.managed === true);
    }
  };
})(window);

(function authModule(global) {
  const AUTH_STORAGE_KEY = "digidat_invoice_auth";
  const AUTH_CREDENTIALS_KEY = "digidat_invoice_credentials";
  const DEFAULT_USERNAME = "admin";
  const DEFAULT_PASSWORD = "admin123";

  function normalizeUsername(value) {
    return String(value || "").trim();
  }

  function getAuthDefaults() {
    return {
      username: DEFAULT_USERNAME,
      password: DEFAULT_PASSWORD
    };
  }

  function getStoredCredentials() {
    try {
      const raw = localStorage.getItem(AUTH_CREDENTIALS_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return null;

      const username = normalizeUsername(parsed.username);
      const password = String(parsed.password || "");

      if (!username || !password) return null;
      return { username, password };
    } catch (error) {
      return null;
    }
  }

  function setLoginCredentials(username, password) {
    const safeUsername = normalizeUsername(username);
    const safePassword = String(password || "");

    if (!safeUsername || !safePassword) return false;

    localStorage.setItem(
      AUTH_CREDENTIALS_KEY,
      JSON.stringify({
        username: safeUsername,
        password: safePassword
      })
    );

    return true;
  }

  function getLoginCredentials() {
    const existing = getStoredCredentials();
    if (existing) return existing;

    const defaults = getAuthDefaults();
    setLoginCredentials(defaults.username, defaults.password);
    return defaults;
  }

  function getAuthRecord() {
    try {
      const raw = localStorage.getItem(AUTH_STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return null;
      if (!parsed.username || parsed.active !== true) return null;
      return parsed;
    } catch (error) {
      return null;
    }
  }

  function isAuthenticated() {
    return !!getAuthRecord();
  }

  function setAuthenticatedUser(username) {
    const safeUsername = String(username || "").trim();
    if (!safeUsername) return;
    localStorage.setItem(
      AUTH_STORAGE_KEY,
      JSON.stringify({
        username: safeUsername,
        active: true,
        loginAt: new Date().toISOString()
      })
    );
  }

  function clearAuthentication() {
    localStorage.removeItem(AUTH_STORAGE_KEY);
  }

  function validateLoginCredentials(username, password) {
    const credentials = getLoginCredentials();
    return (
      normalizeUsername(username) === credentials.username &&
      String(password || "") === credentials.password
    );
  }

  function changePassword(currentPassword, newPassword) {
    const credentials = getLoginCredentials();
    const current = String(currentPassword || "");
    const next = String(newPassword || "");

    if (current !== credentials.password) {
      return { ok: false, message: "Current password is incorrect." };
    }

    if (next.length < 6) {
      return { ok: false, message: "New password must be at least 6 characters." };
    }

    if (next === current) {
      return { ok: false, message: "New password must be different from current password." };
    }

    const saved = setLoginCredentials(credentials.username, next);
    if (!saved) {
      return { ok: false, message: "Unable to save password. Try again." };
    }

    return { ok: true };
  }

  getLoginCredentials();

  global.AUTH_STORAGE_KEY = AUTH_STORAGE_KEY;
  global.AUTH_CREDENTIALS_KEY = AUTH_CREDENTIALS_KEY;
  global.getAuthRecord = getAuthRecord;
  global.isAuthenticated = isAuthenticated;
  global.setAuthenticatedUser = setAuthenticatedUser;
  global.clearAuthentication = clearAuthentication;
  global.validateLoginCredentials = validateLoginCredentials;
  global.getLoginCredentials = getLoginCredentials;
  global.setLoginCredentials = setLoginCredentials;
  global.changePassword = changePassword;
  global.getAuthDefaults = getAuthDefaults;
})(window);

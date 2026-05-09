/**
 * Google Identity Services integration.
 * Renders the sign-in button, captures the ID token, exposes window.AUTH.
 *
 * "Stay signed in" model:
 *   - Google's own ID tokens carry a ~1h `exp`; we can't extend that.
 *   - We keep an APP-LEVEL session window of 24h, anchored to the original
 *     sign-in. While inside that window we silently refresh the token via
 *     GIS auto_select (no user click) every ~50 min, so the cached token
 *     stays accepted by the backend.
 *   - If the user's Google session itself ends inside that 24h, the silent
 *     refresh will fail and we fall back to the interactive sign-in button.
 *
 * Configure OAUTH_CLIENT_ID and API_URL in app.js (CONFIG object).
 */

window.AUTH = (function () {
  const STORAGE_KEY    = 'roadmap_idToken_v1';
  const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 h "stay signed in" window
  const REFRESH_PERIOD = 50 * 60 * 1000;       // refresh ~10 min before exp

  let idToken = null;
  let email = null;
  let clientId = null;
  let onAuthorized = null;
  let onUnauthorized = null;
  let refreshTimer = null;
  let gisInitialized = false;
  // When refreshToken() is called, we stash the resolver here so the next
  // GIS credential callback can settle it. Coalesces concurrent callers.
  let pendingRefresh = null;

  function init(opts) {
    clientId = opts.clientId;
    onAuthorized = opts.onSignIn;
    onUnauthorized = opts.onError;

    const cached = readCachedToken();

    if (cached && cached.jwtFresh) {
      // Cached JWT still valid → skip GIS entirely on boot
      idToken = cached.token;
      email = cached.email;
      if (onAuthorized) onAuthorized(email, idToken);
      scheduleSilentRefresh(REFRESH_PERIOD);
      return;
    }

    if (cached) {
      // Inside 24h window but JWT is stale → attempt silent re-auth before
      // surfacing any sign-in UI. If silent fails GIS will show the button.
      ensureGISReady(() => {
        google.accounts.id.prompt(); // auto_select handles the silent path
      });
      return;
    }

    // No usable cache → full interactive flow
    ensureGISReady(() => {
      google.accounts.id.renderButton(
        document.getElementById('googleBtn'),
        { theme: 'outline', size: 'large', text: 'signin_with', width: 280 }
      );
      google.accounts.id.prompt();
    });
  }

  function ensureGISReady(after) {
    function tryRender() {
      if (!window.google || !window.google.accounts || !window.google.accounts.id) {
        return setTimeout(tryRender, 100);
      }
      if (!gisInitialized) {
        google.accounts.id.initialize({
          client_id: clientId,
          callback: handleCredential,
          auto_select: true,
          ux_mode: 'popup'
        });
        gisInitialized = true;
      }
      after();
    }
    tryRender();
  }

  // Schedule a no-UI re-issue via GIS. auto_select reuses the previous
  // account; if the Google session is alive the user sees nothing.
  function scheduleSilentRefresh(delayMs) {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      // Stop refreshing if the 24h app session is over
      if (!withinSessionWindow()) return;
      ensureGISReady(() => google.accounts.id.prompt());
    }, delayMs);
  }

  function withinSessionWindow() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return false;
      const obj = JSON.parse(raw);
      return (Date.now() - (obj.cachedAt || 0)) < SESSION_TTL_MS;
    } catch (_) { return false; }
  }

  function readCachedToken() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const obj = JSON.parse(raw);
      const cachedAt = obj.cachedAt || 0;
      if (Date.now() - cachedAt >= SESSION_TTL_MS) {
        // 24h app-session window has closed — force fresh interactive sign-in
        localStorage.removeItem(STORAGE_KEY);
        return null;
      }
      const claims = parseJwt(obj.token);
      const nowSec = Math.floor(Date.now() / 1000);
      // 60-second buffer so we don't ship a token that expires mid-request
      const jwtFresh = !!(claims.exp && claims.exp - 60 > nowSec);
      return {
        token: obj.token,
        email: (claims.email || '').toLowerCase(),
        jwtFresh
      };
    } catch (_) { /* corrupt — fall through to clear */ }
    localStorage.removeItem(STORAGE_KEY);
    return null;
  }

  function handleCredential(response) {
    const isFirstSignIn = !idToken;
    idToken = response.credential;
    try {
      const payload = parseJwt(idToken);
      email = (payload.email || '').toLowerCase();
      // Preserve the original cachedAt across silent refreshes so the 24h
      // window stays anchored to the user's actual sign-in, not to each
      // background re-issue (otherwise the window would extend forever).
      let anchoredAt = Date.now();
      try {
        const prev = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
        if (prev.cachedAt && (Date.now() - prev.cachedAt) < SESSION_TTL_MS) {
          anchoredAt = prev.cachedAt;
        }
      } catch (_) { /* ignore */ }
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        token: idToken,
        cachedAt: anchoredAt
      }));
      if (isFirstSignIn && onAuthorized) onAuthorized(email, idToken);
      scheduleSilentRefresh(REFRESH_PERIOD);
      // Settle any in-flight refreshToken() awaiter
      if (pendingRefresh) {
        const p = pendingRefresh; pendingRefresh = null;
        p.resolve(idToken);
      }
    } catch (err) {
      if (pendingRefresh) {
        const p = pendingRefresh; pendingRefresh = null;
        p.reject(err);
      }
      if (onUnauthorized) onUnauthorized('Could not parse credential');
    }
  }

  // On-demand silent refresh. Returns a Promise that resolves with the new
  // ID token, or rejects if GIS can't issue one without interaction (e.g.
  // the Google session itself ended). Callers should fall back to a hard
  // sign-in prompt on rejection.
  function refreshToken(timeoutMs) {
    timeoutMs = timeoutMs || 6000;
    if (pendingRefresh) return pendingRefresh.promise; // coalesce
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    pendingRefresh = { promise, resolve, reject };
    const timer = setTimeout(() => {
      if (!pendingRefresh) return;
      const p = pendingRefresh; pendingRefresh = null;
      p.reject(new Error('refresh timeout'));
    }, timeoutMs);
    promise.finally(() => clearTimeout(timer));
    ensureGISReady(() => {
      try { google.accounts.id.prompt(); }
      catch (e) {
        if (pendingRefresh) {
          const p = pendingRefresh; pendingRefresh = null;
          p.reject(e);
        }
      }
    });
    return promise;
  }

  // Called by app.js when the backend rejects our token (e.g., expired or revoked).
  function clearCachedToken() {
    localStorage.removeItem(STORAGE_KEY);
    idToken = null; email = null;
    if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
  }

  function parseJwt(token) {
    const base64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = decodeURIComponent(
      atob(base64).split('').map(c =>
        '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)
      ).join('')
    );
    return JSON.parse(json);
  }

  function getToken() { return idToken; }
  function getEmail() { return email; }

  function signOut() {
    clearCachedToken();
    if (window.google && google.accounts && google.accounts.id) {
      google.accounts.id.disableAutoSelect();
    }
    location.reload();
  }

  return { init, getToken, getEmail, signOut, clearCachedToken, refreshToken };
})();

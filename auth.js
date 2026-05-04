/**
 * Google Identity Services integration.
 * Renders the sign-in button, captures the ID token, exposes window.AUTH.
 *
 * Configure OAUTH_CLIENT_ID and API_URL in app.js (CONFIG object).
 */

window.AUTH = (function () {
  const STORAGE_KEY = 'roadmap_idToken_v1';
  let idToken = null;
  let email = null;
  let onAuthorized = null;   // callback(email, token)
  let onUnauthorized = null; // callback(message)

  function init({ clientId, onSignIn, onError }) {
    onAuthorized = onSignIn;
    onUnauthorized = onError;

    // Try cached token first — skips Google sign-in entirely if still valid.
    const cached = readCachedToken();
    if (cached) {
      idToken = cached.token;
      email = cached.email;
      if (onAuthorized) onAuthorized(email, idToken);
      return;
    }

    function tryRender() {
      if (!window.google || !window.google.accounts || !window.google.accounts.id) {
        return setTimeout(tryRender, 100);
      }
      google.accounts.id.initialize({
        client_id: clientId,
        callback: handleCredential,
        auto_select: true,
        ux_mode: 'popup'
      });
      google.accounts.id.renderButton(
        document.getElementById('googleBtn'),
        { theme: 'outline', size: 'large', text: 'signin_with', width: 280 }
      );
      google.accounts.id.prompt();
    }
    tryRender();
  }

  function readCachedToken() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const obj = JSON.parse(raw);
      const claims = parseJwt(obj.token);
      const nowSec = Math.floor(Date.now() / 1000);
      // 60-second buffer so we don't ship a token that expires mid-request
      if (claims.exp && claims.exp - 60 > nowSec) {
        return { token: obj.token, email: (claims.email || '').toLowerCase() };
      }
    } catch (_) { /* corrupt or expired — fall through to clear */ }
    localStorage.removeItem(STORAGE_KEY);
    return null;
  }

  function handleCredential(response) {
    idToken = response.credential;
    try {
      const payload = parseJwt(idToken);
      email = (payload.email || '').toLowerCase();
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ token: idToken }));
      if (onAuthorized) onAuthorized(email, idToken);
    } catch (err) {
      if (onUnauthorized) onUnauthorized('Could not parse credential');
    }
  }

  // Called by app.js when the backend rejects our token (e.g., expired or revoked).
  function clearCachedToken() {
    localStorage.removeItem(STORAGE_KEY);
    idToken = null; email = null;
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

  return { init, getToken, getEmail, signOut, clearCachedToken };
})();

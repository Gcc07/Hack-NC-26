/* Optional configuration. Safe to commit as-is: a Google OAuth *client ID* is public by design.
 * Never put client secrets or API keys in this file.
 *
 * To enable "Sign in with Google" and Google Calendar free/busy import:
 *   1. Create an OAuth client (type: Web application) in Google Cloud Console.
 *   2. Add http://localhost:5000 and http://127.0.0.1:5000 as Authorized JavaScript origins.
 *   3. Paste the client ID below and run `python app.py` (file:// is not allowed by Google).
 */
(function () {
  const host = typeof location !== "undefined" ? location.hostname : "127.0.0.1";
  const local = host === "localhost" || host === "127.0.0.1";
  // Local: meadow bridge on :5055. Deployed: nginx /imessage/ → 127.0.0.1:5055
  const bridge = local
    ? "http://127.0.0.1:5055"
    : typeof location !== "undefined"
      ? location.origin + "/imessage"
      : "";

  window.MEADOW_CONFIG = {
    GOOGLE_CLIENT_ID: "",
    IMESSAGE_BRIDGE_URL: bridge,
  };
})();

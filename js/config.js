/* Optional client configuration. Never put secrets or API keys in this file.
 * Google sign-in is configured on the server (.env), not here.
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
    IMESSAGE_BRIDGE_URL: bridge,
  };
})();

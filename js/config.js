/* Optional configuration. Safe to commit as-is: a Google OAuth *client ID* is public by design.
 * Never put client secrets or API keys in this file.
 *
 * To enable "Sign in with Google" and Google Calendar free/busy import:
 *   1. Create an OAuth client (type: Web application) in Google Cloud Console.
 *   2. Add http://localhost:8080 as an Authorized JavaScript origin.
 *   3. Paste the client ID below and serve the app with `./serve.ps1` (file:// is not allowed by Google).
 */
window.MEADOW_CONFIG = {
  GOOGLE_CLIENT_ID: '',
};

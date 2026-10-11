"""Accounts, 3-hour sessions, and Sign in with Google.

Password accounts: usernames are unique (case-insensitive) and passwords are
stored only as scrypt hashes. Sessions are random 256-bit tokens in an HttpOnly
cookie; only their SHA-256 hash is stored. Every session expires 3 hours after
login.

Google: OAuth 2.0 authorization code flow with PKCE, state and nonce, run on the
server so the client secret and refresh token never reach the browser. The same
consent screen asks for Google Calendar free/busy access. The refresh token is
encrypted (Fernet) before it is stored.
"""

from __future__ import annotations

import base64
import hashlib
import json
import re
import secrets
import unicodedata
from collections import defaultdict, deque
from datetime import datetime, timedelta, timezone
from threading import Lock
from time import monotonic, time
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlparse
from urllib.request import Request, urlopen

from flask import Blueprint, current_app, g, jsonify, redirect, request, url_for
from itsdangerous import BadSignature, URLSafeTimedSerializer
from werkzeug.security import check_password_hash, generate_password_hash

from .auth_store import GoogleAccountTaken, UsernameTaken
from .models import ValidationError, validate
from .repository import MissingRecord, VersionConflict

auth_api = Blueprint("auth", __name__, url_prefix="/api/auth")

SESSION_TTL = timedelta(hours=3)
SESSION_COOKIE = "meadow_session"
OAUTH_COOKIE = "meadow_oauth"
OAUTH_TTL = 600
USERNAME = re.compile(r"[A-Za-z0-9_]{3,32}")
PASSWORD_MIN, PASSWORD_MAX = 8, 128
COMMON_PASSWORDS = {"password", "password1", "password123", "12345678", "123456789",
                    "1234567890", "qwerty123", "qwertyuiop", "iloveyou", "11111111",
                    "abc12345", "letmein1", "welcome1", "meadow123", "00000000"}

GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke"
GOOGLE_FREEBUSY_URL = "https://www.googleapis.com/calendar/v3/freeBusy"
GOOGLE_ISSUERS = {"https://accounts.google.com", "accounts.google.com"}
CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.freebusy"
GOOGLE_SCOPES = f"openid email profile {CALENDAR_SCOPE}"
FREEBUSY_DAYS = 60

# Comparing against a real hash keeps unknown-username logins as slow as wrong passwords.
_DUMMY_HASH = generate_password_hash(secrets.token_urlsafe(16))
PUBLIC_PATHS = {"/api", "/api/health", "/api/ai/status", "/api/auth/config", "/api/auth/signup", "/api/auth/login",
                "/api/auth/logout", "/api/auth/google/start", "/api/auth/google/callback"}


class GoogleError(RuntimeError):
    pass


class Throttle:
    """Sliding-window counter per key. Process-local, which matches the one-worker deployment."""

    def __init__(self):
        self._hits: dict[str, deque] = defaultdict(deque)
        self._lock = Lock()

    def _trim(self, key, window):
        hits, cutoff = self._hits[key], monotonic() - window
        while hits and hits[0] < cutoff:
            hits.popleft()
        return hits

    def blocked(self, key, limit, window):
        with self._lock:
            return len(self._trim(key, window)) >= limit

    def hit(self, key):
        with self._lock:
            self._hits[key].append(monotonic())

    def clear(self, key):
        with self._lock:
            self._hits.pop(key, None)


def now_utc():
    return datetime.now(timezone.utc)


def _store():
    return current_app.extensions["auth_store"]


def _repo():
    return current_app.extensions["repository"]


def _throttle() -> Throttle:
    return current_app.extensions["auth_throttle"]


def _token_hash(token):
    return hashlib.sha256(token.encode()).digest()


def _secure_cookies():
    return bool(current_app.config.get("AUTH_COOKIE_SECURE")) or request.is_secure


def _too_many(message="Too many attempts. Wait a few minutes and try again."):
    response = jsonify(error={"code": "rate_limited", "message": message})
    response.status_code = 429
    response.headers["Retry-After"] = "300"
    return response


def _error(status, code, message):
    response = jsonify(error={"code": code, "message": message})
    response.status_code = status
    return response


# ------------------------------------------------------------------ request gate

def current_session():
    """(account, expires_at) for the request's session cookie, or None."""
    token = request.cookies.get(SESSION_COOKIE, "")
    if not token or len(token) > 128:
        return None
    return _store().session_account(_token_hash(token), now_utc())


def guard_api():
    """before_request: same-origin check for writes, then require a live session."""
    if not request.path.startswith("/api"):
        return None
    if request.method not in ("GET", "HEAD", "OPTIONS"):
        origin = request.headers.get("Origin")
        if origin and urlparse(origin).netloc != request.host:
            return _error(403, "bad_origin", "Cross-site requests are not allowed.")
    if request.path.rstrip("/") in PUBLIC_PATHS or request.path in PUBLIC_PATHS:
        return None
    # Trusted server-side bridge (meadow/Spectrum) — never exposed to the browser.
    bridge_secret = current_app.config.get("BRIDGE_SECRET") or ""
    if bridge_secret and request.headers.get("X-Meadow-Bridge") == bridge_secret:
        return None
    found = current_session()
    if found is None:
        return _error(401, "unauthenticated", "Sign in to continue.")
    g.account, g.session_expires = found
    return None


def _start_session(response, account):
    """Issue a new session cookie on response. Returns the expiry (3 hours from now)."""
    expires = now_utc() + SESSION_TTL
    token = secrets.token_urlsafe(32)
    store = _store()
    store.purge_expired(now_utc())
    store.create_session(_token_hash(token), account["id"], expires)
    response.set_cookie(SESSION_COOKIE, token, max_age=int(SESSION_TTL.total_seconds()),
                        expires=expires, httponly=True, secure=_secure_cookies(),
                        samesite="Lax", path="/")
    return expires


def _signed_in(account, status=200):
    response = jsonify()
    expires = _start_session(response, account)
    response.set_data(json.dumps({"account": _me(account, expires)}))
    response.status_code = status
    response.headers["Cache-Control"] = "no-store"
    return response


def _clear_session(response):
    token = request.cookies.get(SESSION_COOKIE, "")
    if token and len(token) <= 128:
        _store().delete_session(_token_hash(token))
    response.delete_cookie(SESSION_COOKIE, path="/", httponly=True, secure=_secure_cookies(), samesite="Lax")


# ------------------------------------------------------------------ profiles

def _profile(name, email="", photo=""):
    body = {"name": name, "email": email, "photo": photo, "presence": "online",
            "lastSeen": int(time() * 1000)}
    return _repo().create("users", validate("users", body))


def _modify_user(user_id, change, attempts=3):
    """Read-modify-write a profile with the repository's version check."""
    repo = _repo()
    for _ in range(attempts):
        record = repo.get("users", user_id)
        data = {k: v for k, v in record.items() if k not in ("id", "createdAt", "updatedAt", "version")}
        change(data)
        try:
            return repo.replace("users", user_id, data, record["version"])
        except VersionConflict:
            continue
    raise VersionConflict


def ensure_profile(account):
    """The shared state can be reset by any member; an account always keeps a profile."""
    try:
        _repo().get("users", account["user_id"])
        return account
    except MissingRecord:
        name = account["username"] or (account["email"].split("@")[0] if account["email"] else "Meadow user")
        user = _profile(name, account["email"] or "")
        return _store().update(account["id"], user_id=user["id"])


def _me(account, expires_at):
    return {
        "userId": account["user_id"],
        "username": account["username"],
        "email": account["email"] or "",
        "provider": "password" if account["username"] else "google",
        "google": bool(account["google_sub"]),
        "googleCalendar": bool(account["google_refresh_token"]) and CALENDAR_SCOPE in (account["google_scope"] or "").split(),
        "expiresAt": int(expires_at.timestamp() * 1000),
    }


# ------------------------------------------------------------------ input checks

def _json_body():
    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        raise ValidationError("Send a JSON object.")
    return body


def _string(body, key, label):
    value = body.get(key)
    if not isinstance(value, str):
        raise ValidationError(f"{label} is required.")
    return value


def clean_name(value):
    name = " ".join(value.split())
    if not 1 <= len(name) <= 60:
        raise ValidationError("Display name must be 1–60 characters.")
    if any(unicodedata.category(c).startswith("C") for c in name):
        raise ValidationError("Display name contains invalid characters.")
    return name


def check_username(value):
    if not USERNAME.fullmatch(value):
        raise ValidationError("Username must be 3–32 letters, numbers or underscores.")
    return value


def check_password(password, username):
    if not PASSWORD_MIN <= len(password) <= PASSWORD_MAX:
        raise ValidationError(f"Password must be {PASSWORD_MIN}–{PASSWORD_MAX} characters.")
    if not password.strip():
        raise ValidationError("Password cannot be only spaces.")
    if password.lower() == username.lower() or password.lower() in COMMON_PASSWORDS:
        raise ValidationError("That password is too easy to guess. Pick another.")
    if "\x00" in password:
        raise ValidationError("Password contains invalid characters.")
    return password


# ------------------------------------------------------------------ password accounts

@auth_api.get("/config")
def config():
    return jsonify(google=google_configured())


@auth_api.post("/signup")
def signup():
    ip_key = "signup:" + (request.remote_addr or "?")
    if _throttle().blocked(ip_key, 20, 3600):
        return _too_many("Too many new accounts from this network. Try again later.")
    body = _json_body()
    username = check_username(_string(body, "username", "Username"))
    password = check_password(_string(body, "password", "Password"), username)
    name = clean_name(_string(body, "name", "Display name"))
    store = _store()
    if store.by_username(username):
        return _error(409, "username_taken", "That username is already taken.")
    _throttle().hit(ip_key)
    user = _profile(name)
    try:
        account = store.create_account(user_id=user["id"], username=username,
                                       password_hash=generate_password_hash(password))
    except UsernameTaken:
        _repo().delete("users", user["id"])
        return _error(409, "username_taken", "That username is already taken.")
    return _signed_in(account, 201)


@auth_api.post("/login")
def login():
    body = _json_body()
    username, password = body.get("username"), body.get("password")
    if not isinstance(username, str) or not isinstance(password, str):
        raise ValidationError("Username and password are required.")
    ip_key = "login-ip:" + (request.remote_addr or "?")
    user_key = "login-user:" + username.lower()[:64]
    throttle = _throttle()
    if throttle.blocked(ip_key, 50, 900) or throttle.blocked(user_key, 8, 900):
        return _too_many()
    account = None
    if USERNAME.fullmatch(username) and len(password) <= PASSWORD_MAX:
        account = _store().by_username(username)
    valid = check_password_hash(account["password_hash"] if account else _DUMMY_HASH, password[:PASSWORD_MAX])
    if not account or not valid:
        throttle.hit(ip_key)
        throttle.hit(user_key)
        return _error(401, "invalid_credentials", "Incorrect username or password.")
    throttle.clear(user_key)
    return _signed_in(ensure_profile(account))


@auth_api.post("/logout")
def logout():
    response = jsonify(ok=True)
    _clear_session(response)
    return response


@auth_api.get("/me")
def me():
    account = ensure_profile(g.account)
    response = jsonify(account=_me(account, g.session_expires))
    response.headers["Cache-Control"] = "no-store"
    return response


@auth_api.delete("/account")
def delete_account():
    account = g.account
    _revoke_google(account)
    _store().delete_account(account["id"])
    response = jsonify(ok=True)
    response.delete_cookie(SESSION_COOKIE, path="/", httponly=True, secure=_secure_cookies(), samesite="Lax")
    return response


# ------------------------------------------------------------------ Google

def google_configured():
    return bool(current_app.config.get("GOOGLE_CLIENT_ID") and current_app.config.get("GOOGLE_CLIENT_SECRET"))


def _serializer():
    return URLSafeTimedSerializer(current_app.config["SECRET_KEY"], salt="meadow-google-oauth")


def _fernet():
    from cryptography.fernet import Fernet
    secret = current_app.config["SECRET_KEY"].encode()
    key = base64.urlsafe_b64encode(hashlib.sha256(b"meadow-google-refresh-token\0" + secret).digest())
    return Fernet(key)


def _encrypt(token):
    return _fernet().encrypt(token.encode()).decode() if token else None


def _decrypt(value):
    from cryptography.fernet import InvalidToken
    if not value:
        return None
    try:
        return _fernet().decrypt(value.encode()).decode()
    except InvalidToken:
        return None  # The secret key changed; the user has to grant access again.


def _redirect_uri():
    return current_app.config.get("GOOGLE_REDIRECT_URI") or url_for("auth.google_callback", _external=True)


def _http_json(url, *, form=None, body=None, token=None):
    headers = {"Accept": "application/json"}
    data = None
    if form is not None:
        data = urlencode(form).encode()
        headers["Content-Type"] = "application/x-www-form-urlencoded"
    elif body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = "Bearer " + token
    try:
        with urlopen(Request(url, data=data, headers=headers), timeout=10) as response:
            raw = response.read(1_000_000)
            return json.loads(raw) if raw.strip() else {}
    except HTTPError as error:
        try:
            detail = json.loads(error.read(10_000)).get("error", "")
        except ValueError:
            detail = ""
        raise GoogleError(detail if isinstance(detail, str) else f"HTTP {error.code}") from None
    except (URLError, TimeoutError, ValueError, OSError):
        raise GoogleError("unreachable") from None


def _b64url(value):
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def verify_id_token(id_token, nonce):
    """Validate claims of an ID token received directly from Google's token endpoint.

    The token came over TLS from Google in exchange for our client secret, so per
    OpenID Connect Core 3.1.3.7 and Google's guide the signature check may be
    skipped; issuer, audience, expiry and nonce are still enforced.
    """
    try:
        claims = json.loads(_b64url(id_token.split(".")[1]))
    except (AttributeError, IndexError, ValueError):
        raise GoogleError("malformed id_token") from None
    if not isinstance(claims, dict):
        raise GoogleError("malformed id_token")
    if claims.get("iss") not in GOOGLE_ISSUERS or claims.get("aud") != current_app.config["GOOGLE_CLIENT_ID"]:
        raise GoogleError("id_token issuer or audience mismatch")
    if not isinstance(claims.get("exp"), (int, float)) or claims["exp"] < time() - 60:
        raise GoogleError("id_token expired")
    if not isinstance(claims.get("nonce"), str) or not secrets.compare_digest(claims["nonce"], nonce):
        raise GoogleError("id_token nonce mismatch")
    if not isinstance(claims.get("sub"), str) or not claims["sub"]:
        raise GoogleError("id_token has no subject")
    return claims


def import_freebusy(user_id, access_token):
    now = now_utc()
    result = _http_json(GOOGLE_FREEBUSY_URL, token=access_token, body={
        "timeMin": now.isoformat().replace("+00:00", "Z"),
        "timeMax": (now + timedelta(days=FREEBUSY_DAYS)).isoformat().replace("+00:00", "Z"),
        "items": [{"id": "primary"}],
    })
    busy = []
    for block in ((result.get("calendars") or {}).get("primary") or {}).get("busy") or []:
        try:
            start = datetime.fromisoformat(block["start"].replace("Z", "+00:00"))
            end = datetime.fromisoformat(block["end"].replace("Z", "+00:00"))
        except (KeyError, TypeError, AttributeError, ValueError):
            continue
        if end > start:
            busy.append([int(start.timestamp() * 1000), int(end.timestamp() * 1000)])
    busy.sort()
    merged = []
    for start, end in busy:
        if merged and start <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], end)
        else:
            merged.append([start, end])

    def change(user):
        user["busy"] = merged
        user["calendar"] = {"source": "google", "name": "Google Calendar (free/busy)",
                            "importedAt": int(time() * 1000), "count": len(merged)}
    _modify_user(user_id, change)
    return len(merged)


def _revoke_google(account):
    token = _decrypt(account.get("google_refresh_token"))
    if token:
        try:
            _http_json(GOOGLE_REVOKE_URL, form={"token": token})
        except GoogleError:
            pass


def _back(error=None):
    return redirect("/" + ("?" + urlencode({"auth_error": error}) if error else ""))


@auth_api.get("/google/start")
def google_start():
    if not google_configured():
        return _back("google_not_configured")
    link = request.args.get("link") == "1"
    linking = None
    if link:
        found = current_session()
        if found is None:
            return _back("session_expired")
        linking = found[0]["id"]
    state, nonce, verifier = (secrets.token_urlsafe(32) for _ in range(3))
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    params = {
        "client_id": current_app.config["GOOGLE_CLIENT_ID"],
        "redirect_uri": _redirect_uri(),
        "response_type": "code",
        "scope": GOOGLE_SCOPES,
        "state": state,
        "nonce": nonce,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
        "access_type": "offline",
        "include_granted_scopes": "true",
        # Linking (or reconnecting) the calendar must yield a fresh refresh token.
        "prompt": "consent" if link else "select_account",
    }
    response = redirect(GOOGLE_AUTH_URL + "?" + urlencode(params))
    pending = _serializer().dumps({"state": state, "nonce": nonce, "verifier": verifier, "link": linking})
    response.set_cookie(OAUTH_COOKIE, pending, max_age=OAUTH_TTL, httponly=True,
                        secure=_secure_cookies(), samesite="Lax", path="/api/auth/google")
    return response


@auth_api.get("/google/callback")
def google_callback():
    try:
        pending = _serializer().loads(request.cookies.get(OAUTH_COOKIE, ""), max_age=OAUTH_TTL)
    except BadSignature:
        pending = None
    state = request.args.get("state", "")
    if not isinstance(pending, dict) or not state or not secrets.compare_digest(state, pending.get("state", "")):
        return _finish(_back("google_state"))
    if request.args.get("error"):
        return _finish(_back("google_denied"))
    code = request.args.get("code", "")
    if not code or len(code) > 2048:
        return _finish(_back("google_failed"))
    try:
        tokens = _http_json(GOOGLE_TOKEN_URL, form={
            "code": code,
            "client_id": current_app.config["GOOGLE_CLIENT_ID"],
            "client_secret": current_app.config["GOOGLE_CLIENT_SECRET"],
            "redirect_uri": _redirect_uri(),
            "grant_type": "authorization_code",
            "code_verifier": pending["verifier"],
        })
        claims = verify_id_token(tokens.get("id_token"), pending["nonce"])
    except GoogleError as error:
        current_app.logger.warning("Google sign-in failed: %s", error)
        return _finish(_back("google_failed"))
    if claims.get("email_verified") not in (True, "true"):
        return _finish(_back("google_unverified"))

    store = _store()
    email = str(claims.get("email", ""))[:254].lower()
    scope = str(tokens.get("scope", ""))
    google_fields = {"google_scope": scope}
    if tokens.get("refresh_token"):
        google_fields["google_refresh_token"] = _encrypt(tokens["refresh_token"])

    if pending.get("link"):
        account = store.by_id(pending["link"])
        if account is None:
            return _finish(_back("session_expired"))
        try:
            account = store.update(account["id"], google_sub=claims["sub"], **google_fields)
        except GoogleAccountTaken:
            return _finish(_back("google_linked_elsewhere"))
        account = ensure_profile(account)
        response = redirect("/?linked=google#/me")
    else:
        account = store.by_google(claims["sub"])
        if account:
            account = ensure_profile(store.update(account["id"], email=email, **google_fields))
        else:
            account = _create_google_account(claims, email, google_fields)
        response = _back()
        _start_session(response, account)

    access_token = tokens.get("access_token")
    if access_token and CALENDAR_SCOPE in scope.split():
        try:
            import_freebusy(account["user_id"], access_token)
        except (GoogleError, VersionConflict, MissingRecord) as error:
            current_app.logger.warning("Google Calendar import failed: %s", type(error).__name__)
    return _finish(response)


def _create_google_account(claims, email, google_fields):
    try:
        name = clean_name(str(claims.get("name") or "")[:60])
    except ValidationError:
        name = email.split("@")[0][:60] or "Meadow user"
    photo = claims.get("picture") if isinstance(claims.get("picture"), str) and claims["picture"].startswith("https://") else ""
    store, repo = _store(), _repo()
    # A roster import may have created a placeholder for this email; claim it to keep memberships.
    placeholder = next((u for u in repo.list("users") if u.get("placeholder") and email
                        and str(u.get("email", "")).lower() == email and not store.by_user_id(u["id"])), None)
    if placeholder:
        def claim(user):
            user.update(placeholder=False, name=name, email=email, photo=photo)
        user = _modify_user(placeholder["id"], claim)
    else:
        user = _profile(name, email, photo)
    try:
        return store.create_account(user_id=user["id"], google_sub=claims["sub"], email=email, **google_fields)
    except GoogleAccountTaken:  # A parallel callback created it first.
        if not placeholder:
            repo.delete("users", user["id"])
        return store.by_google(claims["sub"])


def _finish(response):
    response.delete_cookie(OAUTH_COOKIE, path="/api/auth/google", httponly=True,
                           secure=_secure_cookies(), samesite="Lax")
    response.headers["Cache-Control"] = "no-store"
    return response


@auth_api.post("/google/calendar/sync")
def google_calendar_sync():
    account = g.account
    refresh_token = _decrypt(account.get("google_refresh_token"))
    if not refresh_token or not google_configured():
        return _error(409, "google_not_connected", "Connect Google Calendar first.")
    try:
        tokens = _http_json(GOOGLE_TOKEN_URL, form={
            "client_id": current_app.config["GOOGLE_CLIENT_ID"],
            "client_secret": current_app.config["GOOGLE_CLIENT_SECRET"],
            "refresh_token": refresh_token,
            "grant_type": "refresh_token",
        })
        count = import_freebusy(account["user_id"], tokens["access_token"])
    except GoogleError as error:
        if str(error) == "invalid_grant":  # Access was revoked in the Google account.
            _store().update(account["id"], google_refresh_token=None, google_scope="")
            return _error(409, "google_not_connected", "Google access was revoked. Connect Google Calendar again.")
        return _error(502, "google_unavailable", "Could not reach Google Calendar. Try again.")
    except KeyError:
        return _error(502, "google_unavailable", "Google did not return an access token.")
    return jsonify(count=count)


@auth_api.post("/google/calendar/disconnect")
def google_calendar_disconnect():
    account = g.account
    _revoke_google(account)
    _store().update(account["id"], google_refresh_token=None, google_scope="")
    return jsonify(ok=True)

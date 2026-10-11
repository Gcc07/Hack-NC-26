import base64
import json
from datetime import timedelta
from urllib.parse import parse_qs, urlparse

import pytest

import backend.auth as auth
from backend import create_app

PASSWORD = "correct horse battery"


@pytest.fixture
def app():
    return create_app({"TESTING": True, "GOOGLE_CLIENT_ID": "client-123.apps.googleusercontent.com",
                       "GOOGLE_CLIENT_SECRET": "shh", "SECRET_KEY": "test-secret",
                       "GOOGLE_REDIRECT_URI": ""})  # ignore a developer's .env override


@pytest.fixture
def client(app):
    return app.test_client()


def signup(client, username="maya_chen", password=PASSWORD, name="Maya Chen"):
    return client.post("/api/auth/signup", json={"username": username, "password": password, "name": name})


def login(client, username="maya_chen", password=PASSWORD):
    return client.post("/api/auth/login", json={"username": username, "password": password})


def test_data_api_requires_a_session(client):
    for path in ["/api/state", "/api/users", "/api/orgs/x/insights", "/api/auth/me"]:
        response = client.get(path)
        assert response.status_code == 401 and response.json["error"]["code"] == "unauthenticated"
    assert client.put("/api/state", json={}).status_code == 401
    assert client.get("/api/health").status_code == 200
    assert client.post("/api/ai/parse", json={"text": "x"}).status_code == 401
    assert client.get("/api/auth/config").json == {"google": True}


def test_signup_creates_account_profile_and_secure_cookie(client, app):
    response = signup(client)
    assert response.status_code == 201
    account = response.json["account"]
    assert account["username"] == "maya_chen" and account["provider"] == "password"
    cookie = response.headers["Set-Cookie"]
    assert "HttpOnly" in cookie and "SameSite=Lax" in cookie and "Max-Age=10800" in cookie
    assert "Path=/" in cookie
    me = client.get("/api/auth/me").json["account"]
    assert me["userId"] == account["userId"]
    profile = client.get("/api/users/" + account["userId"]).json["data"]
    assert profile["name"] == "Maya Chen"
    # Credentials never enter the shared state.
    state = json.dumps(client.get("/api/state").json)
    assert "scrypt" not in state and PASSWORD not in state and "password" not in state
    stored = app.extensions["auth_store"].by_username("maya_chen")
    assert stored["password_hash"].startswith("scrypt:") and PASSWORD not in stored["password_hash"]


@pytest.mark.parametrize("body", [
    {"username": "ab", "password": PASSWORD, "name": "Maya"},
    {"username": "has space", "password": PASSWORD, "name": "Maya"},
    {"username": "x" * 33, "password": PASSWORD, "name": "Maya"},
    {"username": "maya<script>", "password": PASSWORD, "name": "Maya"},
    {"username": "maya", "password": "short", "name": "Maya"},
    {"username": "maya", "password": "x" * 129, "name": "Maya"},
    {"username": "maya", "password": "        ", "name": "Maya"},
    {"username": "maya", "password": "password123", "name": "Maya"},
    {"username": "maya_chen1", "password": "MAYA_CHEN1", "name": "Maya"},
    {"username": "maya", "password": PASSWORD, "name": "   "},
    {"username": "maya", "password": PASSWORD, "name": "x" * 61},
    {"username": "maya", "password": PASSWORD, "name": "Ma\x00ya"},
    {"username": "maya", "password": PASSWORD},
    {"username": 7, "password": PASSWORD, "name": "Maya"},
    {"username": "maya", "password": ["list"], "name": "Maya"},
])
def test_signup_rejects_bad_input_without_side_effects(app, client, body):
    response = client.post("/api/auth/signup", json=body)
    assert response.status_code == 400 and response.json["error"]["code"] == "validation_error"
    assert app.extensions["repository"].list("users") == []
    assert client.get("/api/auth/me").status_code == 401


def test_signup_rejects_non_json(client):
    assert client.post("/api/auth/signup", data="username=maya").status_code == 400
    assert client.post("/api/auth/signup", json=["maya"]).status_code == 400


def test_usernames_are_unique_case_insensitively(app, client):
    assert signup(client).status_code == 201
    other = app.test_client()
    for name in ["maya_chen", "MAYA_CHEN", "Maya_Chen"]:
        response = signup(other, username=name, password="another good one")
        assert response.status_code == 409 and response.json["error"]["code"] == "username_taken"
    assert len(app.extensions["repository"].list("users")) == 1


def test_login_is_separate_from_signup(app):
    client = app.test_client()
    response = login(client, "nobody_here")
    assert response.status_code == 401
    assert app.extensions["repository"].list("users") == []
    signup(app.test_client())
    wrong = login(client, password="wrong password!")
    unknown = login(client, "nobody_here")
    assert wrong.status_code == unknown.status_code == 401
    assert wrong.json == unknown.json  # no username enumeration
    ok = login(client, "MAYA_CHEN")
    assert ok.status_code == 200
    assert client.get("/api/auth/me").json["account"]["username"] == "maya_chen"
    assert len(app.extensions["repository"].list("users")) == 1


def test_sessions_expire_three_hours_after_login(app, monkeypatch):
    client = app.test_client()
    signup(client)
    start = auth.now_utc()
    expires = client.get("/api/auth/me").json["account"]["expiresAt"]
    assert abs(expires / 1000 - (start + timedelta(hours=3)).timestamp()) < 5
    monkeypatch.setattr(auth, "now_utc", lambda: start + timedelta(hours=2, minutes=59))
    assert client.get("/api/state").status_code == 200
    monkeypatch.setattr(auth, "now_utc", lambda: start + timedelta(hours=3, seconds=1))
    assert client.get("/api/state").status_code == 401


def test_logout_revokes_the_token_server_side(app):
    client = app.test_client()
    signup(client)
    token = client.get_cookie("meadow_session").value
    assert client.post("/api/auth/logout").status_code == 200
    assert client.get("/api/state").status_code == 401
    replay = app.test_client()
    replay.set_cookie("meadow_session", token)
    assert replay.get("/api/state").status_code == 401


def test_forged_and_oversized_tokens_are_rejected(client):
    client.set_cookie("meadow_session", "forged")
    assert client.get("/api/state").status_code == 401
    client.set_cookie("meadow_session", "x" * 1000)
    assert client.get("/api/state").status_code == 401


def test_repeated_failed_logins_are_throttled(app):
    signup(app.test_client())
    client = app.test_client()
    for _ in range(8):
        assert login(client, password="wrong password!").status_code == 401
    response = login(client)  # even the right password waits out the lockout
    assert response.status_code == 429 and response.headers["Retry-After"]


def test_cross_site_writes_are_refused(client):
    signup(client)
    response = client.put("/api/state", json={}, headers={"Origin": "https://evil.example"})
    assert response.status_code == 403
    response = client.post("/api/auth/login", json={}, headers={"Origin": "https://evil.example"})
    assert response.status_code == 403
    assert client.put("/api/state", json={}, headers={"Origin": "http://localhost"}).status_code == 400


def test_profile_is_recreated_after_shared_data_reset(app, client):
    signup(client)
    snapshot = client.get("/api/state").json
    snapshot["state"]["users"] = {}
    assert client.put("/api/state", json=snapshot).status_code == 200
    user_id = client.get("/api/auth/me").json["account"]["userId"]
    assert client.get("/api/users/" + user_id).status_code == 200


def test_delete_account(app, client):
    signup(client)
    assert client.delete("/api/auth/account").status_code == 200
    assert client.get("/api/state").status_code == 401
    assert login(app.test_client()).status_code == 401
    assert signup(app.test_client()).status_code == 201  # the username is free again


# ------------------------------------------------------------------ Google

def _id_token(**claims):
    def part(data):
        return base64.urlsafe_b64encode(json.dumps(data).encode()).rstrip(b"=").decode()
    return f"{part({'alg': 'RS256'})}.{part(claims)}.signature"


class FakeGoogle:
    def __init__(self, **overrides):
        self.calls = []
        self.overrides = overrides
        self.nonce = None

    def __call__(self, url, *, form=None, body=None, token=None):
        self.calls.append((url, form, body, token))
        if url == auth.GOOGLE_TOKEN_URL and form["grant_type"] == "authorization_code":
            claims = {"iss": "https://accounts.google.com", "aud": "client-123.apps.googleusercontent.com",
                      "sub": "google-1", "email": "Maya@School.edu", "email_verified": True,
                      "name": "Maya Chen", "picture": "https://lh3.googleusercontent.com/a/x",
                      "exp": 9999999999, "nonce": self.nonce}
            claims.update(self.overrides)
            return {"access_token": "access-1", "refresh_token": "refresh-1", "id_token": _id_token(**claims),
                    "scope": f"openid email profile {auth.CALENDAR_SCOPE}"}
        if url == auth.GOOGLE_TOKEN_URL:
            return {"access_token": "access-2"}
        if url == auth.GOOGLE_FREEBUSY_URL:
            return {"calendars": {"primary": {"busy": [
                {"start": "2030-01-01T10:00:00Z", "end": "2030-01-01T11:00:00Z"},
                {"start": "2030-01-01T10:30:00Z", "end": "2030-01-01T12:00:00Z"},
                {"start": "bad", "end": "2030-01-01T12:00:00Z"}]}}}
        if url == auth.GOOGLE_REVOKE_URL:
            return {}
        raise AssertionError(url)


def google_sign_in(client, monkeypatch, fake=None, link=False):
    fake = fake or FakeGoogle()
    monkeypatch.setattr(auth, "_http_json", fake)
    start = client.get("/api/auth/google/start" + ("?link=1" if link else ""))
    assert start.status_code == 302
    params = parse_qs(urlparse(start.location).query)
    fake.nonce = params["nonce"][0]
    callback = client.get("/api/auth/google/callback?" + f"code=abc&state={params['state'][0]}")
    return start, params, callback, fake


def test_google_start_follows_oauth_best_practice(client):
    response = client.get("/api/auth/google/start")
    url = urlparse(response.location)
    params = {k: v[0] for k, v in parse_qs(url.query).items()}
    assert url.netloc == "accounts.google.com"
    assert params["response_type"] == "code" and params["code_challenge_method"] == "S256"
    assert set(params["scope"].split()) == {"openid", "email", "profile", auth.CALENDAR_SCOPE}
    assert params["access_type"] == "offline" and params["state"] and params["nonce"]
    assert params["redirect_uri"] == "http://localhost/api/auth/google/callback"
    cookie = response.headers["Set-Cookie"]
    assert "meadow_oauth=" in cookie and "HttpOnly" in cookie and "Path=/api/auth/google" in cookie
    assert params["state"] not in cookie  # signed and opaque, not a plain copy


def test_google_sign_in_creates_account_and_imports_free_busy(app, client, monkeypatch):
    _, params, callback, fake = google_sign_in(client, monkeypatch)
    assert callback.status_code == 302 and callback.location == "/"
    token_form = fake.calls[0][1]
    assert token_form["code_verifier"] and token_form["client_secret"] == "shh"
    me = client.get("/api/auth/me").json["account"]
    assert me["provider"] == "google" and me["googleCalendar"] and me["email"] == "maya@school.edu"
    user = client.get("/api/users/" + me["userId"]).json["data"]
    assert user["name"] == "Maya Chen" and user["calendar"]["source"] == "google"
    assert user["busy"] == [[1893492000000, 1893499200000]]  # overlapping blocks merged
    stored = app.extensions["auth_store"].by_google("google-1")
    assert stored["google_refresh_token"] and "refresh-1" not in stored["google_refresh_token"]
    # Signing in again reuses the account.
    again = app.test_client()
    google_sign_in(again, monkeypatch)
    assert again.get("/api/auth/me").json["account"]["userId"] == me["userId"]
    assert client.post("/api/auth/google/calendar/sync").json == {"count": 1}


@pytest.mark.parametrize("overrides,error", [
    ({"aud": "someone-else"}, "google_failed"),
    ({"iss": "https://evil.example"}, "google_failed"),
    ({"exp": 1}, "google_failed"),
    ({"nonce": "replayed"}, "google_failed"),
    ({"email_verified": False}, "google_unverified"),
])
def test_google_rejects_bad_id_tokens(app, client, monkeypatch, overrides, error):
    fake = FakeGoogle(**overrides)
    _, _, callback, _ = google_sign_in(client, monkeypatch, fake)
    assert callback.location == "/?auth_error=" + error
    assert client.get("/api/auth/me").status_code == 401
    assert app.extensions["repository"].list("users") == []


def test_google_state_must_match(client, monkeypatch):
    monkeypatch.setattr(auth, "_http_json", FakeGoogle())
    client.get("/api/auth/google/start")
    response = client.get("/api/auth/google/callback?code=abc&state=attacker")
    assert response.location == "/?auth_error=google_state"
    fresh = create_app({"TESTING": True, "GOOGLE_CLIENT_ID": "c", "GOOGLE_CLIENT_SECRET": "s"}).test_client()
    assert fresh.get("/api/auth/google/callback?code=abc&state=x").location == "/?auth_error=google_state"


def test_google_denied_consent(client, monkeypatch):
    start = client.get("/api/auth/google/start")
    state = parse_qs(urlparse(start.location).query)["state"][0]
    response = client.get(f"/api/auth/google/callback?error=access_denied&state={state}")
    assert response.location == "/?auth_error=google_denied"


def test_linking_google_to_a_password_account(app, client, monkeypatch):
    user_id = signup(client).json["account"]["userId"]
    start, params, callback, _ = google_sign_in(client, monkeypatch, link=True)
    assert params["prompt"] == ["consent"]
    assert callback.location == "/?linked=google#/me"
    me = client.get("/api/auth/me").json["account"]
    assert me["userId"] == user_id and me["google"] and me["googleCalendar"]
    assert client.post("/api/auth/google/calendar/disconnect").status_code == 200
    assert not client.get("/api/auth/me").json["account"]["googleCalendar"]


def test_google_is_optional(monkeypatch):
    client = create_app({"TESTING": True, "GOOGLE_CLIENT_ID": "", "GOOGLE_CLIENT_SECRET": ""}).test_client()
    assert client.get("/api/auth/config").json == {"google": False}
    assert client.get("/api/auth/google/start").location == "/?auth_error=google_not_configured"

"""Account and session storage. Sessions are stored by SHA-256 hash, never raw."""

from copy import deepcopy
from datetime import datetime
from threading import RLock
from uuid import uuid4

ACCOUNT_FIELDS = ("id", "user_id", "username", "password_hash", "google_sub", "email",
                  "google_refresh_token", "google_scope")


class UsernameTaken(Exception):
    pass


class GoogleAccountTaken(Exception):
    pass


def _account(**fields):
    account = {key: None for key in ACCOUNT_FIELDS}
    account.update(email="", google_scope="")
    account.update({k: v for k, v in fields.items() if k in ACCOUNT_FIELDS})
    account["id"] = uuid4().hex
    return account


class InMemoryAuthStore:
    def __init__(self):
        self._accounts: dict[str, dict] = {}
        self._sessions: dict[bytes, tuple[str, datetime]] = {}
        self._lock = RLock()

    def create_account(self, **fields):
        with self._lock:
            username = fields.get("username")
            if username and self.by_username(username):
                raise UsernameTaken
            if fields.get("google_sub") and self.by_google(fields["google_sub"]):
                raise GoogleAccountTaken
            account = _account(**fields)
            self._accounts[account["id"]] = account
            return deepcopy(account)

    def by_id(self, account_id):
        with self._lock:
            return deepcopy(self._accounts.get(account_id))

    def by_username(self, username):
        with self._lock:
            folded = username.lower()
            return deepcopy(next((a for a in self._accounts.values()
                                  if a["username"] and a["username"].lower() == folded), None))

    def by_google(self, sub):
        with self._lock:
            return deepcopy(next((a for a in self._accounts.values() if a["google_sub"] == sub), None))

    def by_user_id(self, user_id):
        with self._lock:
            return deepcopy(next((a for a in self._accounts.values() if a["user_id"] == user_id), None))

    def update(self, account_id, **fields):
        with self._lock:
            account = self._accounts[account_id]
            if fields.get("google_sub"):
                other = self.by_google(fields["google_sub"])
                if other and other["id"] != account_id:
                    raise GoogleAccountTaken
            account.update({k: v for k, v in fields.items() if k in ACCOUNT_FIELDS and k != "id"})
            return deepcopy(account)

    def delete_account(self, account_id):
        with self._lock:
            self._accounts.pop(account_id, None)
            self._sessions = {k: v for k, v in self._sessions.items() if v[0] != account_id}

    def create_session(self, token_hash, account_id, expires_at):
        with self._lock:
            self._sessions[token_hash] = (account_id, expires_at)

    def session_account(self, token_hash, now):
        """Return (account, expires_at) for a live session, or None."""
        with self._lock:
            found = self._sessions.get(token_hash)
            if not found:
                return None
            account_id, expires_at = found
            if expires_at <= now or account_id not in self._accounts:
                self._sessions.pop(token_hash, None)
                return None
            return deepcopy(self._accounts[account_id]), expires_at

    def delete_session(self, token_hash):
        with self._lock:
            self._sessions.pop(token_hash, None)

    def purge_expired(self, now):
        with self._lock:
            self._sessions = {k: v for k, v in self._sessions.items() if v[1] > now}


class TigerAuthStore:
    """Uses the Tiger repository's connection handling (and its safe error messages)."""

    def __init__(self, repository):
        self._repo = repository

    def _one(self, sql, args):
        with self._repo.connection() as conn:
            return conn.execute(sql, args).fetchone()

    def create_account(self, **fields):
        import psycopg
        account = _account(**fields)
        try:
            with self._repo.connection() as conn:
                conn.execute(
                    "INSERT INTO meadow_accounts(" + ",".join(ACCOUNT_FIELDS) + ") VALUES("
                    + ",".join(["%s"] * len(ACCOUNT_FIELDS)) + ")",
                    [account[k] for k in ACCOUNT_FIELDS])
        except psycopg.errors.UniqueViolation as error:
            raise (GoogleAccountTaken if "google_sub" in str(error) else UsernameTaken) from None
        return account

    def _select(self, where, value):
        cols = ",".join(ACCOUNT_FIELDS)
        return self._one(f"SELECT {cols} FROM meadow_accounts WHERE {where}", (value,))

    def by_id(self, account_id):
        return self._select("id=%s", account_id)

    def by_username(self, username):
        return self._select("lower(username)=lower(%s)", username)

    def by_google(self, sub):
        return self._select("google_sub=%s", sub)

    def by_user_id(self, user_id):
        return self._select("user_id=%s", user_id)

    def update(self, account_id, **fields):
        import psycopg
        fields = {k: v for k, v in fields.items() if k in ACCOUNT_FIELDS and k != "id"}
        if fields:
            assignments = ",".join(f"{k}=%s" for k in fields)
            try:
                with self._repo.connection() as conn:
                    conn.execute(f"UPDATE meadow_accounts SET {assignments} WHERE id=%s",
                                 [*fields.values(), account_id])
            except psycopg.errors.UniqueViolation:
                raise GoogleAccountTaken from None
        return self.by_id(account_id)

    def delete_account(self, account_id):
        with self._repo.connection() as conn:
            conn.execute("DELETE FROM meadow_accounts WHERE id=%s", (account_id,))

    def create_session(self, token_hash, account_id, expires_at):
        with self._repo.connection() as conn:
            conn.execute("INSERT INTO meadow_sessions(token_hash,account_id,expires_at) VALUES(%s,%s,%s)",
                         (token_hash, account_id, expires_at))

    def session_account(self, token_hash, now):
        cols = ",".join("a." + k for k in ACCOUNT_FIELDS)
        row = self._one(f"SELECT {cols},s.expires_at AS session_expires FROM meadow_sessions s "
                        "JOIN meadow_accounts a ON a.id=s.account_id "
                        "WHERE s.token_hash=%s AND s.expires_at>%s", (token_hash, now))
        if row is None:
            return None
        expires_at = row.pop("session_expires")
        return row, expires_at

    def delete_session(self, token_hash):
        with self._repo.connection() as conn:
            conn.execute("DELETE FROM meadow_sessions WHERE token_hash=%s", (token_hash,))

    def purge_expired(self, now):
        with self._repo.connection() as conn:
            conn.execute("DELETE FROM meadow_sessions WHERE expires_at<=%s", (now,))

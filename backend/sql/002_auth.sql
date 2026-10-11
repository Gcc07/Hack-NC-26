-- Accounts and sessions. Kept out of meadow_state so password hashes and Google
-- tokens are never part of the shared browser snapshot.
CREATE TABLE IF NOT EXISTS meadow_accounts (
 id text PRIMARY KEY,
 user_id text NOT NULL UNIQUE,
 username text,
 password_hash text,
 google_sub text UNIQUE,
 email text NOT NULL DEFAULT '',
 google_refresh_token text,
 google_scope text NOT NULL DEFAULT '',
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK (username IS NOT NULL OR google_sub IS NOT NULL),
 CHECK ((username IS NULL) = (password_hash IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS meadow_accounts_username ON meadow_accounts(lower(username));
CREATE TABLE IF NOT EXISTS meadow_sessions (
 token_hash bytea PRIMARY KEY,
 account_id text NOT NULL REFERENCES meadow_accounts(id) ON DELETE CASCADE,
 created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS meadow_sessions_account ON meadow_sessions(account_id);
CREATE INDEX IF NOT EXISTS meadow_sessions_expiry ON meadow_sessions(expires_at);

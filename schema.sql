CREATE TABLE IF NOT EXISTS invites (
  email             TEXT PRIMARY KEY,
  code              TEXT NOT NULL UNIQUE,
  session_id        TEXT UNIQUE,
  status            TEXT NOT NULL DEFAULT 'requested',
  created_at        TEXT NOT NULL,
  approved_at       TEXT,
  email_sent_at     TEXT,
  redeemed_at       TEXT,
  demo_first_visit  TEXT,
  demo_visits       INTEGER DEFAULT 0,
  notes             TEXT
);
CREATE INDEX IF NOT EXISTS idx_invites_code ON invites(code);
CREATE INDEX IF NOT EXISTS idx_invites_session ON invites(session_id);
CREATE INDEX IF NOT EXISTS idx_invites_status ON invites(status);

-- Fixed-window per-IP counter for /api/request-code (see isRateLimited).
CREATE TABLE IF NOT EXISTS rate_limits (
  ip            TEXT PRIMARY KEY,
  window_start  INTEGER NOT NULL,
  count         INTEGER NOT NULL DEFAULT 0
);

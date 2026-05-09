CREATE TABLE IF NOT EXISTS invites (
  email             TEXT PRIMARY KEY,
  code              TEXT NOT NULL UNIQUE,
  session_id        TEXT UNIQUE,
  status            TEXT NOT NULL DEFAULT 'requested',
  created_at        TEXT NOT NULL,
  approved_at       TEXT,
  redeemed_at       TEXT,
  demo_first_visit  TEXT,
  demo_visits       INTEGER DEFAULT 0,
  notes             TEXT
);
CREATE INDEX IF NOT EXISTS idx_invites_code ON invites(code);
CREATE INDEX IF NOT EXISTS idx_invites_session ON invites(session_id);
CREATE INDEX IF NOT EXISTS idx_invites_status ON invites(status);

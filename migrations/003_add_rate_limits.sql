-- ============================================================================
-- 003_add_rate_limits — per-IP rate limiting for /api/request-code
-- ----------------------------------------------------------------------------
-- Fixed-window counter: each IP gets N requests per hour (limit lives in
-- src/index.js). Rows are tiny and self-overwriting (one per IP, window
-- resets in place), so no cleanup job is needed.
-- Apply with:
--   wrangler d1 execute trace-invites --file=migrations/003_add_rate_limits.sql --remote
-- ============================================================================

CREATE TABLE IF NOT EXISTS rate_limits (
  ip            TEXT PRIMARY KEY,
  window_start  INTEGER NOT NULL,
  count         INTEGER NOT NULL DEFAULT 0
);

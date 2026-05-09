-- ============================================================================
-- 001_add_status — adds approval gating
-- ----------------------------------------------------------------------------
-- After this migration:
--   * new rows from /api/request-code default to status='requested'
--   * /api/redeem-code only accepts codes whose row is status='approved'
--   * existing rows are backfilled to 'approved' so previously-issued codes
--     still work (they were already implicitly approved under the old flow)
-- Apply with:
--   wrangler d1 execute trace-invites --file=migrations/001_add_status.sql --remote
-- ============================================================================

ALTER TABLE invites ADD COLUMN status TEXT NOT NULL DEFAULT 'requested';
ALTER TABLE invites ADD COLUMN approved_at TEXT;

UPDATE invites
SET status = 'approved',
    approved_at = COALESCE(approved_at, created_at)
WHERE redeemed_at IS NOT NULL OR status IS NULL OR status = 'requested';

CREATE INDEX IF NOT EXISTS idx_invites_status ON invites(status);

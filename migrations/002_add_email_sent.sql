-- ============================================================================
-- 002_add_email_sent — records when the invite-code email was delivered
-- ----------------------------------------------------------------------------
-- After this migration:
--   * /api/admin/approve stamps email_sent_at when Resend accepts the send
--   * the admin dashboard can distinguish "approved + emailed" from
--     "approved but the requester was never notified"
-- Rows approved before this migration keep email_sent_at = NULL; if you
-- already emailed those people manually, that's expected.
-- Apply with:
--   wrangler d1 execute trace-invites --file=migrations/002_add_email_sent.sql --remote
-- ============================================================================

ALTER TABLE invites ADD COLUMN email_sent_at TEXT;

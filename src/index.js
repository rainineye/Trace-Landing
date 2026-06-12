// ============================================================================
// Trace landing — Cloudflare Worker entry
// ----------------------------------------------------------------------------
// Routes /api/* to handlers below. Anything else falls through to the static
// site (env.ASSETS, configured in wrangler.jsonc).
//
// Bindings (see wrangler.jsonc):
//   env.trace_invites         -> D1 database
//   env.ASSETS                -> static asset fetcher
//   env.DEMO_URL              -> e.g. "https://demo.traceintelligence.io"
//   env.ALLOWED_DEMO_ORIGINS  -> comma-separated origins for /api/check-session CORS
//   env.RESEND_API_KEY        -> (optional secret) enables auto email
//   env.ADMIN_TOKEN           -> (secret) gates /api/admin/* + /admin/ UI
//
// Public endpoints:
//   POST /api/request-code       { email }            -> creates a 'requested' row
//   POST /api/redeem-code        { code  }            -> returns redirect URL
//   GET  /api/check-session?s=                         -> validates demo session
//
// Admin endpoints (require Authorization: Bearer <ADMIN_TOKEN>):
//   GET  /api/admin/list-pending                       -> all status='requested'
//   GET  /api/admin/list-all                           -> everything (for the dashboard)
//   POST /api/admin/approve      { email }             -> approve & return code
//   POST /api/admin/reject       { email }             -> mark rejected
//   POST /api/admin/resend-email { email }             -> re-send code email (approved only)
//   GET  /api/admin/email-preview?token=                -> rendered invite email (browser)
// ============================================================================

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const p = url.pathname;
    const m = request.method;

    // ------- public ---------------------------------------------------------
    if (p === "/api/request-code" && m === "POST") return handleRequestCode(request, env);
    if (p === "/api/redeem-code"  && m === "POST") return handleRedeemCode(request, env);

    if (p === "/api/check-session") {
      if (m === "OPTIONS") return preflight(request, env);
      if (m === "GET")     return handleCheckSession(request, env);
    }

    // ------- admin ----------------------------------------------------------
    if (p === "/api/admin/list-pending" && m === "GET")  return adminGuard(request, env, () => handleListPending(env));
    if (p === "/api/admin/list-all"     && m === "GET")  return adminGuard(request, env, () => handleListAll(env));
    if (p === "/api/admin/approve"      && m === "POST") return adminGuard(request, env, () => handleApprove(request, env));
    if (p === "/api/admin/reject"       && m === "POST") return adminGuard(request, env, () => handleReject(request, env));
    if (p === "/api/admin/resend-email" && m === "POST") return adminGuard(request, env, () => handleResendEmail(request, env));

    // Browser-viewable render of the emails (token via query string since
    // you can't set headers on a plain navigation). ?kind=confirm for the
    // signup confirmation; default is the invite-code email.
    if (p === "/api/admin/email-preview" && m === "GET") {
      const t = url.searchParams.get("token") || "";
      if (!env.ADMIN_TOKEN || t !== env.ADMIN_TOKEN) return json({ ok: false, error: "unauthorized" }, 401);
      const html = url.searchParams.get("kind") === "confirm"
        ? confirmationEmailHtml()
        : inviteEmailHtml("k7mwp3qz");
      return new Response(html, {
        headers: { "Content-Type": "text/html;charset=utf-8" },
      });
    }

    // ------- static fallback ------------------------------------------------
    return env.ASSETS.fetch(request);
  },
};

// ---------------------------------------------------------------------------
// /api/request-code
// Body: { email }
// Behavior: insert (email, generated_code, status='requested'). If the email
// already exists, return ok without changing anything (idempotent).
// We DO generate the code at request time so there's no extra step at approve;
// the code only becomes redeemable once status flips to 'approved'.
// ---------------------------------------------------------------------------
async function handleRequestCode(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: "bad_json" }, 400); }

  const email = (body && body.email ? String(body.email) : "").toLowerCase().trim();
  if (!isEmail(email)) return json({ ok: false, error: "invalid_email" }, 400);

  // Per-IP rate limit; fail open if the check itself errors.
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  try {
    if (await isRateLimited(env, ip)) return json({ ok: false, error: "rate_limited" }, 429);
  } catch { /* fail open */ }

  try {
    const existing = await env.trace_invites
      .prepare("SELECT status FROM invites WHERE email = ?")
      .bind(email)
      .first();

    if (!existing) {
      const code = generateCode();
      await env.trace_invites
        .prepare(
          "INSERT INTO invites (email, code, status, created_at) VALUES (?, ?, 'requested', ?)"
        )
        .bind(email, code, new Date().toISOString())
        .run();

      // Best-effort confirmation email — only for first-time signups (repeat
      // submits stay silent so this can't be used to spam someone's inbox),
      // and never blocks or fails the signup itself.
      if (env.RESEND_API_KEY) {
        try {
          await sendEmail(env.RESEND_API_KEY, email, "Your Trace access request", confirmationEmailHtml());
        } catch { /* non-fatal */ }
      }
    }
    // If existing: do nothing. The user just gets a generic "we got it" response.
  } catch (err) {
    return json({ ok: false, error: "db_error", detail: String(err) }, 500);
  }

  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// /api/redeem-code
// Body: { code }
// Only succeeds if the row exists AND status='approved'.
// Re-redemption returns the same session_id (so users can revisit the demo).
// ---------------------------------------------------------------------------
async function handleRedeemCode(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: "bad_json" }, 400); }

  const code = (body && body.code ? String(body.code) : "").toLowerCase().trim();
  if (!code) return json({ ok: false, error: "no_code" }, 400);

  let row;
  try {
    row = await env.trace_invites
      .prepare("SELECT code, status, session_id FROM invites WHERE code = ?")
      .bind(code)
      .first();
  } catch (err) {
    return json({ ok: false, error: "db_error", detail: String(err) }, 500);
  }

  if (!row) return json({ ok: false, error: "invalid" }, 401);

  if (row.status !== "approved") {
    // Could be 'requested' (pending review) or 'rejected' — either way, deny.
    return json({ ok: false, error: "not_approved" }, 403);
  }

  let sessionId = row.session_id;
  if (!sessionId) {
    sessionId = crypto.randomUUID().replace(/-/g, "");
    try {
      await env.trace_invites
        .prepare("UPDATE invites SET session_id = ?, redeemed_at = ? WHERE code = ?")
        .bind(sessionId, new Date().toISOString(), code)
        .run();
    } catch (err) {
      return json({ ok: false, error: "db_error", detail: String(err) }, 500);
    }
  }

  const demoBase = env.DEMO_URL || "https://demo.traceintelligence.io";
  return json({ ok: true, redirect: `${demoBase}/?s=${sessionId}` });
}

// ---------------------------------------------------------------------------
// /api/check-session?s=<id>
// Called server-side from the demo's middleware on page load.
// ---------------------------------------------------------------------------
async function handleCheckSession(request, env) {
  const sessionId = new URL(request.url).searchParams.get("s") || "";
  if (!sessionId) return jsonCors(request, env, { ok: false, error: "no_session" }, 400);

  let row;
  try {
    row = await env.trace_invites
      .prepare("SELECT email, status FROM invites WHERE session_id = ?")
      .bind(sessionId)
      .first();
  } catch (err) {
    return jsonCors(request, env, { ok: false, error: "db_error", detail: String(err) }, 500);
  }

  if (!row || row.status !== "approved") {
    return jsonCors(request, env, { ok: false, error: "invalid_session" }, 401);
  }

  // Best-effort visit counter.
  try {
    await env.trace_invites
      .prepare(
        `UPDATE invites
            SET demo_visits = demo_visits + 1,
                demo_first_visit = COALESCE(demo_first_visit, ?)
          WHERE session_id = ?`
      )
      .bind(new Date().toISOString(), sessionId)
      .run();
  } catch { /* non-fatal */ }

  return jsonCors(request, env, { ok: true, email: row.email });
}

// ===========================================================================
// Admin
// ===========================================================================

async function adminGuard(request, env, next) {
  const expected = env.ADMIN_TOKEN;
  if (!expected) return json({ ok: false, error: "admin_disabled" }, 503);

  const auth = request.headers.get("Authorization") || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  const token = m ? m[1] : "";

  // Constant-time comparison would be nicer but for solo admin use this is fine.
  if (token !== expected) return json({ ok: false, error: "unauthorized" }, 401);
  return next();
}

async function handleListPending(env) {
  const { results } = await env.trace_invites
    .prepare(
      "SELECT email, code, status, created_at FROM invites WHERE status = 'requested' ORDER BY created_at ASC"
    )
    .all();
  return json({ ok: true, rows: results || [] });
}

async function handleListAll(env) {
  const { results } = await env.trace_invites
    .prepare(
      `SELECT email, code, status, created_at, approved_at, email_sent_at,
              redeemed_at, demo_first_visit, demo_visits
         FROM invites
         ORDER BY created_at DESC`
    )
    .all();
  return json({ ok: true, rows: results || [] });
}

async function handleApprove(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: "bad_json" }, 400); }

  const email = (body && body.email ? String(body.email) : "").toLowerCase().trim();
  if (!isEmail(email)) return json({ ok: false, error: "invalid_email" }, 400);

  const row = await env.trace_invites
    .prepare("SELECT email, code, status FROM invites WHERE email = ?")
    .bind(email)
    .first();
  if (!row) return json({ ok: false, error: "not_found" }, 404);

  if (row.status === "approved") {
    // idempotent — return the existing code so admin can re-copy it
    return json({ ok: true, email: row.email, code: row.code, already_approved: true });
  }

  await env.trace_invites
    .prepare("UPDATE invites SET status = 'approved', approved_at = ? WHERE email = ?")
    .bind(new Date().toISOString(), email)
    .run();

  // email_sent: true = delivered to Resend, false = attempted but failed,
  // null = RESEND_API_KEY not configured (manual email needed).
  const emailSent = await trySendInviteEmail(env, email, row.code);

  return json({ ok: true, email, code: row.code, email_sent: emailSent });
}

// ---------------------------------------------------------------------------
// /api/admin/resend-email
// Body: { email }
// Re-sends the invite-code email for an approved row — for lost codes or
// failed/missing sends. Stamps email_sent_at on success.
// ---------------------------------------------------------------------------
async function handleResendEmail(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: "bad_json" }, 400); }

  const email = (body && body.email ? String(body.email) : "").toLowerCase().trim();
  if (!isEmail(email)) return json({ ok: false, error: "invalid_email" }, 400);

  const row = await env.trace_invites
    .prepare("SELECT email, code, status FROM invites WHERE email = ?")
    .bind(email)
    .first();
  if (!row) return json({ ok: false, error: "not_found" }, 404);
  if (row.status !== "approved") return json({ ok: false, error: "not_approved" }, 409);

  const sent = await trySendInviteEmail(env, email, row.code);
  if (sent === null) return json({ ok: false, error: "email_not_configured" }, 503);
  if (!sent) return json({ ok: false, error: "send_failed" }, 502);
  return json({ ok: true, email, email_sent: true });
}

async function handleReject(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: "bad_json" }, 400); }

  const email = (body && body.email ? String(body.email) : "").toLowerCase().trim();
  if (!isEmail(email)) return json({ ok: false, error: "invalid_email" }, 400);

  const res = await env.trace_invites
    .prepare("UPDATE invites SET status = 'rejected' WHERE email = ?")
    .bind(email)
    .run();

  return json({ ok: true, changes: res.meta && res.meta.changes ? res.meta.changes : 0 });
}

// ===========================================================================
// Helpers
// ===========================================================================

function isEmail(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

function generateCode() {
  // 8-char unambiguous alphanumeric (no 0/O/l/1/I).
  const chars = "abcdefghijkmnpqrstuvwxyz23456789";
  const buf = new Uint8Array(8);
  crypto.getRandomValues(buf);
  let s = "";
  for (let i = 0; i < 8; i++) s += chars[buf[i] % chars.length];
  return s;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function allowedOrigins(env) {
  const raw = env.ALLOWED_DEMO_ORIGINS || env.DEMO_ORIGIN || "https://demo.traceintelligence.io";
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin") || "";
  const allowed = allowedOrigins(env);
  const allow = allowed.includes(origin) ? origin : allowed[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
  };
}

function preflight(request, env) {
  return new Response(null, { status: 204, headers: corsHeaders(request, env) });
}

function jsonCors(request, env, data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(request, env) },
  });
}

// Fixed-window per-IP limit: REQUESTS_PER_HOUR requests to /api/request-code.
// One row per IP in rate_limits; the window resets in place, so the table
// stays as small as the number of distinct IPs seen in the current hour.
const REQUESTS_PER_HOUR = 5;

async function isRateLimited(env, ip) {
  const windowStart = Math.floor(Date.now() / 3600000); // hour bucket
  const row = await env.trace_invites
    .prepare("SELECT window_start, count FROM rate_limits WHERE ip = ?")
    .bind(ip)
    .first();
  if (row && row.window_start === windowStart && row.count >= REQUESTS_PER_HOUR) return true;

  await env.trace_invites
    .prepare(
      `INSERT INTO rate_limits (ip, window_start, count) VALUES (?, ?, 1)
       ON CONFLICT(ip) DO UPDATE SET
         count = CASE WHEN window_start = excluded.window_start THEN count + 1 ELSE 1 END,
         window_start = excluded.window_start`
    )
    .bind(ip, windowStart)
    .run();
  return false;
}

// Sends the invite email and stamps email_sent_at on success.
// Returns: true = sent, false = attempted but failed, null = no RESEND_API_KEY.
async function trySendInviteEmail(env, email, code) {
  if (!env.RESEND_API_KEY) return null;
  let sent = false;
  try {
    const res = await sendInviteEmail(env.RESEND_API_KEY, email, code);
    sent = res.ok;
  } catch {
    sent = false;
  }
  if (sent) {
    try {
      await env.trace_invites
        .prepare("UPDATE invites SET email_sent_at = ? WHERE email = ?")
        .bind(new Date().toISOString(), email)
        .run();
    } catch { /* the send already happened; don't fail the caller */ }
  }
  return sent;
}

async function sendEmail(apiKey, to, subject, html) {
  return fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: "Trace <info@traceintelligence.io>",
      to: [to],
      subject,
      html,
    }),
  });
}

async function sendInviteEmail(apiKey, to, code) {
  return sendEmail(apiKey, to, "Your Trace access code", inviteEmailHtml(code));
}

// Archival/paper styling to match the landing page. Email-safe: tables,
// inline styles, system serif (Georgia) + monospace only.
// emailLayout wraps content rows in the shared letterhead (tag + rules + footer).
function emailLayout(inner) {
  return `<!doctype html>
<html>
<body style="margin:0;padding:0;background:#FAF8F3;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FAF8F3;">
    <tr>
      <td align="center" style="padding:40px 16px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;border:1px solid #D9D4C7;background:#FAF8F3;">
          <tr>
            <td style="padding:26px 32px 0;">
              <span style="font-family:'Courier New',Courier,monospace;font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#A03A2C;">[ Trace &middot; Access ]</span>
              <div style="height:1px;background:#D9D4C7;margin-top:16px;"></div>
            </td>
          </tr>
          ${inner}
          <tr>
            <td style="padding:0 32px 26px;">
              <div style="height:1px;background:#D9D4C7;margin-bottom:14px;"></div>
              <div style="font-family:'Courier New',Courier,monospace;font-size:10px;letter-spacing:1px;text-transform:uppercase;color:#9D968B;line-height:1.7;">
                Trace &middot; An instrument for contested claims<br>
                Built in Amsterdam &middot; MMXXVI
              </div>
              <p style="font-family:Georgia,'Times New Roman',serif;font-size:11.5px;color:#9D968B;margin:12px 0 0;">
                You requested access at traceintelligence.io. If this wasn&rsquo;t you, you can ignore this email.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function inviteEmailHtml(code) {
  return emailLayout(`
          <tr>
            <td style="padding:28px 32px 6px;">
              <div style="font-family:Georgia,'Times New Roman',serif;font-size:23px;line-height:1.35;color:#1A1A1A;">
                Your invite has been <em>approved</em>.
              </div>
              <p style="font-family:Georgia,'Times New Roman',serif;font-size:15px;line-height:1.6;color:#5A5147;margin:14px 0 0;">
                Use this access code to open the case file:
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding:14px 32px 6px;">
              <div style="font-family:'Courier New',Courier,monospace;font-size:25px;letter-spacing:6px;color:#1A1A1A;border:1px solid #D9D4C7;background:#F2EEE4;padding:18px 12px;text-align:center;">${code}</div>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:20px 32px 8px;">
              <table role="presentation" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="background:#1A1A1A;border-radius:2px;">
                    <a href="https://traceintelligence.io/?c=${code}"
                       style="display:inline-block;padding:14px 30px;font-family:'Courier New',Courier,monospace;font-size:13px;letter-spacing:2px;text-transform:uppercase;color:#FAF8F3;text-decoration:none;">
                      Open the case file &rarr;
                    </a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:12px 32px 26px;">
              <p style="font-family:Georgia,'Times New Roman',serif;font-size:13px;line-height:1.6;color:#9D968B;margin:0;text-align:center;">
                Or enter the code manually at <a href="https://traceintelligence.io" style="color:#A03A2C;">traceintelligence.io</a> &rarr; <strong>Demo</strong>.<br>
                The code is tied to this address &mdash; please don&rsquo;t pass it on.
              </p>
            </td>
          </tr>`);
}

// Sent right after a new signup so the requester knows it worked.
function confirmationEmailHtml() {
  return emailLayout(`
          <tr>
            <td style="padding:28px 32px 26px;">
              <div style="font-family:Georgia,'Times New Roman',serif;font-size:23px;line-height:1.35;color:#1A1A1A;">
                Your request has been <em>logged</em>.
              </div>
              <p style="font-family:Georgia,'Times New Roman',serif;font-size:15px;line-height:1.6;color:#5A5147;margin:14px 0 0;">
                Invites go out in batches. When yours is approved, the access code
                will arrive in this inbox &mdash; no further action needed.
              </p>
            </td>
          </tr>`);
}

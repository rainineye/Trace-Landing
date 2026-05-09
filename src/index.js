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
      `SELECT email, code, status, created_at, approved_at, redeemed_at,
              demo_first_visit, demo_visits
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

  // Best-effort email send (silent if RESEND_API_KEY unset).
  if (env.RESEND_API_KEY) {
    try { await sendInviteEmail(env.RESEND_API_KEY, email, row.code); } catch { /* swallow */ }
  }

  return json({ ok: true, email, code: row.code });
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

async function sendInviteEmail(apiKey, to, code) {
  return fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: "Trace <hello@traceintelligence.io>",
      to: [to],
      subject: "Your Trace access code",
      html:
        `<p style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.55;">` +
        `Your invite has been approved. Access code:</p>` +
        `<p style="font-family:ui-monospace,Menlo,monospace;font-size:22px;letter-spacing:2px;">` +
        `<strong>${code}</strong></p>` +
        `<p style="font-family:system-ui,sans-serif;font-size:14px;color:#555;">` +
        `Enter it at <a href="https://traceintelligence.io">traceintelligence.io</a> ` +
        `&rarr; Demo to view the case file.</p>`,
    }),
  });
}

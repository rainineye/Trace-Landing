// ============================================================================
// Trace landing — Cloudflare Worker entry
// ----------------------------------------------------------------------------
// Routes /api/* to handlers below. Anything else falls through to the static
// site (env.ASSETS, configured in wrangler.jsonc).
//
// Bindings (see wrangler.jsonc):
//   env.trace_invites  -> D1 database
//   env.ASSETS         -> static asset fetcher
//   env.DEMO_URL       -> e.g. "https://demo.0xmian.com"
//   env.DEMO_ORIGIN    -> CORS allow-origin for /api/check-session
//   env.RESEND_API_KEY -> (optional secret) enables email sending
// ============================================================================

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/request-code" && request.method === "POST") {
      return handleRequestCode(request, env);
    }
    if (url.pathname === "/api/redeem-code" && request.method === "POST") {
      return handleRedeemCode(request, env);
    }
    if (url.pathname === "/api/check-session") {
      if (request.method === "OPTIONS") return preflight(env);
      if (request.method === "GET") return handleCheckSession(request, env);
    }

    // Not an API route -> serve the static site.
    return env.ASSETS.fetch(request);
  },
};

// ---------------------------------------------------------------------------
// /api/request-code
// Body: { email }
// Side effect: insert (email, code) into D1 if new; else return existing code.
// Optionally sends an email via Resend if RESEND_API_KEY is configured.
// ---------------------------------------------------------------------------
async function handleRequestCode(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "bad_json" }, 400);
  }

  const email = (body && body.email ? String(body.email) : "").toLowerCase().trim();
  if (!isEmail(email)) {
    return json({ ok: false, error: "invalid_email" }, 400);
  }

  let code;
  try {
    const existing = await env.trace_invites
      .prepare("SELECT code FROM invites WHERE email = ?")
      .bind(email)
      .first();

    if (existing) {
      code = existing.code;
    } else {
      code = generateCode();
      await env.trace_invites
        .prepare("INSERT INTO invites (email, code, created_at) VALUES (?, ?, ?)")
        .bind(email, code, new Date().toISOString())
        .run();
    }
  } catch (err) {
    return json({ ok: false, error: "db_error", detail: String(err) }, 500);
  }

  // Best-effort email send. Failures don't block the response — admin can
  // still see the row in D1 and resend manually.
  if (env.RESEND_API_KEY) {
    try {
      await sendInviteEmail(env.RESEND_API_KEY, email, code);
    } catch {
      /* swallow */
    }
  }

  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// /api/redeem-code
// Body: { code }
// On success, sets session_id + redeemed_at, returns redirect URL.
// Re-redeeming an already-redeemed code returns the SAME session (so the user
// can revisit the demo without burning a new session).
// ---------------------------------------------------------------------------
async function handleRedeemCode(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "bad_json" }, 400);
  }

  const code = (body && body.code ? String(body.code) : "").toLowerCase().trim();
  if (!code) {
    return json({ ok: false, error: "no_code" }, 400);
  }

  let row;
  try {
    row = await env.trace_invites
      .prepare("SELECT code, session_id FROM invites WHERE code = ?")
      .bind(code)
      .first();
  } catch (err) {
    return json({ ok: false, error: "db_error", detail: String(err) }, 500);
  }

  if (!row) return json({ ok: false, error: "invalid" }, 401);

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

  const demoBase = env.DEMO_URL || "https://demo.0xmian.com";
  return json({
    ok: true,
    redirect: `${demoBase}/?s=${sessionId}`,
  });
}

// ---------------------------------------------------------------------------
// /api/check-session?s=<id>
// Called cross-origin from the Vercel demo on page load.
// Returns { ok: true, email } if the session is valid; bumps demo_visits.
// ---------------------------------------------------------------------------
async function handleCheckSession(request, env) {
  const sessionId = new URL(request.url).searchParams.get("s") || "";
  if (!sessionId) {
    return jsonCors(env, { ok: false, error: "no_session" }, 400);
  }

  let row;
  try {
    row = await env.trace_invites
      .prepare("SELECT email FROM invites WHERE session_id = ?")
      .bind(sessionId)
      .first();
  } catch (err) {
    return jsonCors(env, { ok: false, error: "db_error", detail: String(err) }, 500);
  }

  if (!row) {
    return jsonCors(env, { ok: false, error: "invalid_session" }, 401);
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
  } catch {
    /* non-fatal */
  }

  return jsonCors(env, { ok: true, email: row.email });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
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

function corsHeaders(env) {
  return {
    "Access-Control-Allow-Origin": env.DEMO_ORIGIN || "https://demo.0xmian.com",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
  };
}

function preflight(env) {
  return new Response(null, { status: 204, headers: corsHeaders(env) });
}

function jsonCors(env, data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(env),
    },
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
        `Your access code:</p>` +
        `<p style="font-family:ui-monospace,Menlo,monospace;font-size:22px;letter-spacing:2px;">` +
        `<strong>${code}</strong></p>` +
        `<p style="font-family:system-ui,sans-serif;font-size:14px;color:#555;">` +
        `Enter it at <a href="https://traceintelligence.io">traceintelligence.io</a> ` +
        `&rarr; Demo to view the case file.</p>`,
    }),
  });
}

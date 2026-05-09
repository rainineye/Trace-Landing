# Deploy & test checklist

This repo is a **Cloudflare Workers** project with **Static Assets**. The
landing page (`index.html`) is served statically; `/api/*` routes and
`/admin/` are handled by the worker entry at `src/index.js`. Access
codes / sessions / approval state live in a **D1** database (`trace-invites`).

```
                                                              ┌─────────────┐
visitor          traceintelligence.io                         │     D1      │
─────────        ───────────────────────────                  └──────┬──────┘
[email]   ─POST─►/api/request-code   ────────────────►  insert (status=requested)
                                                                     │
              you, the admin                                         │
              ────────────                                           │
              GET /admin/?token=xxx ────────►  approve/reject ──►  status=approved
              copy code, send by email                               │
                                                                     │
[code ]   ─POST─►/api/redeem-code    ──── (only if approved) ──►  set session_id
                          │
                          ▼ redirect
                 demo.traceintelligence.io/?s=<id>
                          │   (Vercel Next.js — middleware validates s,
                          ▼    sets trace_auth cookie, strips ?s=)
                 GET /api/check-session?s=<id>  ──────────►  bump demo_visits
```

The same Vercel deployment also serves **demo.0xmian.com** for the legacy
password flow (unchanged).

---

## 0. One-time prereqs

- [x] `wrangler d1 create trace-invites` (DB id is in `wrangler.jsonc`)
- [x] `wrangler d1 execute trace-invites --file=schema.sql --remote`
- [x] D1 binding `trace_invites` configured in `wrangler.jsonc`
- [x] trace-demo middleware (`middleware.ts`) deployed to Vercel

If you're upgrading an existing deployment from the pre-approval flow:

```bash
cd C:\Users\eau12\trace-landing
wrangler d1 execute trace-invites --file=migrations/001_add_status.sql --remote
```

That adds the `status` and `approved_at` columns and backfills existing rows
to `status='approved'` so previously-issued codes still work.

## 1. Set the admin token (one-time)

Pick a strong random token; this gates `/admin/` and all `/api/admin/*`.

```bash
# Generate one
openssl rand -hex 32
```

Save it somewhere safe (1Password, etc), then push it as a secret to the
worker:

```bash
echo "YOUR_GENERATED_TOKEN" | wrangler secret put ADMIN_TOKEN
```

(Or via Cloudflare dashboard → your worker → **Settings → Variables and
Secrets → Add → Type: Secret → Name: `ADMIN_TOKEN`**.)

Re-deploy if needed for the secret to take effect.

## 2. Add the `demo.traceintelligence.io` subdomain

The trace-demo Vercel project needs to accept the new domain too.

1. **Vercel** → trace-demo project → **Settings → Domains → Add**
   `demo.traceintelligence.io`. Vercel will show a CNAME target like
   `cname.vercel-dns.com` (or an A/AAAA record).
2. **Cloudflare** → traceintelligence.io zone → **DNS → Records → Add record**
   - Type: `CNAME`
   - Name: `demo`
   - Target: paste what Vercel showed
   - **Proxy status: DNS only** (gray cloud — Vercel needs direct DNS)
3. Wait for Vercel verification (usually under a minute).
4. Confirm: open `https://demo.traceintelligence.io/login` — you should
   see the password screen, served by the same Vercel deployment as
   demo.0xmian.com.

The middleware on Vercel doesn't need any change — it's host-agnostic.

## 3. Deploy the landing changes

```bash
cd C:\Users\eau12\trace-landing
git add wrangler.jsonc .assetsignore src/ admin/ index.html schema.sql migrations/ DEPLOY.md
git commit -m "feat: invite approval flow + admin UI + demo subdomain"
git push     # if Cloudflare auto-deploys on push
# or:
npx wrangler deploy
```

## 4. Smoke test

### 4.1 Request → approve → redeem flow

```bash
# (a) someone requests a code
curl -sX POST https://traceintelligence.io/api/request-code \
  -H 'Content-Type: application/json' \
  -d '{"email":"example@test.com"}'
# expect: {"ok":true}
```

Open `https://traceintelligence.io/admin/?token=YOUR_ADMIN_TOKEN` in an
incognito window. You should see one row in **Pending**. Click **Approve**.
The code gets copied to your clipboard and the row moves to **Approved**.

```bash
# (b) try to redeem BEFORE approval (this should already be moot since you
#     just approved; do a fresh request-code and try without approving)
curl -sX POST https://traceintelligence.io/api/redeem-code \
  -H 'Content-Type: application/json' \
  -d '{"code":"PASTE_PENDING_CODE"}'
# expect: {"ok":false,"error":"not_approved"}

# (c) redeem AFTER approval
curl -sX POST https://traceintelligence.io/api/redeem-code \
  -H 'Content-Type: application/json' \
  -d '{"code":"PASTE_APPROVED_CODE"}'
# expect: {"ok":true,"redirect":"https://demo.traceintelligence.io/?s=...."}

# (d) hit the redirect — middleware validates and serves demo
curl -sIL "https://demo.traceintelligence.io/?s=PASTE_SESSION_ID"
# expect: 307 to https://demo.traceintelligence.io/  with Set-Cookie: trace_auth=...
```

### 4.2 End-to-end through the browser

1. Incognito window → `https://traceintelligence.io` → enter email →
   "Code sent. Check your inbox…" status.
2. Open `/admin/?token=...` → approve the request → copy the code.
3. Send the code to the requester (over email, manually for now). They enter
   it on the landing page → redirected to `demo.traceintelligence.io/?s=...`
   → middleware exchanges `?s=` for the cookie → demo loads, no login screen.
4. They reload — still in. Cookie is good for 7 days.
5. demo.0xmian.com still works for password access (unchanged).

## 5. Admin UI cheatsheet

URL: `https://traceintelligence.io/admin/?token=YOUR_TOKEN`

The page is a single static HTML file; it stores the token in `sessionStorage`
so you don't need the `?token=` in URL after the first load (private browsing
profile recommended). All actions go to `/api/admin/*` with
`Authorization: Bearer <token>`.

What the page shows:

| Column | Meaning |
|---|---|
| **Pending** | New requests awaiting your decision. Approve / Reject. |
| **Approved** | Issued codes. Shows code, redemption status, demo visit count. Copy code button. |
| **Other** | Rejected (or future statuses). |

## 6. View / export your "Excel"

Cloudflare dashboard → **Workers & Pages → D1 → trace-invites → Tables →
`invites`**. Same as before, plus the `status` and `approved_at` columns.

Useful queries:

```sql
-- Funnel
SELECT
  COUNT(*)                                          AS total_requested,
  SUM(CASE WHEN status='approved' THEN 1 ELSE 0 END) AS total_approved,
  SUM(CASE WHEN status='rejected' THEN 1 ELSE 0 END) AS total_rejected,
  COUNT(redeemed_at)                                AS total_redeemed,
  COUNT(demo_first_visit)                           AS total_visited
FROM invites;

-- Pending review queue (oldest first)
SELECT email, code, created_at FROM invites
WHERE status = 'requested' ORDER BY created_at ASC;

-- Approved but not yet used
SELECT email, code, approved_at FROM invites
WHERE status = 'approved' AND redeemed_at IS NULL
ORDER BY approved_at DESC;

-- Most engaged demo visitors
SELECT email, demo_visits, demo_first_visit FROM invites
WHERE demo_visits > 0 ORDER BY demo_visits DESC;
```

## 7. Add Resend later (auto email on approve)

When you're ready:

1. Sign up at https://resend.com (free 3000/mo).
2. Verify domain `traceintelligence.io` (Resend gives you DKIM/SPF/DMARC
   records → add in Cloudflare DNS).
   - SPF gotcha: if Cloudflare Email Routing already set
     `v=spf1 include:_spf.mx.cloudflare.net ~all`,
     merge to
     `v=spf1 include:_spf.mx.cloudflare.net include:_spf.resend.com ~all`.
3. Create API key in Resend.
4. `echo "YOUR_RESEND_KEY" | wrangler secret put RESEND_API_KEY`
5. Redeploy.

After that, clicking **Approve** in the admin UI will both flip the status AND
send the requester an email with their code. No code change needed.

## 8. Rollback

```bash
git revert HEAD
git push
```

The D1 schema additions are non-destructive (additive ALTER TABLE), so a
revert just stops new approvals from being needed — old rows are untouched.
If you need to roll the schema back too:

```sql
-- not strictly needed, but if you want to undo:
ALTER TABLE invites DROP COLUMN status;
ALTER TABLE invites DROP COLUMN approved_at;
```

---

## Files in this change set

| File | Purpose |
|---|---|
| `wrangler.jsonc` | `main`, asset binding, `DEMO_URL` (now demo.traceintelligence.io), `ALLOWED_DEMO_ORIGINS`. |
| `schema.sql` | Canonical schema (`status`, `approved_at` columns added). |
| `migrations/001_add_status.sql` | Migration for existing deployments. |
| `.assetsignore` | Keeps `src/`, `migrations/`, `wrangler.jsonc`, etc. out of the public site. |
| `src/index.js` | Worker: routes `/api/*` and `/api/admin/*`; static fallback. |
| `index.html` | (unchanged in this round) Form handlers POST to `/api/*`. |
| `admin/index.html` | Admin UI. Token entry + pending / approved tables. |
| `vercel-demo-snippet.js` | (Legacy / not used.) Was for non-password demos. |
| `../trace-demo/middleware.ts` | Vercel-side gate that validates `?s=` and sets the password cookie. |

# Deploy & test checklist

This repo is a **Cloudflare Workers** project with **Static Assets**. The
landing page (`index.html`) is served statically; `/api/*` routes are handled
by the worker entry at `src/index.js`. Access codes and sessions live in a
**D1** database (`trace-invites`).

```
visitor          traceintelligence.io                            D1
─────────        ────────────────────────────                   ─────
[email]   ─POST─►/api/request-code  ─────────► insert (email, code)
[code ]   ─POST─►/api/redeem-code   ─────────► set session_id, redeemed_at
                          │
                          ▼ redirect
                 demo.0xmian.com/?s=<id>
                          │
                          ▼ on load
                 GET /api/check-session?s=<id>  ► bump demo_visits
```

---

## 0. One-time prereqs (already done)

- [x] `wrangler d1 create trace-invites` → DB id is in `wrangler.jsonc`
- [x] `wrangler d1 execute trace-invites --file=schema.sql --remote`
- [x] D1 binding `trace_invites` configured in `wrangler.jsonc`

## 1. Deploy

Two paths — pick whichever matches how this site is currently deployed.

### A. Git push (Cloudflare deploys automatically)
If your Cloudflare project is wired to this GitHub repo (auto-deploy on push):

```bash
git add wrangler.jsonc .assetsignore src/index.js index.html DEPLOY.md vercel-demo-snippet.js
git commit -m "feat: server-side invite code flow on /api/* with D1"
git push
```

Cloudflare picks it up, builds, and ships.

### B. Direct deploy from your machine
```bash
npx wrangler deploy
```

That uploads both the static assets and the worker entry.

## 2. Smoke test the API (run from any machine with curl)

Replace `EXAMPLE@TEST.COM` and the code value with what you actually use.

```bash
# 2.1  Issue a code
curl -sX POST https://traceintelligence.io/api/request-code \
  -H 'Content-Type: application/json' \
  -d '{"email":"example@test.com"}'
# expect: {"ok":true}
```

Then look in the **Cloudflare dashboard → Workers & Pages → D1 → trace-invites
→ Tables → `invites`** — you should see a new row with that email and an 8-char
code. Copy the code.

```bash
# 2.2  Redeem the code
curl -sX POST https://traceintelligence.io/api/redeem-code \
  -H 'Content-Type: application/json' \
  -d '{"code":"PASTE_CODE_HERE"}'
# expect: {"ok":true,"redirect":"https://demo.0xmian.com/?s=...."}
```

Pull the `s=...` value out of the redirect URL.

```bash
# 2.3  Validate the session
curl -s "https://traceintelligence.io/api/check-session?s=PASTE_SESSION_ID"
# expect: {"ok":true,"email":"example@test.com"}
```

The D1 row should now have `session_id`, `redeemed_at`, `demo_first_visit`,
and `demo_visits = 1`.

## 3. Smoke test the page

Open https://traceintelligence.io in an incognito window:

1. Type your email into the hero form → click **Request Code** → status should
   say "Code sent…".
2. Check D1 for the new row → copy the code.
3. Click **Demo** → paste the code → status should say "Accepted. Opening…"
   then redirect to `https://demo.0xmian.com/?s=<id>`.
4. (Step 4 only works once the Vercel-side gate is wired — see next section.)

## 4. Wire up the Vercel demo

Open the Vercel `demo.0xmian.com` repo and paste `vercel-demo-snippet.js` in
according to its header instructions. Push, redeploy. Then re-run the page
smoke test from step 3 — the demo should now load only when the URL or
localStorage holds a valid session id, and bounce visitors back to
traceintelligence.io otherwise.

## 5. View / export your "Excel"

Cloudflare dashboard → **Workers & Pages → D1 → trace-invites → Tables →
`invites`**. Grid view is sortable + filterable. The console below it accepts
SQL — useful queries:

```sql
-- Pipeline funnel
SELECT
  COUNT(*)                AS total_requested,
  COUNT(redeemed_at)      AS total_redeemed,
  COUNT(demo_first_visit) AS total_visited
FROM invites;

-- Codes that haven't been used yet
SELECT email, code, created_at
FROM invites
WHERE redeemed_at IS NULL
ORDER BY created_at DESC;

-- Most engaged demo visitors
SELECT email, demo_visits, demo_first_visit
FROM invites
WHERE demo_visits > 0
ORDER BY demo_visits DESC;
```

CSV export: dashboard table view → "Export" button.

## 6. Add Resend later (when you want auto emails)

1. Sign up at https://resend.com (free tier: 3000 emails/month).
2. Add domain `traceintelligence.io` → copy the DKIM/SPF/DMARC records they
   give you → add them in Cloudflare DNS.
   - SPF gotcha: if Cloudflare Email Routing already set
     `v=spf1 include:_spf.mx.cloudflare.net ~all`,
     merge it to
     `v=spf1 include:_spf.mx.cloudflare.net include:_spf.resend.com ~all`.
     One SPF record only.
3. Create an API key in Resend.
4. Cloudflare dashboard → your worker → **Settings → Variables and Secrets →
   Add → Type: Secret → Name: `RESEND_API_KEY` → Value: paste**.
5. Redeploy. The worker auto-detects the secret and starts sending emails.

No code change required.

## 7. Rollback

If something breaks after deploy, the safest revert path is:

```bash
git revert HEAD
git push
```

This restores the prior client-side hash flow. The D1 database stays intact —
new requests just won't write to it until you re-deploy.

---

## Files in this change

| File | What it does |
|---|---|
| `wrangler.jsonc` | Adds `main`, `assets.binding`, `vars.DEMO_URL`/`DEMO_ORIGIN`. |
| `.assetsignore` | Keeps `src/`, `wrangler.jsonc`, `schema.sql` out of the public site. |
| `src/index.js` | Worker entry: routes `/api/*` to handlers, falls through to static for everything else. |
| `index.html` | Form handlers now POST to the API; SHA-256 client logic removed. |
| `vercel-demo-snippet.js` | To be pasted into the demo.0xmian.com repo (NOT served from this site). |
| `schema.sql` | (unchanged) D1 table definition. Already executed. |

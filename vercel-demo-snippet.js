// ============================================================================
// Trace demo — session gate
// ----------------------------------------------------------------------------
// Drop this into the Vercel demo project (the site at https://demo.0xmian.com).
// It runs once on page load: validates ?s=<session_id> against the Cloudflare
// Worker on traceintelligence.io. If valid, stores the session in localStorage
// and strips the param from the URL. If not, redirects to traceintelligence.io.
//
// HOW TO USE
// ----------
// (a) If your demo is plain HTML / Vite / static SPA:
//     Save this file as `public/trace-gate.js` and add to <head>:
//       <script src="/trace-gate.js"></script>
//
// (b) If your demo is Next.js (App Router):
//     Make a Client Component (e.g. app/_components/TraceGate.tsx),
//     paste the IIFE body inside a useEffect, mount once in app/layout.tsx.
//
// (c) If your demo is Next.js (Pages Router):
//     Paste the IIFE inside `useEffect` in pages/_app.tsx.
//
// You can flip the LOCAL_DEV flag to true while developing the demo locally
// so the gate is bypassed.
// ============================================================================

(function () {
  var LANDING_ORIGIN = "https://traceintelligence.io";
  var STORAGE_KEY = "trace_session";
  var LOCAL_DEV = false; // set true to bypass while developing locally

  if (LOCAL_DEV) return;
  if (typeof window === "undefined") return; // SSR-safe

  var url = new URL(window.location.href);
  var fromQuery = url.searchParams.get("s");
  var fromStorage = null;
  try { fromStorage = window.localStorage.getItem(STORAGE_KEY); } catch (e) {}

  var session = fromQuery || fromStorage;

  if (!session) {
    window.location.replace(LANDING_ORIGIN);
    return;
  }

  fetch(LANDING_ORIGIN + "/api/check-session?s=" + encodeURIComponent(session), {
    method: "GET",
    credentials: "omit",
  })
    .then(function (res) { return res.json().catch(function () { return {}; }); })
    .then(function (data) {
      if (data && data.ok) {
        try { window.localStorage.setItem(STORAGE_KEY, session); } catch (e) {}
        // Hide the session id from the URL so the link can't be casually shared.
        if (fromQuery) {
          url.searchParams.delete("s");
          var clean = url.pathname + (url.searchParams.toString() ? "?" + url.searchParams.toString() : "") + url.hash;
          window.history.replaceState({}, "", clean);
        }
      } else {
        try { window.localStorage.removeItem(STORAGE_KEY); } catch (e) {}
        window.location.replace(LANDING_ORIGIN);
      }
    })
    .catch(function () {
      // Network error — fail open ONLY if the user already had a stored session
      // (they likely came back to a page they were authorised on). For brand-new
      // visitors with only ?s=, fail closed and bounce them.
      if (!fromStorage) {
        window.location.replace(LANDING_ORIGIN);
      }
    });
})();

# S3 — Frontend Enforcement & UX — Phase Report

**Status:** Enforcement machinery built + deployed in **shadow** (inert). The **go-live flip needs you** (owner password + env flip + a couple of decisions). Nothing user-visible has changed yet.
**Date:** 2026-07-03.

---

## 1. What was built

The browser side of auth. A user can now sign in, the session cookie rides every API call, the app knows who you are and what you can do, and nav renders only permitted links. It's all wired but **dormant** — the anon→login redirect and no-flash gate only activate when `NEXT_PUBLIC_AUTH_ENFORCE=1`, flipped together with the API's `NEXUS_RBAC_MODE=enforce`. So shipping it changed nothing for current users.

- **`/api/auth/me`** now returns `{ user, isOwner, permissions[] }` — the web gates UI without a second round-trip.
- **Credentialed fetch** — a scoped global `window.fetch` wrapper adds `credentials:'include'` + the `x-nexus-csrf` header for API-origin requests, covering all 623 raw-fetch sites without editing them. In-memory CSRF store.
- **`AuthProvider`** (client) — resolves the session on mount (`/csrf` + `/me`) and provides `usePermission()`, `<Can>`, `useAuth()`. The anon→login redirect + no-flash splash are gated on `NEXT_PUBLIC_AUTH_ENFORCE`.
- **Auth pages** (standalone, no app chrome): `/login`, `/forgot-password`, `/reset-password`, `/accept-invite`, `/403` — branded, wired to the S1 endpoints.
- **Nav filtering** — `buildAppNav()` results filtered by page permission for signed-in users (full nav for anonymous/shadow, so the open app is unchanged).

## 2. Files

New: `apps/web/src/lib/auth/{csrf-store,install-fetch,nav-permissions}.ts` + `AuthProvider.tsx`; `app/_auth/AuthCard.tsx`; pages `app/{login,403,forgot-password,reset-password,accept-invite}/`. Modified: `api/routes/auth.routes.ts` (`/me`), `web/app/layout.tsx`, `components/layout/AppShell.tsx`, `app/_shared/AppNavRail.tsx`. Commit `729eeabf`.

Validated: api + web `tsc`, full `next build`, RBAC coverage, UI token guard — all green. Prod sanity: `/me`→401 unauth, gated endpoints still 200 in shadow.

## 3. The interim-topology limitations (important)

You gave me the `vercel.app` + `railway.app` URLs (no custom domain). Because those are **different Public-Suffix-List domains**, three things can't be done cleanly on them, and all three are fixed by the custom domain (Option A, `app.`/`api.xavia.it`):

1. **Auth resolves client-side, not server-side.** The Next.js server can't read the API-origin session cookie, so there's a brief client-side resolve (a splash in enforce mode) instead of true server-side "no flash before first paint." Functional, slightly less ideal.
2. **The 17 Vercel-direct Prisma routes** (`app/api/*`) bypass the Fastify RBAC gate entirely and can't read the session cookie either — so in enforce mode they'd remain **unauthenticated** (a real gap: incl. `DELETE /api/catalog/products/[id]`, cache-clear). They need consolidating behind the API, or Option A.
3. **Cross-site cookies** (`SameSite=None`) are Safari-ITP-fragile.

**My recommendation: stand up the custom domain before flipping enforce.** It closes all three at once and makes the whole thing robust. If you'd rather flip on the interim setup, we can — accepting the three caveats and gating/proxying the 17 routes as a fast-follow.

## 4. What's left for S3 — and why it's a gate

Two items remain, both needing your input:

**A. Financial UI gating (needs your approval).** The API already strips financial fields server-side in enforce mode (S2) — that's the actual security. The remaining work is *client-side polish*: wrapping financial columns/widgets/KPIs in `<Can permission="financials.view">` so a non-finance user sees a clean layout instead of empty columns. But that means editing **existing working columns**, which per your standing rule I don't touch without approval. I'll do it as a reviewed sweep once you OK the approach.

**B. The enforce flip (go-live) — the point of no return.** Turning on enforcement locks out anyone without a valid session, and **the owner account still has no password.**

### Go-live checklist (coordinated)
1. **You set the owner password** — I never handle it:
   ```
   NEXUS_OWNER_INITIAL_PASSWORD='<strong 12+ char>' NEXUS_OWNER_EMAIL=awaissulhry@gmail.com \
     npx tsx apps/api/src/scripts/bootstrap-owner.ts
   ```
2. **Verify login end-to-end** (I'll drive this in the browser once a password exists): sign in → session cookie set → nav filters to OWNER (sees all) → data loads.
3. **Decide the topology** — custom domain (recommended) vs interim + caveats.
4. **Guard/consolidate the 17 Vercel-direct routes** (if flipping on interim).
5. **Approve the financial-UI sweep** (item A).
6. **Flip enforce** — `NEXUS_RBAC_MODE=enforce` (Railway) + `NEXT_PUBLIC_AUTH_ENFORCE=1` (Vercel), together.
7. **Verify per role** — ideally with a scratch DB + `seed-dev-users`, or by inviting real teammates.

## 5. Rollback

All shadow-safe and reversible: unset the two enforce env vars to instantly return to open/shadow. No migration. Revert commit `729eeabf` to remove the web machinery entirely.

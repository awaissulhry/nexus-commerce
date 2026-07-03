# Nexus Access Control — Setup & Go-Live Guide

A step-by-step runbook to take the auth/RBAC system from **shadow** (built, inert)
to **enforcing** (live). Follow **Path A** (custom domain — recommended) or
**Path B** (interim, current hostnames). Every step says exactly where to click
or what to run.

> **Where you are now:** S0–S3 are built and deployed. RBAC runs in *shadow mode*
> (resolves + logs, never blocks). The `awaissulhry@gmail.com` OWNER account
> exists but **has no password**. The app works normally for everyone.

> **What "going live" does:** turns on enforcement. After the flip, anyone
> without a valid session is redirected to `/login`, and every API call is
> checked against the caller's permissions. This is reversible — unset two env
> vars to return to shadow.

---

## What you'll need

- **Railway** dashboard access (the `nexusapi` service → Variables).
- **Vercel** dashboard access (the web project → Settings → Environment Variables).
- **DNS** access for `xavia.it` (your registrar) — Path A only.
- A **terminal** in the repo with the prod `DATABASE_URL` in `.env` (you already have this).
- A **strong password** you'll set for the owner (12+ chars).

---

## Path A — Custom domain (recommended)

Closes all three interim limitations at once (server-side no-flash, the 17
Vercel-direct routes, and Safari cookie fragility). ~30 min of DNS + config.

### A1. Point subdomains at Vercel and Railway

**Web → `app.xavia.it` (Vercel):**
1. Vercel → your web project → **Settings → Domains → Add** → `app.xavia.it`.
2. Vercel shows a DNS record (usually a `CNAME` to `cname.vercel-dns.com`). Add it at your `xavia.it` registrar.
3. Wait for Vercel to show **Valid Configuration**.

**API → `api.xavia.it` (Railway):**
1. Railway → `nexusapi` service → **Settings → Networking → Custom Domain → Add** → `api.xavia.it`.
2. Railway shows a `CNAME` target. Add it at your registrar.
3. Wait for Railway to show the domain as **Active** (TLS issued).

### A2. Set environment variables

**Railway (`nexusapi` → Variables):**
```
COOKIE_DOMAIN        = .xavia.it
NEXUS_WEB_ORIGINS    = https://app.xavia.it
NEXUS_WEB_URL        = https://app.xavia.it
```
- `COOKIE_DOMAIN=.xavia.it` makes the session cookie same-site (`SameSite=Lax`, shared across `app.` and `api.`) — robust, not Safari-fragile.
- `NEXUS_WEB_ORIGINS` adds the new origin to the CORS allow-list (comma-separated for more).
- `NEXUS_WEB_URL` makes invite/reset **email links** point at the new host.

**Vercel (web project → Environment Variables, Production):**
```
NEXT_PUBLIC_API_URL  = https://api.xavia.it
```
Then **redeploy web** (Vercel → Deployments → Redeploy) so the new API URL is baked in.

### A3. Continue to "Set the owner password" below, then "Flip enforce".

---

## Path B — Interim (current `vercel.app` / `railway.app`, no custom domain)

Works, with three caveats: client-side auth resolve (brief splash, no true
server-side no-flash), Safari may drop the cross-site cookie, and the 17
Vercel-direct Prisma routes stay unauthenticated (I'd guard those as a
fast-follow). No DNS or env-origin changes needed — the cookie is already
`SameSite=None; Secure` in this mode. Skip to "Set the owner password".

---

## Set the owner password

Run this in the repo terminal. **You type the password — I never see it.** Idempotent.
```bash
NEXUS_OWNER_INITIAL_PASSWORD='<your strong 12+ char password>' \
NEXUS_OWNER_EMAIL=awaissulhry@gmail.com \
  npx tsx apps/api/src/scripts/bootstrap-owner.ts
```
Expected: `✓ OWNER bootstrap complete … password: set from NEXUS_OWNER_INITIAL_PASSWORD`.

*(Alternative: leave the password unset and use the `/forgot-password` page once
enforcement is on — but email must be enabled, so setting it here is simpler.)*

## Verify login BEFORE flipping enforce (do this in shadow)

While still in shadow, confirm the whole path works so the flip is safe:
1. Open the web app (`https://app.xavia.it` or the Vercel URL) → go to `/login`.
2. Sign in with the owner email + the password you set.
3. You should land on the dashboard, and (as OWNER) see the **full** nav.
4. Sanity via API (replace host):
   ```bash
   curl -c j https://api.xavia.it/api/auth/csrf                    # → {csrfToken}
   curl -b j -c j -X POST https://api.xavia.it/api/auth/login \
     -H 'content-type: application/json' -H 'x-nexus-csrf: <token>' \
     -d '{"email":"awaissulhry@gmail.com","password":"<pw>"}'      # → {ok:true, user:{roleKeys:["OWNER"]}}
   curl -b j https://api.xavia.it/api/auth/me                      # → {user, isOwner:true, permissions:["*"]}
   ```
If login works in shadow, enforcing is safe (it only *adds* the gate).

## Flip enforce (go-live)

Set **both** together, then redeploy both:

**Railway (`nexusapi` → Variables):**
```
NEXUS_RBAC_MODE = enforce
```
**Vercel (web → Environment Variables, Production):**
```
NEXT_PUBLIC_AUTH_ENFORCE = 1
```
Redeploy API (Railway auto-redeploys on variable change) **and** web (Vercel → Redeploy).

After this: unauthenticated users → `/login`; every API call is permission-checked;
financial fields are stripped for anyone without `financials.view`.

## Verify per role (after go-live)

- As OWNER: everything visible, all pages load.
- Invite a teammate (or use a scratch DB + `NEXUS_ALLOW_DEV_SEED=1 npx tsx apps/api/src/scripts/seed-dev-users.ts`) at, say, `FULFILLMENT`, and confirm: the Financials nav item is gone, financial columns are absent, and hitting a financials URL directly returns 403.

---

## Rollback (instant)

Enforcement is a switch, not a migration:
- Railway: delete `NEXUS_RBAC_MODE` (or set it to `shadow`).
- Vercel: delete `NEXT_PUBLIC_AUTH_ENFORCE`, redeploy.

The app returns to open/shadow immediately. To undo the domain move, revert
`NEXT_PUBLIC_API_URL` / `COOKIE_DOMAIN` / `NEXUS_WEB_ORIGINS`.

---

## Troubleshooting

| Symptom | Cause → fix |
|---|---|
| Login returns 200 but you're immediately bounced back to `/login` | Cookie not being stored. Path A: check `COOKIE_DOMAIN=.xavia.it` + both subdomains under `xavia.it`. Path B (Safari): known ITP limitation → use the custom domain. |
| Every API call is 401 after enforce | Web isn't sending the cookie. Confirm `NEXT_PUBLIC_API_URL` points at the API host and web was redeployed. |
| CORS error in the browser console | The web origin isn't allow-listed. Add it to `NEXUS_WEB_ORIGINS` on Railway and redeploy the API. |
| 403 on a page the user should see | The route→permission mapping or the role's permissions. Check `docs/security/S0-PERMISSION-REGISTRY.md`; adjust the role in the (S4) console or `packages/shared/permissions.ts` + re-seed. |
| Invite/reset emails don't arrive | Set `NEXUS_ENABLE_OUTBOUND_EMAILS=true` on Railway (and `RESEND_API_KEY`). Until then the invite **link** is still returned to the owner to copy. |
| Locked out of the owner account | 5 bad passwords → temporary lock (backoff). Wait it out, or clear `failedLoginCount`/`lockedUntil` on the `UserProfile` row, or use `/forgot-password`. |

## Recommended order

1. **Path A** (custom domain) — do the DNS + env now; it's the clean foundation.
2. **Set the owner password.**
3. **Verify login in shadow.**
4. **Flip enforce.**
5. **Invite your team** (Settings → Team & Access — the console UI lands in S4;
   until then, create invites via `POST /api/auth/invitations` as the owner).

Questions or a step misbehaves — tell me what you see and I'll walk it through.

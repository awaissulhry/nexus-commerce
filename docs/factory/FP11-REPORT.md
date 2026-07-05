# FP11 — Settings & Team: build report (gate 2, awaiting Owner click-through)

Shipped 2026-07-06 against the approved `FP11-SPEC.md`. Four build commits (FP11.1 team service + members + invitations + accept → FP11.2 custom roles + matrix → FP11.3 settings depth → FP11.4 enforce verify + WhatsApp decision). **This closes the 11-page arc — Factory OS is complete.** The auth schema, Owner-supremacy guardrails, and `permissionCatalog()` that have been live since F1 now have a face, and RBAC is proven ready to enforce. Built on Opus 4.8. **Migration-free**; no new dependency; **+1 permission** `settings.manage`.

## Eng trans

Open **Settings** and the platform now runs itself. **Team & roles**: invite someone (email + role → a one-time join link they open to set their own password and land in), see your members, reassign or deactivate, and build **custom roles** by ticking permissions in a matrix. Every change is guarded — you can't remove the last owner, system roles are locked, unknown permissions are refused. **Configuration**: rename or reorder the **stage pipeline** (new work orders read it), set the **margin-floor / deposit / VAT** defaults, and see your nightly **backups**. And RBAC is ready to turn from *shadow* (logs would-be denials) to **enforce** (a missing permission is a real 403) — proven safe before a second person ever logs in.

## What was verified (headless, isolated `:3199`)

| Check | Result |
|---|---|
| **Invite → accept** | invite → one-time join link → the invitee sets a password → lands in as an active **WORKER** member; a used link is refused ✓ |
| **Owner guardrails** | deactivating or demoting the **last owner** is refused (400) ✓ |
| **Custom roles** | create (2 perms) → edit (3) → delete-unused; **system role** edit + delete refused; **unknown permission** refused ✓ |
| **Stage pipeline** | add / reorder / rename → saved (new work orders read it) ✓ |
| **Defaults** | margin-floor / deposit / VAT written to their AppSettings ✓ |
| **Backups** | the `.snapshots/` list + the read-only restore note ✓ |
| **RBAC enforce** | in `enforce`: OWNER passes all; **WORKER gets 403** on financials / analytics / team but 200 on production; a gated page still **renders** (no SSR crash) ✓ |

Battery: **201/201 unit tests · 126/126 routes RBAC-covered · DS parity byte-identical · no-touch clean · tsc + build green · 29 headless assertions across FP11.1–11.4 · zero page errors.** The team page (members, invitations, the role matrix), the config page, and the join page were reviewed at native resolution — clean, on-token. Test users/roles/invitations swept; your data (1 user, the two system roles) is untouched.

The risk lives in the guardrails (pinned by the F1 `guardrails.test.ts` — last-owner, system-role, unknown-permission, owner-grant) and the enforce boundary (proven above; every route is already `guarded()`).

## The WhatsApp decision (FD5) — for you to settle at the gate

FD5 deferred the WhatsApp channel to FP11 "to decide with real volume." Here it is, both paths:

- **Unofficial bridge** (whatsapp-web.js / Baileys) — **free**, but it drives a logged-in WhatsApp Web session that **breaks on WhatsApp's updates**, risks an **account ban** (against Meta's ToS), and needs a persistent browser session on your machine. You already know these trade-offs from Xavia Automation.
- **Meta WhatsApp Cloud API** — **official and reliable**, but **per-message pricing**, business verification, and pre-approved message templates for anything you initiate.

**My recommendation: defer the channel, keep the rails ready.** There's no urgent WhatsApp volume today, and for a *business* you don't want to build customer comms on a bridge that can get the number banned. When real volume justifies it, the **Cloud API** is the honest path — and it drops in as a second `Conversation.channel` behind the same Inbox (the schema is already channel-pluggable). If you'd rather start now, say the word and I'll spec the Cloud API integration as a follow-up. **Nothing about this blocks anything.**

## Deviations from spec (flagged)

1. **The live `enforce` flip is your gate step** — I verified it fully on the isolated build (above); flipping your running `:3100` is `FACTORY_RBAC_MODE=enforce` in `apps/factory/.env` + a restart, which we do together (a posture change on your live instance).
2. **No in-app backup *restore* button** — the panel lists snapshots and shows the one-line `cp` restore command; an in-app "restore over the live DB" button is deliberately not built (too sharp to click by accident).
3. **The WhatsApp channel is decision-only** — presented above; the transport is a follow-up once you pick.
4. **Stage reorder is ↑/↓, not drag** — reliable and clear (matching FP2's option reorder); drag is a later nicety.
5. **One role per user (v1)** — the schema allows many; the UI assigns a single role, which is the whole need today.

## What lives where

| Surface | Path |
|---|---|
| Team service (guardrail-checked) | `src/lib/auth/team-service.ts` (over the F1 `guardrails` + `permissions`) |
| API | `src/app/api/team/*` (members · invitations · roles · PUBLIC accept) · `src/app/api/settings/*` (config · backups) |
| UI | `src/app/(app)/settings/team` + `/config` · the PUBLIC `src/app/join/[token]` · the Settings hub |

## Your click-through (the FP11 gate — the finish line)

`/settings/team` → **Invite** a WORKER → open the join link in a private window, set a password, land in with the reduced nav → back as OWNER, create a custom **role** in the matrix, and watch the guardrails refuse removing the last owner / editing a system role → `/settings/config` → reorder a **stage**, set **margin/deposit/VAT**, see the **backups** → then, **together, flip `FACTORY_RBAC_MODE=enforce` + restart `:3100`** → and **settle WhatsApp** (defer, or ask me to spec the Cloud API).

## Rollback

`git revert` the four FP11 commits (factory-scoped). No migration; the `settings.manage` permission is additive. The enforce flip is reverted by setting the env back to `shadow` + restart.

## The arc is complete

**Factory OS — 11 pages, F0 → FP11 — is done:** Gmail thread → quote → order → production → materials → shipping → financials → analytics → and now self-governing team & settings. Everything else (WhatsApp channel, a global audit viewer, richer auth flows) is a named follow-up, not a gap.

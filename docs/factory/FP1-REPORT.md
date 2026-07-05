# FP1 — Inbox: build report (gate 2, awaiting Owner click-through)

Shipped 2026-07-05 against the approved `FP1-SPEC.md`. Four commits (FP1.1 backend core → FP1.2 API surface → FP1.3 three-pane UI → FP1.4 fixes/verification). **The Inbox is live at `/inbox`** — the ComingSoon empty state is retired. Zero files outside `apps/factory/` + `docs/factory/` touched.

## Eng trans

Your Inbox is now a working workspace, not a preview. Open it and your real threads are there — *AWA ORDER 652/2026 BARTOCCETTI* and the rest — with full email bodies rendered safely (remote images blocked until you click, the way serious mail clients do it). You can **reply from inside the platform and it sends from your own Gmail, threading correctly** — the customer sees a normal reply, and Gmail's own app shows it in the same conversation. The composer has two modes that look nothing alike: blue Reply (goes to the customer) and amber **Internal comment** (never leaves the building; @mention a teammate and their bell rings). Close a thread when the work is done — if the customer replies, it reopens itself and notifies whoever owned it. Snooze hides a thread until a date; a reply un-snoozes it. Set a follow-up reminder when you're waiting on someone — it cancels itself if they answer first, so you never double-chase. And the moment you click **Create contact from sender** on one of those "unmatched" threads, every other email from that person — or their whole company domain, your choice — links up instantly, past and future.

## What was verified (headless, isolated server on :3199 — real data, NO live sends)

- Login → `/inbox`: all 50 real conversations render with state tabs, live counts, freshness line ("Mail synced Xs ago · label INBOX").
- Opening *Security alert* (first thread): body fetched from Gmail on first open, sanitized, rendered in the sandboxed iframe with images blocked; context rail shows the unmatched-sender banner + Create-contact button + the reserved FP3/FP4 "Linked" slot.
- Internal comment posted via API → renders amber with the "Internal — never sent" tag in the timeline (test rows removed afterwards; AuditLog keeps the record).
- Keyboard: `j/k` cursor, `Enter` opens, `Escape` returns — including after a hard reload (see Findings #2).
- Attachment pipeline on real data: `Tuta_Bartoccetti_AirBag.jpg` from *AWA ORDER 652/2026* downloaded byte-exact (354,453 bytes), volatile-Gmail-id refresh path in place.
- Battery: **58/58 unit tests** (sanitizer XSS suite, MIME threading headers, matcher incl. domain rows, ledger, registry, field-strip incl. the new Date regression) · **31/31 routes** RBAC-covered · no-touch clean · DS parity 97/97 · build + typecheck green · zero page errors.
- NOT verified by automation (yours, deliberately): live reply sending and Drive save — automation must never send real email.

## Findings & fixes during the cycle (all shipped)

1. **`stripFinancials` flattened every `Date` to `{}`** ("Invalid Date · NaNd" across the UI — caught by screenshot review, invisible to the numeric checks). A `Date` is an object with no enumerable keys; the filter now treats `Date`/`Buffer` as leaf values, with a regression test. This affected any `jsonStripped` route — fixed platform-wide.
2. **`router.replace("/inbox")` silently no-ops** when clearing the `?focus=` param on a freshly-loaded document (worked after client-side navigation). Isolated with a three-scenario probe; fixed with Next's documented shallow-routing interop (`window.history.replaceState` syncs with `useSearchParams`) — also faster, since focus is pure UI state and needs no server roundtrip.
3. **Prisma `migrate dev` cannot run against the live WAL database** (the Owner's server holds it; Prisma's connection has no busy timeout). Applied the (purely additive) migration SQL through better-sqlite3 with `busy_timeout=60s` and recorded it in `_prisma_migrations` manually. Recipe documented in PLAYBOOK for future migrations — **or** stop the dev server for the seconds a migration needs.
4. `sanitize-html`'s `transformTags` additions (`target`/`rel` on links) are stripped again unless allow-listed — caught by the XSS test suite.
5. `cid:` inline images (embedded logos in some HTML mail) render as placeholders in FP1 — the attachment list below the message covers the content; proper `cid:` resolution is in the backlog.

## Your click-through (the FP1 gate)

1. Restart the app if it's running (`Ctrl+C`, `npm run dev -w @nexus/factory`) — picks up four commits and one migration.
2. **Inbox**: open it. Your threads, tabs with counts, freshness line. Type in search; toggle Unmatched.
3. **Open an AWA order thread**: body renders; click **Load remote images** on something with pictures; download an attachment; try **Drive** on one (lands in your Nexus Factory folder, link appears).
4. **Create a contact**: on an unmatched customer thread → *Create contact from sender* (try "match everyone @domain" on a B2B sender like your own forwards) → watch its other threads link (toast tells you how many).
5. **The composer**: write an **Internal comment** first (amber, safe); then a real **Reply** on a thread you own — send yourself something, reply to it here, and check in Gmail that it threaded (this is the one step automation didn't do).
6. **Work semantics**: Close a thread → reply to it from the other mailbox → within ~10s it reopens (assigned to you if you'd taken it) and your bell rings. Snooze one (`s` = tomorrow 08:00), set a follow-up on another.
7. **Keyboard**: `j`/`k`, `Enter`, `Esc`, `e` (close/reopen), `r` (jump to composer), `⌘⏎` (send), `⌘K` (search still global).
8. Bulk: select a few noise threads (DHL notifications…) → Close.

## Rollback

`git revert` the four FP1 commits (or `817747dd..HEAD` factory-scoped). The migration is additive — reverting code leaves harmless unused columns; a down-migration (drop columns + FactoryEventOutbox) is trivial if ever wanted. No commerce surface involved.

## Deferred (recorded in PLAYBOOK backlog)

`cid:` inline images · @mention autocomplete UI (mentions resolve from typed @handles today; picker lands with the first heavy-comment page) · read/unread per user · attachment upload on internal comments · reply-with-quote button (FP3 — the "Linked" rail slot is waiting for it).

**Next on approval: FP2 — Products & Pricing (spec first, per protocol).**

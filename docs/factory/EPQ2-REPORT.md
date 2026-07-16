# EPQ.2 — Gate report: no offer dies of silence

Built to `EPQ-PROPOSAL.md` §5 EPQ.2 by a worktree agent (merged `964e549b`), migration `epq2_quote_views` applied live + harness, runtime restarted (trap 6b).

## Plain English
You now see when a customer opens a quote ("2× · 3d ago" right in the pipeline, plus a bell the first time), and quotes that go quiet surface themselves: a "Needs follow-up" queue on the quotes page flags what's not viewed after 3 days, viewed-but-silent after 7, and expiring within 3 — each with a one-click nudge that shows you the Italian text first (you edit, you send, into the same Gmail thread — nothing auto-sends, per D-2). Recording an acceptance or converting now rings the other owners' bells. And the wiring gaps closed: converted quotes finally link to their order, the search deep-link works, the dead Overdue tile became a clickable "Expiring soon" filter, and every action confirms itself with a toast.

## Shipped
View tracking (QuoteViewEvent + counters; superseded links tracked too, version-stamped — feeds EPQ.5's evidence bundle) · first-view + manual accept/reject/convert notifications (`notify-owners.ts`, actor excluded) · follow-up engine (pure `followup.ts` core; per-rule dedupe, snooze 3d, dismiss-with-resurface; cadence + templates in AppSetting `quotes.followup`, editable from the queue's gear — stays on the quotes page per the home-page rule) · nudge route with preview-modal (threaded via extracted `mail.ts`; no PDF, no version freeze) · gaps 1/3/4/6/15/16 from the UI inventory.

## Bonus fix
The shared mail helper now stamps `Conversation.lastMessageDirection` on quote sends — an FS1 invariant the FP3-era send route predated; quote sends previously left the unanswered-counter stale.

## Deviations (accepted)
Orphan PDF file on a Gmail-down send (overwritten on retry, no DB state); cadence gear only visible when the queue has rows; nudges 400 on non-SENT; operator-facing notifications in English, customer-adjacent strings Italian (house convention).

## Verified
312 tests in-worktree (25 new) → 338 on main post-merge · rbac 129 · query-bounds 131 files · no-touch · ds-parity 97/97 · build · **headless smoke on a scratch DB, 10/10** (flag→one bell→no re-bell→snooze→view→first-view bell→clear-on-view→non-SENT ignored). Remaining live step: your first real nudge send (Gmail, never automated) — the preview modal is the control point.

## Push note (coordination)
Origin push is temporarily blocked by the shared pre-push DS ratchet tripping on a commerce-side commit from the flat-file session (native selects in `ImportWizardModal.tsx`, manifest `products`); that session owns the fix. All factory work is committed locally; it rides the next clean push.

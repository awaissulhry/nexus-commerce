# EPI3-REPORT — Views & Automated Routing gate report (built to `EPI3-SPEC.md`)

Delivered 2026-07-17. The Owner's sections ask is live: header pills that ARE saved queries — automatic and retroactive routing by construction — plus manual pin/exclude overrides, the Gmail-tabs route-prompt, and an ordered ingest-rules layer with dry-run. First EPI migration (additive, live-DB protocol honored). Verified headlessly end-to-end on the real 2,782-conversation corpus; the verifier caught **one real bug** (null-blind assign filter — fixed same session, corrected shape empirically validated). ⏳ Awaiting Owner click-through.

## Plain-English summary (what changed for you)

- **Your inbox now has sections.** Click **+** in the new pills row, say "Sender domain is awa.it", watch the live preview count real matches as you type, save — and every past AND future email from that brand sits in its own tab. Exclusive by default: claimed threads leave the main Inbox (a toggle keeps them in both). Tab order = priority; counts are live and honest.
- **Right-click any conversation**: pin it into a section (it then asks "route the whole domain here?" — accepting adds a visible condition, never a hidden rule), exclude a wrong match, or spin a **new view from that sender** in two clicks.
- **Rules** (⚙ next to the pills): "WHEN mail arrives IF domain is X THEN assign Giulia / close" — applied once when a conversation is born, top-to-bottom with stop-processing. **Run now** sweeps existing mail with a checkbox diff of exactly what would change before anything does.
- Everything deep-links (`?view=`), cycles with Tab, survives reloads, and leaves visible tracks in the thread timeline ("pinned to a view", "routed by a rule").

## Files (4 commits + fix)

EPI3.1 migration `epi3_views` (InboxView/InboxViewOverride/InboxRule) + pure `views.ts` membership core (12 tests) · EPI3.2 seven guarded routes + list-route membership/counts + gmail-sync ingest hook + `inbox.views.manage` permission · EPI3.3+3.4 ViewsBar/ViewBuilder/RulesDrawer/PointerMenu + InboxClient/ConversationList wiring (~1,050 lines) · EPI3.5 null-safe assign filter fix.

## Verification

621 tests · rbac 155 routes · no-touch · ds-parity · query-bounds · isolated build — green. Headless on the live corpus: view creation with live preview (1,783 predicted = 1,783 delivered), exclusive claim arithmetic exact (Inbox 2,782 → 999 → back on show-elsewhere → back on delete), deep-link + Tab cycling (focus navigation untouched), pin (+route-prompt, "just this pin" adds no criterion), exclude returns threads home, rules dry-run diff (200-row cap, checkbox subset), timeline tracks, zero residue after cleanup (0 view/override/rule rows), and a full regression sweep (lightbox/panes/counts). Rule Run-now was never applied; no conversations were mutated beyond the cleaned-up overrides.

## Findings & deviations (flagged, not hidden)

1. **Verifier-caught bug, fixed:** the Run-now "what would change" filter used `NOT(assigneeId = X)`, which SQL evaluates to exclude NULLs — unassigned conversations (an assign rule's main audience) never appeared. Now null-safe; the corrected shape matched the expected 1,783 live rows during the same session. Worker ingest path was unaffected (no change-filter there).
2. **Ingest-on-arrival verified by trace + shared engine, not live mail:** rules fire at conversation creation in the sync path; no new real email arrived during the verify window. The criteria/action engine is the same code Run-now exercised.
3. **View counts are computed per request** (one bounded count per view under the active filters). At 10+ views on the 50k harness this is the first thing to watch; the FS0 harness re-run is part of the Owner gate if view count grows.
4. **Environment note:** a concurrent session's verify server took over :3199 mid-run; ours moved to :3198 (recorded in the concurrent-sessions memory — verify ports now probe availability).
5. Reorder verified at unit level (claim-priority math) + single-view UI; multi-view drag reorder is ↑/menu-based v1.

## Rollback

Revert the UI commit for the pre-views inbox; the migration is additive (tables can stay, empty). The EPI3.5 fix stands alone.

## Click-through script (Owner)

1. Click **+** in the new pills row → "Sender domain is" one of your brand domains → watch the live count → name it → Create. 2. The pill appears with its count; the Inbox pill drops by the same amount; click both, reload mid-view. 3. Press Tab with nothing focused — sections cycle. 4. Right-click a stray conversation → Pin to your view → try "Route the whole domain here" on a second one. 5. Right-click a wrong match inside the view → Exclude → it's back in Inbox. 6. ⚙ Rules → New rule (assign yourself for that domain) → **Run now** → see the exact diff with checkboxes → apply a couple → their timelines show "routed by a rule". 7. Edit the view → toggle "also keep in Inbox" → watch counts. 8. Delete the test artifacts or keep them as your first real sections.

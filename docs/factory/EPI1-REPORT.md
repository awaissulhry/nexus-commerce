# EPI1-REPORT — Perfection Sweep gate report (built to `EPI1-SPEC.md`)

Delivered 2026-07-16 against the approved EPI proposal ("Approved, proceed with your recommendations"). All 22 spec items shipped; verified headlessly on an isolated `:3199` production build (16/16 acceptance targets PASS on first pass; 2 regressions the verifier caught were fixed and re-verified). ⏳ Awaiting Owner click-through.

## Plain-English summary (what changed for you)

- **Two real bugs are dead:** clearing a snooze date used to strand the thread invisibly forever (it now reopens), and snooze-wakes/follow-up reminders fired by the background worker were invisible (they now appear in the thread timeline and refresh open tabs live).
- **The list tells the truth:** every tab shows a count (zero included) and the counts follow your active filters/search; your filters live in the URL so a reload or shared link keeps them; if the list fails to load you see it (with Retry) instead of silently stale rows.
- **No more broken-image boxes:** blocked remote images hide behind a neat "n images hidden" line; forwarded emails no longer repeat the same attachment chips (a "repeated from earlier" expander replaces them).
- **Panes are keyboard citizens:** the separators respond to ←/→/Home/End, Enter collapses the details rail, and on windows narrower than 1280px the rail folds into a strip that opens as a slide-over. Composer height is remembered.
- **The rail behaves:** an intentional empty state instead of a blank column, "not priced yet" instead of "€0.00 · 0%" on unpriced drafts, a new **Link existing contact** picker (the server always supported it), and every control your role can't use is gone rather than dead.
- **Bulk actions grew Assign**, keyboard `e`/`s` now confirm or explain themselves, and the whole page is one type scale in one font.

## Files (3 commits: `50f91ea2` core · `d6adae0d`+follow-up UI · regression fixes)

- NEW `src/lib/inbox/{patch,list-where,attachments}.ts` + `src/lib/__tests__/epi1-inbox.test.ts` (11 tests)
- `api/inbox/route.ts` (filter-honest counts) · `api/inbox/[id]/route.ts` (pure patch resolver) · `api/quotes/route.ts` (pricing.updated on create) · `worker/index.ts` (audited + published wakes)
- All five inbox components + `types.ts` · shared `src/components/PaneHandle.tsx` (additive keyboard grammar) · `globals.css` (.epi-inbox scoped rules)

## Verification

313 unit tests · `check:rbac` 126 routes · `check:no-touch` · `check:ds-parity` 97/97 · `check:query-bounds` · isolated build — all green. Headless (:3199, OWNER session minted+revoked, zero mutations): 16 acceptance targets PASS — filter-honest counts (2771→997 on toggling Unmatched), URL filters survive reload, one font family + {11.5,12.5,13,14.5} scale, symmetric header padding, image placeholders + dedupe + rail states verified on real mail, pane keyboard + legacy-storage migration, 1200px drawer with zero overflow, load-error banner + recovery, CLS 0.0002.

## Findings & deviations (flagged, not hidden)

1. **Two regressions found by verification, fixed same-day:** the bulk bar clipped past the pane edge at narrow widths (now wraps, scoped CSS); Enter on a focused pane separator also opened the conversation under the cursor (separators now own their keys).
2. **Typography outliers that remain are DS-owned:** `Pill` (11px) and `Card` header (15px) come from the untouchable DS copy — law says the DS is canonical, so they stand.
3. **Drag-past-min snap-close deferred:** the FS3 pane hook clamps at min during drag without exposing overshoot; Enter/chevron collapse covers the need. Named for FS3 if wanted.
4. **Worker changes need the Owner's `:3100` dev server restarted** to load the new worker code (no migration; the running process just predates the change).
5. **Commit-history blemish from a concurrent-session race:** a follow-up tweak was briefly amended onto another session's commit; history was repaired the same hour (linear, nothing lost, both sessions' work preserved under their own messages) and the no-amend rule is re-documented. One 3-line tweak commit carries the other session's message (`77f614fb`).
6. `?` shortcut overlay intentionally out (later phase per spec).

## Rollback

Each commit is independent; reverting the UI commit restores the FP1 layout (the pure-core commit is safe to keep — it only fixes bugs). No migration to unwind.

## Click-through script (Owner)

1. Restart `npm run dev` (picks up the worker change). 2. Open /inbox: every tab shows a count; toggle Unmatched — counts change. 3. Pick Closed + type a search → reload the page → both restored. 4. Open a newsletter-ish mail: "n images hidden" line, no broken boxes; Load images → renders. 5. Open the TORINO thread: "2 files repeated from earlier · show". 6. Snooze a test thread to tomorrow, then clear the date — it returns to Open (the old bug left it stuck). 7. Drag + double-click a pane handle; press Enter on the right handle — rail collapses; narrow the window under 1280px — strip + slide-over. 8. Select two threads → Assign from the bulk bar. 9. On an unmatched sender: "Link existing contact" search works. 10. `e` on a thread → "Closed — work done" toast; `e` again → "Reopened".

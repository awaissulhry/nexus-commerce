# PR.6 — Presence design system

Status: **complete — W2-DS, P-A11Y and PR.6 AT-WAVE-4.** Nothing committed or pushed. No database/channel writes. Owner’s follow-up approved the recommended ScopeBar/ModeNotches repair, value-preserving rail alias, prototype token correction and stronger existing text tokens.

The contract, Menu adapters, renderers, confirmation component, accessibility repairs and Factory mirrors are implemented. Web TypeScript **exit 0** and Factory TypeScript **exit 0**, each with private build-info. Node Vitest **110 files / 1,367 tests passed** (109 DS files / 1,366 tests plus one ModeNotches file/test), maxWorkers=2, 9.19 seconds. Web declarations **260/260** pass freshness; Factory’s **191/191** emitted declarations byte-match. Both declaration builds exit 0. Original declared set included registry, NexusGrid, DataGrid, Modal, Tabs, Drawer, Listbox, Menu and touched emitted sources: 25 web / 190 Factory copies. The follow-up declared eight paths before copying, minimum source age149.24 seconds, unchanged source mtimes, zero skipped. Catalog/tests/tools/CSS and the feature-only ModeNotches have no checked-in declaration emit under the existing configuration.

## Final verification series

All 17 commands below exited0 in the 21:09–21:11 local sequence on the final DS source. Web tsc/test rerun completed after the21:06 padding cleanup; the final ScopeBar CSS-only fix is covered by this final gate series and its browser rerun. Uptime was read before every launch, with load under8; exits were captured by redirection into the adjacent resume-final logs. Empty tsc logs accompany captured process exit0. Both token generators also pass --check. git diff --check for the DS and changed gates passes.

| Command | Exit | Load before launch |
|---|---:|---:|
| `node scripts/check-focus-visible.mjs` | 0 | 3.97 |
| `node scripts/check-token-role.mjs` | 0 | 3.97 |
| `node scripts/check-silent-disabled.mjs` | 0 | 3.97 |
| `node scripts/check-ds-dts-fresh.mjs --check` | 0 | 4.14 |
| `node scripts/check-ds-fork-drift.mjs --check` | 0 | 4.51 |
| `node scripts/check-grid-swatch-contrast.mjs --check` | 0 | 4.51 |
| `node scripts/check-dark-alias-scope.mjs --check` | 0 | 4.51 |
| `node scripts/check-dark-pin-parity.mjs` | 0 | 4.51 |
| `node scripts/check-token-resolution.mjs --check` | 0 | 4.51 |
| `node scripts/check-css-parse.mjs` | 0 | 5.90 |
| `node scripts/check-css-hex-ratchet.mjs --check` | 0 | 5.90 |
| `node scripts/check-css-radius-ratchet.mjs --check` | 0 | 6.23 |
| `node scripts/check-css-ds-shadow-ratchet.mjs --check` | 0 | 6.23 |
| `node scripts/check-ag-grid-import-boundary.mjs` | 0 | 6.23 |
| `node docs/audits/2026-09-13-presence/pr6/contrast.mjs --check` | 0 | 5.66 |
| `node --import tsx apps/web/src/design-system/tools/generate-tokens-css.ts --check` | 0 | 5.66 |
| `node --import tsx apps/factory/src/design-system/tools/generate-tokens-css.ts --check` | 0 | 5.66 |

Focus census:15 stylesheets,120 focus rules,106 real outlines,4 delegates,0 glow-only failures. Token-role census:15 stylesheets,1,198 color declarations,84 text-role controls,0 bare status-fill tokens used as text. Each guard catches a bad positive-control fixture and accepts a conforming one in the same run; before source fixes they exited1 with23 focus failures and22 text misuses. Those first RED logs are retained. Silent-disabled widening was measured under the old detector first, followed by a separate detector-tightening write; final ads21/21, webDS10/10, Factory8/8. No baseline or detector exemption was raised. Menu’s reasonless native OFF arm remains conservatively counted; the description-bearing held arm remains focusable and guarded.

Fork guard:215 shared files,208 identical,7 existing differences,0 new drift. The swatch gate consumes PR.1’s repaired selector-list parser and positive/negative proof; its original crash convicted nothing. Its defined five plain light-row grounds pass. It still reports21 additional state-tint combinations below3:1 outside its enforced scope; this PR does not claim those cycle colors are repaired. The full diagnostic is retained. Token-resolution’s five prototype references now use existing surface-raised; the shared-shell hex count is held by replacing the same-color rail-chevron literal with its existing grey-450 alias.

## Contract and render behavior

Typed reach is checked before nonlocal preflight use; typed reversibility allows frictionFor/validateImpact to refuse a softer rung. validateAction can see the action-level reach and rejects missing channel reversal. runAction delivers an honest unavailable refusal before internal diagnostics. **This is a contract enhancement:** the audit refuted inability to express reversibility as a defect; enforcing existing prose promises justifies the stronger type contract. Legacy optional reach/reversal remain compatible; explicit Presence/nonlocal declarations receive validation.

Both menu adapters map danger without sorting declaration order. DS uses React glyphs; AG uses its Element|string icon contract. The emitted button/link selectors use danger-text, including selected items. description!=null remains the held discriminator; reasons stay in title and description. Native disabled rules acquired aria-disabled twins before the held behavior changed.

Presence is a separate pure vocabulary:8 intents,6 facts,5 verdicts; LIVE displays Listed/info. No readiness converter exists. PresenceMark uses Tag/Pill/AsOf, preserves REFUSED even with null timestamp/source, and accepts a canonical aggregate line+clock without inventing a member Presence. axis=intent|fact|both and compact detail support separate columns using the same metadata; compact explanations use existing keyboard-reachable InfoTip. Fact retains AsOf; absent check/event renders not checked/never. ActionConfirm lives in components with a grid compatibility export, exact typed subject, acknowledgement, Cancel-first focus, read-only review and typed reversal sentences. Disclosure takes Tone; SummaryTable row tone remains on a Pill. SheetStatuses retains details and alerts in its existing capped or host-requested compact treatment, defining no breakpoint.

CellSaveMark gives saving/waiting/unknown different glyph/ring shapes, with a text-colored announced mark. CellSaveReason remains beside it. Wiring guards cover the actual master columns and channel CascadeCell, with channelColumns forwarding the tracker. All provenance marks carry their existing accessible name; none adds a tab stop. ScopeBar arrows can reach a held reason without selecting it; guarded Enter/click preserve selection. The scroll-track’s clipped perimeter is inset; the held tooltip wrapper retains the same unshrinking slot as a plain chip. Held AxesPanel inclusion checkboxes preserve checked state on Space. ModeNotches uses its existing refusal callback/banner for busy/above-ceiling choices, with no onSet call; an allowed choice calls onSet once.

## Computed contrast

Source-declared grid row grounds and cell washes are composited in sRGB. Columns below are panel, surface-hover, child, selected primary-soft, danger-soft. Every minimum is over80 grounds per theme; no white-only inference.

| Text ink | Light: five named grounds | Dark: five named grounds | Minimum light / dark |
|---|---|---|---|
| danger-text #7d2621 / #f3b7b0 |9.67 /8.77 /8.54 /8.42 /8.24|8.85 /8.22 /9.20 /7.81 /8.96|7.09 /7.05|
| success-text #0b4b28 / #6ee7a8 |10.24 /9.28 /9.04 /8.91 /8.72|9.90 /9.19 /10.29 /8.74 /10.02|7.50 /7.89|
| warning-text #653a0f / #f2bc79 |9.70 /8.79 /8.56 /8.44 /8.26|8.88 /8.24 /9.23 /7.83 /8.99|7.11 /7.07|
| formula foreground #094b5e / #39d8f0 |9.63 /8.73 /8.50 /8.39 /8.21|8.89 /8.25 /9.23 /7.84 /8.99|7.06 /7.08|
| text/focus #1c2530 / #e7ebf1 |15.48 /14.03 /13.66 /13.47 /13.18|12.73 /11.81 /13.23 /11.23 /12.88|11.35 /10.14|

Every changed text ink is monotonic on every ground. Success needs no exception. Minimum SVG contrast: light3.80, dark5.88; all eight exceed3:1. ModeNotches inset currentColor measures at least4.79 on every source-declared normal/selected/hover/held/earned fill in both themes, including the actual shell pins. Its false1.37 dark reading was an instrument bug that missed a selector LIST; the instrument was corrected before any palette inference. The script’s complete output, including save rings and math controls1.00/21.00, is pasted in the ledger and retained beside this report.

## Browser evidence

The final serialized browser window19:08:17–19:09:20Z passed. A census of6,731 web/API/Factory sources finds zero saves in that exact interval, with the newly edited patterns.css as a positive control. Only PR.6’s hold was active; PR.8 explicitly yielded this slot. Hydrated Primary click changed the local result before measurement.

At1440×900 and390×844, ArrowRight selects Amazon; End+Enter focuses held Etsy and preserves Amazon; ArrowLeft selects Shopify. At390px, the held wrapper measures50.11px (before0), its label is visible, Add remains6.00px away, and the2px outline at offset−3px is wholly inside the track. Scope186.26–236.37 lies inside track181.07–241.98. Light#1c2530 and dark#e7ebf1 rings and readable labels were visually inspected in screenshots. Compact InfoTip is keyboard reachable and exposes the canonical sentence; its290px popup fits. Dev errors0. Original light theme/viewport restored and owned tab closed.

The earlier follow-up (18:49–18:52Z) verified held axes click+Space leaves checked=true with its explanation while editable Space changes the local result; both390px dialog screenshots show350px width/scrollWidth and534.05px height, Cancel focused. Final danger menu colors were measured on selected grounds: light#7d2621 on#e7f0fd, dark#f3b7b0 on#1c2f4d. Held Menu ArrowUp/Enter preserves result; Escape works. The accessibility snapshot announces all8 provenance SVGs, formula/refused and all3 save states. Dev errors0. The subsequent simultaneous18:56 browser windows were explicitly invalidated and repeated; their screenshots are interim evidence only.

Earlier owned catalog tests also verify exact CATALOG-1 typing plus acknowledgement, enabled Menu Enter positive control, Escape returning to the trigger, and local Views naming. The narrow Views prompt was corrected from left=-108.06px to62.00/right382.00; desktop547.95/right867.95. The existing ToastProvider owns the demonstration. AsOf’s SSR/client locale mismatch was fixed without changing the promoted formatters. These are local React-only demonstrations, not claims about every platform route or a production write.

## ASSUMED / QUESTION / REQUEST reconciliation

- ASSUMED: legacy optional reach/reversal compatibility follows the corrected additions-only sketch. No local readiness conversion; canonical intent LIVE, operator Listed. HELD describes Nexus sends, not a verifiable selling fact.
- ASSUMED: existing text and InfoTip primitives supply explanations; no new token. Web-only catalog and Views host remain web-only; shared components/styles/declarations are mirrored.
- QUESTION FOR OWNER: ScopeBar/ModeNotches scope, rail alias and stronger text candidates are **answered by the Owner’s follow-up**. No further PR.6 Owner question remains.
- REQUEST MX grid/editor/renderers: resolved by explicit close-out, not elapsed time. Applied only the requested ink/ring/padding/barrel hunks; preserved other lanes’ grid behavior.
- REQUEST PR.7/PR.8: pending-write sentence “Wait for the pending write to finish.” delivered for title and description. PR.8 consumed SheetStatuses data/compact API; classification/requirements dialogs remain its feature ownership.
- REQUEST PR.7: CellSaveMark mounted beside CellSaveReason in both actual sheet renderers; PR.6 wiring guards widened and pass. The earlier proposed adapter mount was withdrawn after tracing the real renderer chain.
- REQUEST PR.7/PR.8: seven inline-message sites delivered: MasterSheet, FamilyVariants, FamilyBar, FamilySelectionBar, SheetToolbar, GridViewsMenu, GdsScenarios. PR.6 owns/completed GridViewsMenu; the feature owners retain their files.
- REQUEST PR.7 formatter move: one ago/when implementation promoted to DS format; old drawer path re-exports, paired save acknowledged.
- REQUEST PR.7/PR.8 canonical line, aggregate clock, axis and compact: implemented, mirrored, regenerated and tested. No family member fabricated for a distribution.
- REQUEST PR.8 padding: desktop0/6px correction preserves existing <=1279px padding-block6 policy. Obsolete padding declarations were removed from the old sheet rule and its narrow override, leaving the specific pair as sole owner. No new collapse ladder, Transfer merge or gutter.
- REQUEST PR.4: optional whole-module built runtime move is staged in its scratch and held until the PR.6 completion release; current DS carrier remains authoritative at this measurement. The next paired move must retain public paths, one value table and declaration freshness. It is additional integration, not missing W2-DS behavior.

No commit/push, DB/channel operation or Wave4 feature rollout. No baseline increase. The original catalog README append preceded its separate exact-path claim; the ledger discloses that sequencing error. The simultaneous20:56 local browser-start race (18:56Z) and later app saves were also disclosed; disturbed readings were not used as final acceptance. The former review-pending.patch is retained as historical review material for the now-approved/applied alias decision. Earlier incomplete evidence is retained in README-before-approved-followup.md; prior gates/contrast logs remain historical, while resume-final-* is the final static series.

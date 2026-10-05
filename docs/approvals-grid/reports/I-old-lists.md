# I — the two older approval lists become one line (build agent I, 2026-10-05; nothing committed or staged)

Rule: "Other pages may show that approvals are waiting; none of them may decide one" (docs/2026-08-07-naf-aq-approvals-page.md).

## Files
- **New** (apps/web/src/app/fleet/_shared/): `ApprovalsWaiting.tsx` (DS Banner neutral + Button-as-Link; reads `GET /api/agent/fleet/approvals/queue/counts` every 30 s while visible via `useVisibilityPoll`; `ApprovalsWaitingView` renders one state), `ApprovalsWaiting.module.css` (layout + optional heading; pinned tokens only), `approvals-waiting-words.ts` (pure words), tests `approvals-waiting-words.vitest.test.ts` (5) and `ApprovalsWaiting.vitest.test.ts` (7: SSR of each state, DS-only source, CSS tokens in the fleet pin, and a guard that Settings › AI and FleetTab call no decide/approve/reject/undo/commit route).
- **Deleted:** `settings/ai/AiApprovalsClient.tsx`, `marketing/ads/rules-automation/fleet/ApprovalInbox.tsx`, `…/fleet/DecisionCard.tsx`, `fleet/approvals/reversibility.ts` + `reversibility.vitest.test.ts` (their only importers were the deleted inbox and card). OrderDetailClient only has its own `RoutingDecisionCard`.
- **FleetGateState.tsx** imported `toolCardFor` from DecisionCard for one word: the fleet's three `shortAsk` strings moved into it as `fleetToolAsk` (same words, same humanize fallback); HowItWorks test +2 asserts.
- **Settings › AI** `page.tsx`: `<ApprovalsWaiting id="agent-approvals" heading="Agent approvals" />` (the id keeps AiAgentsClient's `#agent-approvals` link working; heading measured to match siblings, 13/18 px, 600, uppercase). page.tsx loaded no data for the old list (it fetched itself), so nothing else removed.
- **FleetTab.tsx:** section 4 (card + `ApprovalInbox`) → `<ApprovalsWaiting />`. Removed: approvals/inboxView/inboxCounts/inboxLoading/precedents/busy state, the `approvals?view=` and `precedents` fetches, `post`, undo, commit, bulk-preview, bulk-decide, decide, reject-all, `disabled={busy}` on Refresh (busy was only set by decisions). Kept: plans (map edge counts), nameByKey, the 60 s refresh, everything else.
- **Words that pointed at the old inbox:** AiAgentsClient ("…queue proposals on the Approvals page"), fleet HowItWorks ("…lands on the Approvals page"), both fleet page subtitles ("…and how many approvals wait for you.").

## Words shown
"8 requests need you · 1 failed" · "1 request needs you" · "2 requests failed" · 0/0 → "Nothing needs you right now." · error → "Nexus could not read the approvals count." (also after an earlier good read) · loading → DS Skeleton line, `aria-busy` · always the button-link "Open Approvals" → /fleet/approvals.

## Checks
| Check | Command | Result |
|---|---|---|
| Web typecheck | `npx tsc --noEmit -p tsconfig.json --tsBuildInfoFile /private/tmp/claude-501/approvals-I-web.tsbuildinfo` | pass |
| Area tests | `npx vitest run src/app/fleet src/app/settings src/app/marketing/ads/rules-automation src/app/_shared src/lib` | 95 files, 1106 pass |
| Static gates | `node scripts/ci/run-static-gates.mjs` | 61/65; the 4 known; failure output identical to before |
| Ratchets | raw primitives 3508 (baseline 3917), no gate asked for a lower baseline | baselines untouched |
| Browser (light) | `followups-check.mjs` in the stack folder, 1280 + 390 | 30/30 PASS; text = /queue/counts (8 · 1); no decide control; no sideways scroll; "Open Approvals" lands on the grid; 0 console errors; 0 writes |
| Dark OS on /fleet | measured | line stays light (bg rgb(238,241,245), text rgb(28,37,48)) |

Screenshots: ~/nexus-archive/2026-10-05-approvals-grid-stack/shots-followups/ (`1280|390-fleet.png`, `-settings-ai.png`, `-line.png`, `1280-open-approvals-landed.png`); log `run-followups.log`. Requests noted: 2 ERR_ABORTED = the grid's own polls cancelled by the script's navigation.

## Left
- Dead CSS, not asked: fleet-sections.css l.209–~310 (`ap-*` block) and control-room.css `acr-fl-dcard*`, `acr-fl-inbox*`, `acr-fl-apactions`, `acr-fl-reasonfield`, `acr-fl-rejectrow` (l.887–902, 1075–1125). `acr-fl-dcard-plan` is still used (FleetTab's Activity link).
- raw-primitives-baseline.json still lists the 3 deleted .tsx (2 + 3 + 3); the script lowers only by a full `--baseline` rewrite, which would also absorb unrelated drift.
- At 390 px the banner text wraps to 2–3 lines beside the button (DS Banner layout, not restyled locally).

# SG video study — the Suggestions walkthrough, frame by frame

**Source:** youtube.com/watch?v=vQYVsdfU2AI ("Ads Rules, Bidding, and Automation on Amazon |
Helium 10 | Scale Stories Ep 2 (Part 5)", 29:03). The Suggestions segment runs **19:00 → 28:20**.
Method: auto-captions parsed to a timestamped transcript + 613 frames at 1 fps (18:50 → end),
studied by three parallel readers; pivotal frames re-read by hand. Assets (transcript, frames,
video) in the session scratchpad `yt/`; re-extract with `ffmpeg -ss 1130 -i sug-video.mp4 -vf fps=1`.

## What the reference actually is (evidence, frame numbers)

**Tabs** (f_1231): `Recommendations [New] · ⨯A.I. Bids (5) · Bids (99) · New Keywords (5) ·
Negative Keywords (1) · Budget (0)` — bold labels, count pills (grey, red text when non-zero),
blue underline active, page header carries a Beta pill + Learn/Share Feedback. No Placement tab
in this build; counts decrement live on apply.

**THE STAGING BUFFER — the core mechanic** (f_1364→1412→1424→1496):
- **✓ stages an accept.** It does not write. The row's **Current Bid becomes an editable $
  input**, pre-filled with the suggested value, highlighted, with a per-row **↺ revert**; the
  master button counts up ("Apply 3 Changes"). The input stays hand-editable — the override
  before commit.
- **✕ stages a removal** and counts into the same batch. Its tooltip, verbatim (f_1224/f_1364):
  **"Remove suggestion until a new one is generated."** The narrator calls this "snooze" — it is
  temporary BY DEFINITION because regeneration brings it back. There is no permanent dismiss and
  no duration menu.
- **[Apply N Changes]** commits accepts + removals together; **[Discard Changes]** clears the
  buffer. Both are permanent toolbar residents, disabled at 0.
- **No checkbox column** — the verbs are the selection.
- Post-apply (f_1237-1238): rows leave, tab counts drop, green toast: **"Changes may take a few
  minutes to complete. View all of the changes in the Change Log."** Empty state: illustration +
  "Create a Negative Keyword Rule to generate suggestions for a campaign!" + [Create Rule].

**Bids tab columns** (f_1361, f_1436, f_1460): sparkline + **circular match badge (E/B/A)** +
keyword link · Ad Group (hover ↗ Open) · Spend · Sales · **ACoS + traffic-light dot** · Rule
(name + hover ✎ edit) · **Current Bid (the buffer input)** · CPC · **Suggested Change =
`$0.52 $0.07 ↓` (new value + delta, red ↓ / green ↑; pause rows read "Enabled -> Paused" with
the input greyed)** · **Reason = the fired criteria verbatim** ("ACOS > 60%,…", "Clicks > 25,…")
· pinned ✓ ✕ ⏸. ASIN product-target rows get a target icon + external link.

**Negative/New Keywords tabs** (f_1178, f_1231, f_1292): Search Term (+copy/chart gutter icons)
· Spend · Rule · Date Added · Reason ("User customized threshold on a negative rule" / the
criteria string) · **Search Volume (with trend link)** · Impressions · CTR · CPC · CVR · PPC
Orders · Clicks · **Suggestion Created** · Sales · ACoS · verbs. New Keywords adds **Lookback
Period** ("Last 60 Days / Exclude Last 3 Days").

**THE DESTINATION POPOVER** (f_1290/f_1292): hovering a new-keyword row opens: *"Rule: Add New
Keywords and Adjust Bids. This search term, along with all bid adjustments, will be added to the
following entities when changes are applied."* + a table `Type (B/E badges) · Bid · To Campaign
(SP/SB badges) · To Ad Group · Notes ("Applicable")` — **one suggestion fans out to MULTIPLE
destination campaigns/ad groups, each with its own bid** — and an **[Edit Suggestion]** button.

**Per-tab settings gears**: "⚙ Negative Keywords Settings" (f_1231), "⚙ New Keywords Settings",
and A.I. Bids' "⚙ Bid Settings" (earlier segment) — SG.5 generalises to per-family settings.

**Filters per tab**: keyword tabs = Search Terms text · Rule · Targets · **Status (default
Active)** · ACoS/Spend/Sales ranges; Bids adds Portfolio · Campaign · Keyword text · Campaign
type · **Change Type**. 26:00→end is talking-head only (KT synergy is narrated, never shown).

## Adopted into SG.2b (built + locally verified 2026-08-21)
Staging buffer exactly as above (✓ fills the editable buffer input + ↺, ✕ stages removal,
one-batch Apply/Discard, no pending checkboxes, keyboard a/e) · bulk endpoint gained the `ops`
grammar with per-op `resultBidCents`/`resultBudgetEur` overrides (translated server-side to the
family's setValue op; gate still binds; `appliedResult.override` records it for graduation) ·
✕ copy = H10's sentence · Suggested Change = value + colored delta arrow, pause rows "Enabled →
Paused" · ACoS traffic dot vs the campaign target (green ≤ t, amber ≤ 2t, red beyond; no target
→ no dot) · Reason column = `conditionsTextOf(rule.conditions)` server-side (operator units) ·
match-type badge in the Source cell · Destinations cell + hover for promote rows (server
resolves the action's external ad group) · apply toasts say "may take a few minutes — view in
the Change Log" with the link · empty states end in a [Create Rule] button (`h10-am-btn`).

## Deliberate deviations (ours is better, kept)
Per-row outcome reporting + refusal honesty (H10 reloads silently) · the ⏸ pause verb is
two-step-armed (a real Amazon write deserves a confirm; H10 never clicked theirs on camera) ·
status tabs (Applied/Dismissed/Expired) — H10 has no history view at all · URL-linkable
everything · the truncation notice · Undo on removals.

## Backlog opened by the reference (not built today)
1. **Multi-destination harvest suggestions** — the engine emits one-destination promotes;
   H10 fans one term into N campaigns with per-destination bids. Engine work (HV destination
   mapping), then the Destinations cell + popover already render it.
2. **Search Volume column (+trend)** on keyword tabs — needs a volume join (KT/SQP feed).
3. **Edit Suggestion for destinations** (add/remove destinations pre-apply).
4. **Change Type / Campaign type filter facets**; free-text term filter beyond grid search.
5. **Rank evidence on bid rows** for tracked keywords (KT feed; the narrated KT↔Ads loop).
6. Rule hover-✎ (edit the rule from the row) — ours links via `?rule=` deep link today.

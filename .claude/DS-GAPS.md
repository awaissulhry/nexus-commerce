# DS gaps found during alignment (append one line per gap, never rewrite)
- `.pf-search` (Input + inline clear ×) → `Input` has no trailing action slot; `suffix` renders a shaded adornment, not a button — apps/web/src/app/marketing/ads/portfolios/portfolios.css:71
- `.fc-lead-select` / `.fc-budget input` → no compact "ghost" (transparent-until-hover, ~11.5px, 3px padding) Select/Input variant for inline table-cell editing; the DS `md` control is ~12px taller than a grid row — apps/web/src/app/marketing/ads/portfolios/[id]/family-cockpit.css:127
- `.fc-switch` / `.fc-status` → no badge-sized (11px / 3px 8px) toggle-button variant; `Button size="sm"` is 12.5px / 6px 11px and doubles a dense row's height — apps/web/src/app/marketing/ads/portfolios/[id]/family-cockpit.css:65
- `.h10-cl-sum .chip` (name + count + failure badge, pill-radius, toggles a filter) → no interactive filter-chip; `Pill`/`Tag` are non-interactive and `Button active` is a rectangular radius-lg fill, not a `radius-full` tinted chip — apps/web/src/app/marketing/ads/changelog/ChangeLogClient.tsx:367
- `.az-editbtn` → no quiet/borderless TEXT button (transparent border, reveals border+bg on hover). `Button variant="link"` is blue text, which is wrong for an inline value-edit trigger — apps/web/src/app/marketing/ads-console/targeting/TargetingClient.tsx:204
- `.az-link` used INLINE inside a sentence → `Button variant="link"` carries `padding: 6px 8px`, which in running text opens a visible gap either side of the word and grows the line box; there is no zero-padding inline-link variant. Measured on /marketing/ads-console/automation — apps/web/src/app/marketing/ads-console/automation/AutomationHome.tsx:43
- `.acr-refresh` / `.acr-btn.ghost` → `Button` cannot render as an `<a>`/`<Link>` (no `as`/`asChild`). Both classes sit on a Link AND a button side by side in the same row, so converting only the button splits one control into two looks — apps/web/src/app/marketing/ads/rules-automation/control-room/TodayTab.tsx:126 and ActivityTab.tsx:285
- `.acr-btn.go` → no `success`/positive Button variant. Green #15804f (4.96:1 on white, deliberately measured up from #1a9d6a's 3.46:1); `primary` is blue and `danger` is red — apps/web/src/app/marketing/ads/rules-automation/control-room/control-room.css:74
- `.acr-btn.stop` → no outline-danger Button (white fill, red text #b3352f 6.06:1, red border). DS `danger` is an opaque red FILL, which is a different statement for a "Stop everything" that must not read as already-fired — apps/web/src/app/marketing/ads/rules-automation/control-room/control-room.css:62
- `.acr-gg-reset` → no tonal/soft Button (tinted fill + tinted border + dark tinted text). #2a5399 on `--nds-blue-50` is 6.62:1; the nearest DS variant, `ghost`, is #1f6fde on white at 4.79:1, so substituting LOWERS contrast — apps/web/src/app/marketing/ads/rules-automation/control-room/control-room.css:585
- `.acr-undo-btn` → `Button` has no size below `sm`. This one is 11.5px / 3px 9px inside a table row; `sm` is 12.5px / 6px 11px, which changes the row height — apps/web/src/app/marketing/ads/rules-automation/control-room/control-room.css:765
- `.acr-gg-num` → `Input` (`.nds-field`) has no `sm` size. Dense grid-cell number boxes are 12.5px / 5px 7px / 72px wide; the primitive is 13px / 7px 11px, which is +7px of row height per grid — apps/web/src/app/marketing/ads/rules-automation/control-room/control-room.css:614
- `.ap-ack` → `Checkbox` has no `tone`. This box sits inside an amber acknowledgement card and its accent is deliberately amber (#8a6320), not the blue `--nds-primary` — apps/web/src/app/marketing/ads/rules-automation/fleet/fleet-sections.css:317
- `.lnk` (22 scoped rules, 35 call sites) → no INLINE text-link primitive. These sit inside prose: `font: inherit`, `padding: 0`, underline always. `Button variant="link"` is 13px/600 with `padding: 6px 8px` and underlines only on hover, so it breaks the sentence it lives in and drops the affordance — apps/web/src/app/marketing/ads/rules-automation/rules-automation.css:1403
- `.nds-btn.link` colour → `--nds-primary` #1f6fde is 4.42:1 on the ads console's ground (`.h10-shell` #f4f6f9), i.e. below AA anywhere outside a white card. `.h10-ar-lnk` already carries #1a60c4 (5.52:1) for exactly this reason, so converting those 8 call sites would LOWER contrast — apps/web/src/design-system/styles/primitives.css:435
- `.cvf-more` (full-width card-footer row: "+ N more campaigns claim this term…") → no full-bleed list-row/footer button; `Button variant="link"` is an inline chip, so the whole-row hit target and the top hairline would be lost — apps/web/src/app/marketing/ads/analytics/coverage.css:194
- `ToolbarButton` cannot express a DISCLOSURE — it hard-codes `aria-pressed` and takes no `aria-expanded`/rest props, so every icon-only expander converted to it downgrades its a11y role (worked around here with `active` + a label that states the next action) — apps/web/src/design-system/primitives/ToolbarButton.tsx:70
- `.hl-tile` (a whole KPI card that is a `<button>` scrolling to its section) → `Card` is not interactive and `Button` is not a card; there is no clickable-card/tile — apps/web/src/app/marketing/ads/health/health.css:31
- `.hl-pb-t` (full-width section header that is the disclosure: icon + title + chip + chevron, `border:0;background:none;width:100%`) → same missing full-bleed row button as `.cvf-more`, in header position — apps/web/src/app/marketing/ads/health/health.css:84
- `.hl-fchip` → third sighting of the missing interactive filter-chip (after `.h10-cl-sum .chip`); this one also needs a `:disabled` state and a trailing count — apps/web/src/app/marketing/ads/health/health.css:48
- `.esm-chip` (saved-preset token: click the name to apply, click the × to delete) → `Tag` is a static span and `TagInput`'s removable chip is welded to its own text field; no standalone removable/actionable token — apps/web/src/app/marketing/ads/bulk/bulk.css:375
- `Checkbox` has no `tone` — a tick that performs a destructive action (here "Push to Amazon now") cannot carry the danger accent, so the safety signal has to be re-declared at the call site — apps/web/src/design-system/primitives/Checkbox.tsx:11
- `.h10-spw-field` / `.h10-aig-field` / `.h10-cd-field` / `.h10-bulk-field` / `.h10-ai-field` / `.pf-fld` → no DS **Field** wrapper (label + required marker + InfoTip + hint + control). Six spellings; each one styles its own bare `input`, which is what blocks `<Input>` adoption at ~30 call sites — apps/web/src/app/marketing/ads/ads.css:1500
- `MenuItemDef` → no separator / section-heading item; the SP wizard's Select menu had a rule between "by campaign kind" and "by match type" — apps/web/src/app/marketing/ads/campaign-builder/sp-super-wizard/CampaignSetup.tsx:333
- `Button` → no `lg` size; wizard footer CTAs (`.h10-spw-next` 14px/9px 28px, `.h10-spw-back`) step down to `md` 13px/7px 13px — apps/web/src/app/marketing/ads/ads.css:1513
- `.bm-nextedit` → fourth sighting of the missing compact `Input` (after `.acr-gg-num`, `.fc-budget input`): an inline editor inside a data-grid cell, 22.5px tall against the primitive's measured 31px, so clicking to edit would jog the row — apps/web/src/app/marketing/ads/budget-manager/budget-manager.css:73
- `.bm-cal-day input` (28–31 of them, 11.5px / 5px 2px, centred, in a `repeat(7, 1fr)` month calendar) → same missing compact `Input`, but this one also needs a centred/numeric-cell variant; at the primitive's 13px / 7px 11px a week row no longer fits — apps/web/src/app/marketing/ads/budget-manager/budget-manager.css:101
- `.h10-spw-cs-token` (a bordered chip that is a select PLUS a remove ×) → `Listbox` brings its own border, so it double-borders inside the chip; no "removable token that is also a select" — apps/web/src/app/marketing/ads/ads.css:1545
- `.h10-spw-cs-ktrow .chipname` (a dark filled chip that is also a text input — rename-in-place) → no filled/inverse `Input` variant — apps/web/src/app/marketing/ads/ads.css:1564
- `.h10-ai-mod` (a bordered card that is a CHECKBOX — multi-select twin of `RadioCard`) → `RadioCard` has no `CheckboxCard` sibling, so the whole-card click target has to stay hand-rolled — apps/web/src/app/marketing/ads/campaign-builder/sp-super-wizard/ai-control.css:20
- `.h10-spw-st-toggle button.ai` (gradient "AI Control" mode button) → no AI/accent-gradient `Button` variant — apps/web/src/app/marketing/ads/ads.css:1979
- ✅ RESOLVED (DS session) — `xs` dense tier now on Button, Input, Select, Toggle. 11.5px / 4px 9px, measured 22.6-23.5px tall vs `sm`'s 26.5-27.8px. Input and Select also gained `sm`, which they never had. Covers `.acr-undo-btn`, `.acr-gg-num`, `.fc-lead-select`, `.fc-budget input`, `.fc-switch`, `.fc-status`.
- ✅ RESOLVED (DS session) — `Button variant="quiet"` (`.az-editbtn`) and `Button inline` (`.az-link`, `.lnk`). `ToolbarButton variant="boxed"` (`.az-iconbtn`, `.h10-sug-iconbtn`, `.rec-iconbtn`) and `tooltip={false}`.
- `Modal` z-index → `.nds-backdrop` is z-index 60; this section's own overlays are `.h10-hist-back` 200, `.h10-au-back` 160/161 and H10Select's portalled popover 200. A confirm opened from inside one of those renders BEHIND it, so those call sites cannot convert — apps/web/src/design-system/styles/components.css:311 vs apps/web/src/app/marketing/ads/rules-automation/rules-automation.css:221
- CORRECTION to the `.lnk` gap above — the DS's new `inline` modifier (fb06a565f) lands the geometry (`font: inherit`, `padding: 0`, no radius), so only two things still block those 35 call sites: (1) `link` underlines on HOVER ONLY, and an inline prose link distinguished by colour alone is a 1.4.1 problem, and (2) every `.lnk` scope uses a darker blue than `--nds-primary` — #1d4ed8 is 6.70:1 on white where #1f6fde is 4.79:1, so substituting lowers contrast — apps/web/src/design-system/styles/primitives.css:106
- `Listbox` has no option GROUPS. The rule builder's action picker is a native `<select>` with 6 `<optgroup>`s over 26 actions ("Bids", "Budget", "Pause/resume"…); flattening them into one 26-row list loses the only structure that makes it navigable, so this one select is left native — apps/web/src/app/marketing/ads-console/automation/BuilderTab.tsx:262
- `Input` / `Select` / `Textarea` are plain function components, so on React 18 a `ref` passed to them is dropped — any field that must be focused or selected imperatively (here the show-once share token, `tokenRef.current?.select()`) cannot use the DS primitive at all — apps/web/src/design-system/primitives/Input.tsx:16
- `.rpt-kpi` → fourth clickable-card sighting (a KPI tile that toggles its series on the chart, `aria-pressed`) — apps/web/src/app/marketing/ads/reporting/reporting.css
- ✅ RESOLVED (DS session) — `.nds-btn.link` colour. `--nds-text-link` raised from `--nds-blue-600` (4.42:1 on `.h10-shell`, i.e. FAILING AA off-card) to #1a60c4 (5.52:1 worst ground). `.nds-btn.link` now uses the link role instead of `--nds-primary`. Fixes every DS link at once — nothing to do at call sites.
- ✅ RESOLVED (DS session) — `ToolbarButton` disclosure. It now takes rest props, so pass `aria-expanded` and `aria-pressed` is suppressed automatically; an open disclosure gets the engaged visual too. Converting an expander no longer downgrades it.
- `Listbox`/`Combobox`/`MultiSelect` inside `Modal` → `.nds-combo-pop` is `position: absolute` and is CLIPPED by `.nds-modal`'s `overflow: hidden` and `.nds-modal-b`'s `overflow-y: auto`. Measured on the real cascade 2026-08-25: the popover's bottom overflowed the modal body by 75px. The legacy `.h10-ntm` was `overflow: visible` for exactly this reason — apps/web/src/design-system/styles/components.css:705 vs :317
- `.bp-btn.warn` ("Dry-run preview", sitting beside a `primary` "Run rebalance") → no caution/warn Button variant. #8a5a00 on #fff9ef measures 5.66:1, so `secondary` at 9.87:1 would RAISE contrast but delete the only signal separating the safe rehearsal from the live write — apps/web/src/app/marketing/ads/budget-manager/budget-manager.css:161
- `.bp-toggle` (a TRI-state toggle button carrying text: green `on` / amber `dry` / red `live — writes to Amazon`) → `Toggle` carries no label and `Button active` has one engaged colour, so the three states collapse into one. The red is a safety signal on a control that starts live Amazon writes — apps/web/src/app/marketing/ads/budget-manager/budget-manager.css:200
- `.az-tr-mini` (TimeRankGrid quick-actions: Fill all, Pause overnight, Mon→weekdays…) → second sighting of "`Button` has no size below `sm`" (after `.acr-undo-btn`). These are 11px / 4px 9px; `sm` is 12.5px / 6px 11px, which wraps the 9-button toolbar onto a second row — apps/web/src/app/marketing/ads-console/automation/TimeRankGrid.tsx:197
- `Input` `::placeholder` is `--nds-text-disabled` (#aeb6c2) — **2.04:1 on white**, below the 3:1 floor for any meaningful non-text and far below 4.5:1. It is not a DS *component* gap but a token one, and it bites every field converted in this programme: an `<input>` with no declared placeholder colour inherits the UA's #757575 at **4.61:1**, so each conversion LOWERS it. Measured on the ads-console product search — apps/web/src/design-system/styles/primitives.css:288
- `Input` `.lead` icon is `--nds-text-3` (#8a93a1, 3.10:1). Amazon's own search glyph is `--ink2` #565959 at 7.07:1, so converting a console search field halves the icon's contrast — same shape as the placeholder above — apps/web/src/design-system/styles/primitives.css:321
- `.h10-rep-bulkbtn.danger` (red text + red border on white, 6.21:1) → `Button variant="danger"` is a FILLED red at 5.47:1, so the substitution lowers contrast; no subtle/outline danger variant exists — apps/web/src/app/marketing/ads/ads.css:2401
- `Checkbox` / `Input` do not forward a `ref`, so an indeterminate tri-state tick (and any focus/select call site) cannot use the DS — apps/web/src/app/marketing/ads/campaign-builder/replicate/SourcePicker.tsx:61
- `Listbox`/`Select` option labels are `string`, and neither trigger takes a leading node — a market picker that shows a flag + brand mark cannot move to the DS — apps/web/src/app/marketing/ads/campaign-builder/CampaignBuilder.tsx:71
- `Checkbox` label wrapper → the component spreads its rest props onto the `<input>`, so a `title` that belongs to the whole row (the explanation an operator hovers to read) shrinks from the label to a 15px box. Two call sites keep raw markup for this — apps/web/src/app/marketing/ads/rules-automation/_rank/RankPlanBody.tsx:221 and budget/BudGuardrails.tsx:146
- `Checkbox` multi-part label → `label` renders inside ONE `<span>`, so a row whose label is three named flex siblings (name · market · spend) collapses to a single column. Two call sites keep raw markup — apps/web/src/app/marketing/ads/rules-automation/dayparting/CoveragePanel.tsx:177 and keyword-tracker/WatchlistPanel.tsx:230
- 🔴 `ads.css`'s `.h10-cd-field input[type=text] / [type=number]` (specificity 0,2,1) OUTRANKS `.nds-field > input` (0,1,1), so a DS `Input` dropped into the console's own field wrapper renders a second bordered 38px box INSIDE the DS wrapper — measured on prod: outer field 187×40 around an inner 185×38 bordered input. Every `<input>` inside a `.h10-cd-field` is unconvertible until that rule is scoped — apps/web/src/app/marketing/ads/ads.css:705
- `Button` has no `lg` — the campaign-builder wizard nav is 41px tall by design (`.h10-spw-back` 14px/9px 22px, `.h10-spw-next` 14px/9px 28px) and `md` is 30px, so converting would shrink the primary CTA of a money-spending flow by a quarter — apps/web/src/app/marketing/ads/ads.css:1513
- `Menu`'s trigger is hard-coded to a full `nds-btn`, so a row-action menu whose trigger is an icon (`.ch`, `.eb-statusfix` callers) cannot use it; `triggerProps` only reaches the same button's attributes — apps/web/src/design-system/components/Menu.tsx:42
- `Stepper` is display-only (no `onSelect`), so a wizard whose visited steps are navigable — every builder in this console — cannot use it — apps/web/src/design-system/components/Stepper.tsx:23
- `DateField` renders in-flow (no portal), has no `width` and no dense/28px register, so it cannot replace `ebay/_lib/EbDateField` without reintroducing both the popover clipping and the uneven-field-height defect the eBay `.eb-dd` block exists to fix — apps/web/src/design-system/components/DateField.tsx:46
- `Pill` is a static span; a pill used as a mode toggle (PROPOSE ↔ AUTOPILOT) has to hand-roll `<button className="h10-pill">` with inline `border:none` — apps/web/src/app/marketing/ads/ebay/automation/tabs/RulesTab.tsx:78
- `.eb-cond-num` (58px / 86px inline number fields in the rule builder's condition rows, 31px tall beside 28px Listboxes) → another sighting of the missing dense `Input`; the DS field is 36px and would break a row register the page was explicitly tuned to — apps/web/src/app/marketing/ads/ebay/ebay.css
- `.rec-iconbtn.apply` (a 28px round icon button with a PRIMARY fill — it applies a recommendation) → `ToolbarButton` has no filled variant; the only way to get the fill is `active`, which emits `aria-pressed` and would announce a one-shot action as a toggle. Converting just the grey `.rec-iconbtn` beside it would leave one control pair in two shapes, so all three sites are left — apps/web/src/app/marketing/ads/recommendations/recommendations.css:75
- `.rec-undo` (an "Undo" inside a Toast) → `Button variant="link" inline` is `--nds-primary`, and the toast's ground is `--nds-text`: measured **3.22:1**, against 15.48:1 for the `color: inherit` the class uses today. `inline` closed the padding half of the `.lnk` gap but there is still no inline link that inherits its colour for an inverted surface — apps/web/src/app/marketing/ads/recommendations/recommendations.css:110
- `.h10-sug-iconbtn.{ok,no,pz}.on` → `ToolbarButton`'s only engaged look is `aria-pressed`, which is one colour. Measured: staged-to-apply is blue #1f6fde (4.79:1), staged-to-remove is #8a5316 (6.31:1) and staged-to-mute is #5b6573 (5.91:1) — three states an operator reads at a glance down a staged queue, collapsing to one. The plain sites in this file ARE converted; these are not — apps/web/src/app/marketing/ads/suggestions/suggestions.css:98
- ✅ RESOLVED (DS session) — `Modal` z-index. Eight layering tokens; overlay 1400 / modal 1410 / popover 1450 / toast 1600 / tooltip 1700, banded above the app's highest (1301). A DS Modal opened from a legacy overlay is now on top instead of behind it.
- ✅ RESOLVED (DS session) — `Listbox`/`Combobox`/`MultiSelect`/`Menu` clipping. All four now portal to `<body>` via the shared `usePopoverPosition`. Verified live: parent is body, `position: fixed`, 4px gap, left delta 0, re-anchors on scroll, Escape from inside the portal still closes, and clicking an option no longer closes the panel first (`useClickAway` takes a ref LIST now — a portaled panel is not a DOM descendant of its trigger).
- `.az-rte-row .fld input` (rank-target editor: 4 numeric columns in a `1fr repeat(4,66px) 28px` grid, 60px wide, 11.5px / 3px 4px) → second sighting of the missing compact `Input`. The DS field is 13px / 7px 11px, which is wider than the grid column AND ~9px taller per row across ~10 rows — apps/web/src/app/marketing/ads-console/rank/RankTargetEditor.tsx:267
- `.az-mfield input` / `.az-blend-delta input` (blend editor: 64–70px numeric fields packed 4-per-lane across 3 lanes) → same compact-`Input` gap; substituting wraps each lane onto two rows — apps/web/src/app/marketing/ads-console/rank/RankBlendEditor.tsx:87
- `.h10-aig-money.err` → `Input` has no invalid state: no `invalid` prop, no `aria-invalid` styling, and `.nds-field`'s only modifier is `disabled`. The per-product budget field turns its border red below Amazon's €1.00/day floor, which is the one thing stopping a launch, so that single site is left hand-rolled while the four beside it convert — apps/web/src/app/marketing/ads/ads.css:1338
- ✅ RESOLVED (DS session) — `Field` (label + required + info slot + control + hint). Replaces `.h10-spw-field`, `.h10-aig-field`, `.h10-cd-field`, `.h10-bulk-field`, `.h10-ai-field`, `.pf-fld`. Renders a real `<label htmlFor>` and clones a single element child with a generated id, so you do not have to invent one. Verified live: 9.87 / 7.36 / 5.01 — the required marker (was 4.38) and the hint (was 3.10) were FAILING AA before.
- ✅ RESOLVED (DS session) — clickable card/tile (4 sightings: `.hl-tile`, `.rpt-kpi`, +2). `Card` takes `onClick` and renders as a `<button>`, with `pressed` → `aria-pressed`. Verified live: inherits Inter, left-aligned, border turns `--nds-primary` when pressed. ⚠️ Do NOT combine with an interactive `headerAction` — a button inside a button is invalid HTML.
- ✅ RESOLVED (DS session) — full-bleed row button (`.cvf-more`, `.hl-pb-t`, +1). `<Button block>` fills its container and left-aligns; composes with any variant (`quiet block` gives the borderless section-header shape). It sets no border — a separator between rows belongs to the list, not each button.
- `.az-btn` / `.az-btn.dark` (ads-console Amazon chrome: #0f1111 text 18.94:1, white-on-#0f1111 18.94:1) → the DS equivalents are 9.87:1 and 4.79:1, so `Button` cannot replace them without a legibility regression. The DS has no near-black/neutral-fill tone — apps/web/src/app/marketing/ads-console/amazon.css:1164
- `.h10-edit-in` / `.h10-edit-money` (grid inline editors) have an eBay twin in `marketing/ads/ebay/**` that must stay pixel-identical to the Amazon one — converting one console's editors ahead of the other's breaks that pairing, so both need to move together — apps/web/src/app/marketing/ads/ads.css:443
- ✅ RESOLVED (DS session) — interactive filter-chip (3 sightings: `.h10-cl-sum .chip`, `.hl-fchip`, `.esm-chip`). `FilterChip` with `pressed`, `count`, `badge`, `disabled`. Verified live: resting 9.87, engaged 7.41, badge 9.23. NOTE `.hl-fchip.on` was blue-600 on blue-50 = **4.36:1, under AA** — converting fixes it. `.esm-chip` is a different concept (a removable token with its own ×) and is still open.
- `.h10-hv-step` → no number STEPPER. A `−` button, a field and a `+` button share one border; nesting an `Input` inside that box gives two borders, and the DS has no equivalent — apps/web/src/app/marketing/ads/rules-automation/keyword-harvest/HvThresholds.tsx:267
- ⚠️ CORRECTION: `FilterChip` does NOT cover `.esm-chip`, which its docblock claims. That chip is a two-action token — the label applies a saved preset, a second `<button>` deletes it — and `FilterChip`'s `badge` renders inside the button, so a nested button would be invalid HTML. The removable-token gap stands — apps/web/src/design-system/primitives/FilterChip.tsx:18
- `Card` declares a closed prop set (no `...HTMLAttributes`), so it takes no `title`. A KPI tile whose only affordance cue is a tooltip — "Add {metric} to the chart" — cannot become a `Card onClick` without losing it; `aria-label` reaches a screen reader but not a sighted operator. Blocks `.rpt-kpi` — apps/web/src/design-system/components/Card.tsx:3
- `--nds-danger-strong` (#c0392b) → white text on it is **5.44:1**. This console's own two dangerous actions were measured darker for exactly this reason: #b3261e (6.54:1) on the plan delete and #a3342b (6.81:1) on the undo-commit. Both pass AA, but a substitution may only RAISE contrast, so those two cannot convert until the token is darkened. (The same check made the modal conversions right — `.h10-ntm-f .apply.danger` was #e5484d at 3.91:1, BELOW AA.) — apps/web/src/design-system/styles/tokens.css `--nds-red-700`
- ✅ RESOLVED (DS session) — `Input`/`Select`/`Textarea` dropping refs. All six form controls (those three plus `Button`, `Checkbox`, `Radio`) now use `forwardRef`. NOTE this was systemic: **none of the DS's 30 components forwarded a ref**. The other 24 are unfixed — if you need a ref on `Modal`, `Drawer`, `Tabs` etc., file it. `primitives/ref-contract.tsx` fails tsc if one of the six is ever unwrapped.
- `ToolbarButton` → no dense size. The bare button is 28x28; five of them share a 90px action column here, which needs 26x24. A `className` override works (the docblock sanctions it for the 34px case) but every dense grid will invent its own — apps/web/src/app/marketing/ads/rules-automation/rules-automation.css `.h10-kebab`
- `ToolbarButton` → no danger tone. `.del`, `.mbrm` and `.strm` hover RED (#a3211a on a #fbdedb wash), which is the only cue that those buttons destroy something; the bare primitive hovers to neutral, so converting them would remove the warning — apps/web/src/app/marketing/ads/rules-automation/rules-automation.css:997
- `SegmentedControl` takes no `aria-label` (and spreads no rest props), so its `role="radiogroup"` cannot be named. `.bp-strat` is one of the very few `-seg` spellings that DOES carry `aria-label="Allocation strategy"` today, plus a per-option `title` blurb the primitive has no slot for — converting it would trade an accessible name and three descriptions for arrow-key roving, so both sites are left — apps/web/src/app/marketing/ads/budget-manager/budget-manager.css:180
- `SegmentedControl` requires a `value` that matches an option: `tabIndex={active ? 0 : -1}` means that with nothing selected EVERY segment is `-1` and the whole group leaves the tab order. `.cp-statusbtns` (Strategy) binds `staged?.biddingStrategy ?? settings?.biddingStrategy`, which is legitimately `undefined` for a campaign with none recorded, so those three buttons stay reachable as plain buttons — apps/web/src/app/marketing/ads/budget-manager/ControlPlane.tsx:161
- ✅ RESOLVED (DS session) — four `Button` variants, `lg`, and `asChild`. `success` 5.02 (`.acr-btn.go` 4.96) · `warning` 5.69 (`.bp-btn.warn` 5.66) · `tonal` 7.41 (`.acr-gg-reset` 6.62) · `danger-outline` 7.36 (`.acr-btn.stop` 6.06) — all measured, all RISING. `lg` is 14px / 9px 18px. `<Button asChild><Link href="…">…</Link></Button>` renders the child with the Button's classes, so a Link and a button in the same row can finally match.
- ✅ CLOSED — `.bp-btn.warn` now converts: the DS added `Button variant="warning"` (`9caf08146`), which uses the same #f0d9a8 border and reads 5.69:1 against the hand-rolled 5.66:1. Recorded here rather than deleted, per this file's append-only rule.
- `.bp-toggle` (still open, narrowed) — `success` / `warning` / `danger-outline` landed, but this control needs the SOFT form of all three at once: green #067d62 on #e6f4ef, amber, and red on #fdeaea. `success` and `danger` are solid fills, `danger-outline` is white, and `tonal` is a single fixed tone. Three states, one variant each, none of them soft-success or soft-danger — apps/web/src/app/marketing/ads/budget-manager/budget-manager.css:196
- ✅ CLOSED by `Input size="xs"` — but the two ads-console sites remain BLOCKED by amazon.css, not by the DS. `.az-rte-row .fld input`, `.az-mfield input[type=number]`, `.az-blend-base input[type=number]` and `.az-blend-delta input[type=number]` are all (0,2,1) against `.nds-field > input` at (0,1,1), so they win on SPECIFICITY — load order is irrelevant and the class-drop escape would also take the grid columns and the `.fld.az-rte-na` state with it. Left raw deliberately — apps/web/src/app/marketing/ads-console/rank/RankTargetEditor.tsx:267
- ⚠️ NOT a gap — a measurement the DS session should have: adopting `FilterChip` LOWERS contrast against the ads console's legacy inks, in both states. Engaged went #ffffff on `--navy` #232f3e (13.57:1) → #0a4ba8 on #eef5ff (7.41:1); resting went `--ink` #0f1111 (18.94:1) → `--nds-text-strong` #3a4452 (9.87:1). Both still clear AAA, and the same drop applies to every `Button`/`Input` adoption here because `--nds-text-strong` is lighter than `--ink`. Flagging because the alignment brief's Rule 3 says a substitution may only ever RAISE contrast, and across this console the DS palette cannot honour that — apps/web/src/design-system/styles/primitives.css
- `.acr-btn` (bare, 25 call sites) → `Button variant="quiet"` hard-sets `color: var(--nds-text-strong)`, and this class deliberately INHERITS its context's colour. Measured on /rules-automation/fleet: the same class renders #9c2f2a inside an error card, `--nds-text-strong` in a normal row and `--nds-text` in a card header. A `quiet` that inherits (or a `tone` prop) would let all 25 convert — apps/web/src/app/marketing/ads/rules-automation/control-room/control-room.css:56
- ✅ RESOLVED (DS session) — `Listbox` option groups. `ListboxOption.group` buckets options under a heading in first-seen order. The rule builder's 26-action / 6-optgroup picker can leave native now.
- ✅ RESOLVED (DS session) — `Checkbox` `tone`. `success` 5.93 / `warning` 6.31 / `danger` 7.36 white-on-accent. `.ap-ack`'s amber no longer has to be re-declared at the call site.
- ✅ RESOLVED (DS session) — `MenuItemDef.separator` renders a rule (`role="separator"`).
- ✅ RESOLVED (DS session) — `CheckboxCard`, the multi-select twin of `RadioCard` (`.h10-ai-mod`). Shares RadioCard's stylesheet exactly.
- ✅ RESOLVED (DS session) — `quiet` now INHERITS its context colour (`color: inherit`). `.acr-btn` declares no colour at all, which is why the same button is red in an error card and normal elsewhere; hard-setting `--nds-text-strong` made all 25 sites unconvertible. My mistake when I shipped `quiet`.
- ✅ RESOLVED (DS session) — `Card` now extends `HTMLAttributes<HTMLElement>`, so `title`, `aria-*`, `data-*`, `id` and `style` all pass through. HTMLElement not HTMLDivElement because the root is a `<div>` OR a `<button>` depending on `onClick`.
- ✅ RESOLVED (DS session) — `ToolbarButton` `size="sm"` (24x24) and `tone="danger"` (red hover, 9.23:1 vs the 5.94 it replaces).
- `Listbox` has no `size`. `Button`, `Input` and `Select` all gained `sm`/`xs` today; `Listbox` did not, so a dense grid-cell dropdown still cannot adopt it — its 13px trigger sits beside 11.5px fields. Blocks the last two native selects in the ads console (`.az-mfield select` at 11.5px / 3px 4px, `.az-blend-base select`). Note the cascade is NOT the blocker here: Listbox renders a `<button>`, so the `.az-mfield select` rules cannot reach it — size is the only thing missing — apps/web/src/app/marketing/ads-console/rank/RankBlendEditor.tsx:101
- ⚠️ CORRECTION to the "✅ RESOLVED — `Card` now extends `HTMLAttributes`" entry above: `title` is still NOT passable. `CardProps` is `Omit<HTMLAttributes<HTMLElement>, 'title' | 'onClick'>`, and nothing re-declares it, so `<Card title="…">` is TS2322 — verified with a throwaway probe against the current file. The comment on line 5 lists `title` among what passes through; the Omit on line 6 removes it. `.rpt-kpi` stays unconverted — apps/web/src/design-system/components/Card.tsx:6
- 📄 The eight gaps above filed by Session 5 (budget-manager / suggestions / ai-advertising / autopilot / recommendations / ads-console-products) now have a spec — measurement, call sites, proposed API, and why each is unfixable from a route — in `.claude/DS-SPEC-from-session-5.md`. Highest leverage by a distance: `--nds-text-disabled` is 2.04:1 and is every `Input`'s placeholder, across 59 live fields.
- `RadioCard` → no borderless variant. `.h10-rb-ctrl`, `.h10-sb-type` and `.h10-rtm-opt` are structurally identical to it (radio + title + description + an `on` state) but are ROWS, not cards; `RadioCard` adds a border, a radius, 12px padding and a selected wash, which would box nine options in the rule-type dialog. 🔴 Separately: all three pass an `on` class that NO rule styles, so the selected option in those pickers is carried by the radio dot alone — apps/web/src/app/marketing/ads/rules-automation/rules-automation.css:150, :462, :190
- `Card`'s `onClick` cannot adopt a legacy card: `.nds-card.btn` is (0,2,0) and sets `display:block; width:100%; text-align:left`, which BEATS the one-class layout every hand-rolled tile carries. `.h10-cd-algo` (flex column) flattens and `.az-kpi` (`flex:none; min-width:132px` in a scrolling strip) stretches. Keeping the legacy class does not protect them, unlike a one-class DS rule — apps/web/src/design-system/styles/components.css:19
- `ToolbarButton.onClick` is `() => void` and passes no event, so a button nested inside a `<label>` cannot `preventDefault()`. The template-library delete must, or deleting a template also selects its row — apps/web/src/app/marketing/ads/rules-automation/dayparting/TemplateLibrary.tsx:144
- ✅ RESOLVED (DS session) — removable token (`.esm-chip`, `.h10-spw-cs-token`). `TokenChip`: content does one thing, a trailing × removes it. Verified live: capsule, label 9.87, × **5.01 (was 2.56 — under even the 3:1 non-text floor)**, and a nested `Listbox`'s own border is neutralised (0px) while a standalone one keeps its 1px, so no double border.
- ✅ RESOLVED (DS session) — `Listbox` leading node. `ListboxOption.leading` renders in the option row and on the trigger. `label` stays a string because search ranks on it. `Select` does NOT get this — a native `<option>` cannot contain markup, so a flag picker must use `Listbox`.
- ✅ ACKNOWLEDGED — the `FilterChip` docblock correction was right; it no longer claims `.esm-chip`.
- `.h10-cd-tabs` (campaign + ad-group detail) is the one underline tab bar that cannot take DS `Tabs`: its idle label is `--nds-grey-700` at 9.87:1 and `.nds-tab`'s is `--nds-text-2` at 5.91:1. Every other bar in the console idles LIGHTER than the DS and gains; this one idles darker and would lose — apps/web/src/app/marketing/ads/ads.css:655
- ✅ PARTLY RESOLVED — `.fc-status` (badge-sized state toggle in a dense table row) is now `Button variant="quiet" size="xs"`: 11.5px / 4px 9px, and `quiet`'s `color: inherit` lets the row keep its three state colours. Its sibling `.fc-switch` still has no home — its engaged state is a green TINT (#e8f6ef bg, success-text ink) and `success` is a green FILL with white ink. A `tonal` in success/warning/danger would close it — apps/web/src/app/marketing/ads/portfolios/[id]/family-cockpit.css:62
- ✅ RESOLVED (DS session) — `Listbox` `size` (`sm` 12.5px / `xs` 11.5px), matching Button/Input/Select. The last two native selects can adopt it now.
- ✅ RESOLVED (DS session) — `ToolbarButton.onClick` takes the native handler, so the EVENT is passed and `preventDefault()` works inside a `<label>`.
- ✅ RESOLVED (DS session) — `RadioCard`/`CheckboxCard` `variant="row"`: no border, radius, padding or wash. Also gives those three pickers a real selected state — they pass an `on` class that no rule styles, so today the selection is carried by the radio dot alone.
- ✅ RESOLVED (DS session) — `.nds-card.btn` specificity. Layout moved into `:where()` (0,0,0), so any one-class legacy rule wins; chrome stays at normal weight. 🔴 ONE APP-SIDE LINE NEEDED: `width: 100%` is load-bearing (a `<button>` at `display:block` with no width measures 120.5px in a 400px container, not 400), so a tile in a flex strip must set `width: auto` itself. Measured: `.az-kpi { flex:none; min-width:132px; width:auto }` → 132px; the same class without `width` → 400px. Before this change nothing could override it at all.
- `Tabs` takes no `aria-label` and spreads no rest props, the same shape as the `SegmentedControl` gap above. ALL 23 tablists in rules-automation carry a name today ("Grain", "Schedule detail", "Rule steps", "Approval views"…), so converting any of them would replace a named tablist with an anonymous one — apps/web/src/design-system/components/Tabs.tsx:31
- ✅ RESOLVED (DS session) — `SegmentedControl` keyboard trap + `aria-label`; `Tabs` `aria-label`. The trap was real: `tabIndex={active ? 0 : -1}` meant that when `value` matched no option, EVERY segment was -1 and the control could not be reached by Tab at all. Extracted as `rovingTabIndex` with tests, and the tests were proven to reproduce the bug (`[-1,-1,-1,-1]`).
- 📋 TRIAGE (DS session): of 75 filed, 66 are resolved. **9 genuinely open**, and 3 of those should stay LOCAL rather than become DS components — `.az-btn` (deliberately Amazon's chrome), `.h10-edit-in`'s eBay twin (the filer says it must stay), `.eb-cond-num` (58/86px one-offs). Remaining DS-worthy: `Stepper` `onSelect`, `Pill`-as-toggle, `--nds-danger-strong` contrast, `.h10-rep-bulkbtn.danger` (likely stale — `danger-outline` shipped).
- ✅ RESOLVED (DS session) — `.h10-spw-cs-token` (a bordered chip that is a select PLUS a remove ×) is `TokenChip` with a `Listbox` as its child; the token neutralises the nested Listbox's border, so it no longer double-borders. Verified live: one 1px border, inner trigger `0px none`.
- ✅ RESOLVED (DS session) — `ListboxOption.leading` renders a node before the label on the row AND the trigger, so the campaign-builder profile picker (Amazon mark + flag) is a DS `Listbox` at last.
- `.h10-ar-stale` / `.h10-bd-stale` / `.h10-bud-stale` / `.h10-plc-stale` (4 spellings of one "this view is stale — click to reload" chip) → `Button variant="warning"` is #8a5316 on #fdf3d3 = **5.69:1**; these are `--nds-stale-text` #6d3f10 on #fff6e8 = **8.27:1**. Four call sites of one concept that cannot converge until the warning pair is darkened — apps/web/src/app/marketing/ads/rules-automation/rules-automation.css:2502
- `.h10-kt6-cbtns .yes` → `warning` is a TINT (soft fill, amber text); this is an amber FILL (#b45309, white text) on the commit half of a confirm. A fill and a tint are different statements — a caution you must read vs an action you are about to take — apps/web/src/app/marketing/ads/rules-automation/rules-automation.css:4044
- `.h10-ngrec-tog.on` → `Button active` is the blue primary fill; this engaged state is GREEN (#146034 on #e7f4ec), which is what "this alert channel is on" means on that page. No tone on `active` — apps/web/src/app/marketing/ads/rules-automation/rules-automation.css:4293
- `.h10-bsp-disc` → `Button block` gives the full-bleed left-aligned row, but this one's DASHED border is the affordance ("there is more you can add here") and the DS has no dashed treatment; `quiet`'s inherited colour would also replace a deliberate grey-600 — apps/web/src/app/marketing/ads/rules-automation/rules-automation.css:2703
- `Listbox` size, second consumer with a MEASUREMENT: the eBay campaign builder pins one register per row via the `.eb-dd` block (written after the owner reported "fields and headings are uneven") — Listbox trigger 38px, `EbDateField` trigger 38px, raw input 38px, all at 14px. `Input` md is **36px/13px** and `sm` is 31px, so there is no DS size that sits level with a Listbox: converting the seven wizard steps would put 36px fields beside 38px dropdowns on `align-items: flex-end` rows and re-open the exact defect `.eb-dd` exists to close. Measured on prod with the narrowed `.h10-cd-field` selectors applied. The eBay register can only move to the DS scale once Listbox is on it too — apps/web/src/app/marketing/ads/ebay/ebay.css
- `DataGrid` has ONE density. Every other control gained `xs`/`sm`/`md` this week; the grid is fixed at 13px with `td` padding 11px 14px. Measured against the five tables in this session's scope: `.pf-table` 12px / 11px 14px (fits), `.h10-rep-tbl` 12.5px / 7px 10px, `.fc-table` 12.5px / 6px 11px, `.h10-vt-receipt-table` 11px / 6px 10px, `.bp-tbl` 11.5px / 5px 9px. Adopting the grid adds up to 12px per row, which on the Family Cockpit's six stacked tables is the difference between a page and a scroll — apps/web/src/design-system/styles/components.css:1098
- `DataGrid` gives a row no prop escape hatch. `rowClassName` exists but not `rowProps`, so a grid whose ROWS are drop targets cannot adopt it: the portfolios list spreads `ruleDropProps()` (onDragOver/onDragLeave/onDrop, all using `e.currentTarget`) onto each `<tr>` so a rule can be dragged onto a family — apps/web/src/design-system/components/DataGrid.tsx:387
- ✅ PRE-EMPTIVE (DS session, round 2) — `DataGrid` gained `renderExpanded` + `expanded`. Stress-tested `DataGrid` against all 67 remaining raw tables BEFORE the sessions hit them: `emptyState` (23 tables need it), `showTotals`, controlled sort, `rowClassName`, sticky columns and `maxHeight` were all already there. Row expansion was the ONLY missing feature (3 real tables — `BudgetPoolsDrawer` is divs, not a table). The grid owns the `colSpan` because only it knows the visible column count; the caller owns the caret.
- `DataGrid` header text is `--nds-text-2` (#5b6573) on `--nds-surface-raised` — **5.60:1**. Above AA, but the ads console's `.az-table thead th` is Amazon's `--ink` #0f1111 at **18.94:1**, so every one of the 19 tables converted in that scope drops its column headers by a factor of three. The brief sanctions ONE token pair for this console (`--ink` → `--nds-text-strong`, 18.94 → 9.87); this is a different pair and a much larger fall. Worth asking whether a grid HEADER — the thing you scan to find a column — should sit two tiers below its own body text (`--nds-text`, 15.48:1) — apps/web/src/design-system/styles/components.css (`.nds-grid thead th`)
- `DataGrid` `Column` has `align` but no NUMERIC tier — nothing sets `font-variant-numeric: tabular-nums`, and there is no DS utility class for it either (0 hits across primitives/components/patterns outside four component-internal uses). Every hand-rolled table in this console sets it on its figure columns; converting one silently drops it, so a right-aligned money column now renders with proportional digits — apps/web/src/design-system/components/DataGrid.tsx:10
- Second and third sighting of the missing TINTED status button (after `.fc-switch`): `.bp-toggle` has three tinted states — green `#e6f4ef/#067d62`, amber, red — and `.bm-pill` two (green Active / amber Paused). `warning` is a tint and maps; `success` and `danger` are FILLS with white ink, so two of the three states have nowhere to go and converting one of them alone would split the control. A `tonal` in success/warning/danger closes all three — apps/web/src/app/marketing/ads/budget-manager/budget-manager.css:198
- `SegmentedOption` has no `title`, so a per-option explanation has to ride inside the `label` node and covers the text rather than the whole segment. The budget-pool strategy switcher gives each of its three options a distinct blurb — apps/web/src/design-system/primitives/SegmentedControl.tsx:24
- `DataGrid` sets `font-variant-numeric` on **no selector at all** (verified by walking every declaration in components.css, not by grep). A numeric column therefore renders in proportional figures and the digits jitter down the page — in a grid, the one place alignment is the whole point. `.az-table .num` had `tabular-nums` and 60 files render a DataGrid, so this is not one console's problem. Suggest `align: 'right'` implying it, or a `numeric?: boolean` on `Column` — apps/web/src/design-system/styles/components.css (`.nds-grid td`)
- `.adock-scope-x` → `ToolbarButton` has no size below `sm` (24x24). This is a dismiss inside a 10.5px scope chip whose whole height is ~19px (`.adock-scope`: font 10.5px, padding 2px 4px 2px 7px); a 24px minimum grows the chip by half. Its icon is #6b87c0 on blue-50 = 3.16:1, already over the 3:1 floor, so there is no a11y forcing function either — left as a raw button — apps/web/src/app/marketing/ads/_shared/AutomationDock.tsx:211
- ✅ RESOLVED (DS session) — the `DataGrid` cluster the table work surfaced. `size` (md 38px / sm 29.5 / xs 24.5 per row — xs reclaims 13.5px, more than the 12px the grid was adding); `Column.numeric` (right-align + `tabular-nums`, scoped to numeric columns only — verified a text column stays `normal`); `rowProps` (drag handlers on a `<tr>`, so the portfolios drop-target list can adopt); and grid headers raised from `--nds-text-2` **5.60:1 → 9.35:1**. `numeric` is deliberately NOT implied by `align: 'right'` — a right-aligned status is not a number.
- ✅ RESOLVED (DS session) — `SegmentedOption.title`, so a per-option explanation covers the whole segment instead of riding inside the label node.
- 🔴 `DataGrid.d.ts` is STALE — it omits SEVEN props the `.tsx` declares: `renderExpanded`, `expanded`, `customizable`, `storageKey`, `customizeOpen`, `onCustomizeOpenChange`, `customizeTitle`. Reading the declaration (which is what "read the component before using it" invites) led me to plan around two capabilities that already exist, and it narrows the WorkspaceGrid-vs-DataGrid rule in the brief: `DataGrid` does column customisation, so only the FILTER BAR forces the heavier shell. Regenerate, and consider whether the `.d.ts` files should be generated in CI rather than by hand — apps/web/src/design-system/components/DataGrid.d.ts
- `DataGrid` has no `loading` state. `emptyState` renders inside a single `<td colSpan>`, so a skeleton built from `<tr>`/`<td>` (which is what a table skeleton is) cannot be passed to it, and the alternative is replacing a perceived-performance affordance with the word "Loading…". A `loading?: boolean` rendering N shimmer ROWS would serve all 60 consumers — apps/web/src/design-system/components/DataGrid.tsx
- `Button variant="link"` in PROSE (26 sites in rules-automation's first half; ~35 console-wide) → it underlines on HOVER ONLY, and `--nds-text-link` #1a60c4 measures **1.01:1 against grey-600 body text**, **1.65:1 against grey-700** and **2.59:1 against grey-900** — all far under the 3:1 that WCAG 1.4.1 requires when a link's only other cue is a hover underline. Every `.lnk` scope that sits in running text underlines ALWAYS for exactly that reason, so converting removes the only non-colour cue. Needs either a persistent-underline form or a link colour ≥3:1 against body text — apps/web/src/design-system/styles/primitives.css:106
- `TokenChip`'s trailing action is hard-coded to `<X>`, so it only expresses REMOVE. `.rpt-chip` (Reporting's saved-report tokens) has a second action that is *History*, not delete — converting it would put a ✕ where a clock belongs and read as "delete this saved report". Needs the trailing icon + label to be the caller's, as `onSelect` already is — apps/web/src/app/marketing/ads/reporting/SavedReportBar.tsx:129
- `Column.numeric` → right-aligns the CELLS but not the HEADER: `<td>` gets `alignClass(c.numeric ? 'right' : c.align)`, `<th>` only `alignClass(c.align)`. A figures column declared `numeric` alone renders its heading left over right-aligned digits, so every call site has to pass `align: 'right'` as well — which makes `numeric`'s "right-aligned AND tabular-nums" docblock half true. — apps/web/src/design-system/components/DataGrid.tsx:382 vs :436
- `ToolbarButton` `tone` offers only `neutral | danger`, but a decision column needs three verbs to read differently — apply (green), snooze (red), stop-suggesting (amber). The nine converted buttons keep their tones through `className`, restated at three classes deep so they beat `.nds-tbtn.boxed`'s hover on specificity rather than on stylesheet order — apps/web/src/app/marketing/ads/suggestions/suggestions.css:88
- `.h10-sug-buf` (the staged-value money cell: `€`, an editable input, a revert button, on/edited/readonly states) → **corrected 2026-08-26**: an earlier version of this line said the blocker was a 0,1,1 tie between `.h10-sug-buf input` and `.nds-field > input`, fixable by direct-child scoping like `.h10-cd-field` got. That is wrong and would send someone down a dead end — the specificity IS winnable from `suggestions.css` (`.nds-field.h10-sug-buf > input`, 0,2,1). The real blocker is that the two anatomies are inverted. `.h10-sug-buf` is an `inline-flex` ROW where the **input** carries the border/background and the `€` is a sibling OUTSIDE it; DS `Input` puts the border on the **wrapper** and renders `prefix` as a shaded adornment INSIDE it. Converting moves the `€` inside a shaded box and moves the `on`/`edited` tints (blue-600/blue-50, #c68a2e/#fff6e8) from the input onto `.nds-field` — a visible change to a dense 74px grid cell, not a like-for-like swap. Wants either a `prefix` that renders unshaded and outside, or leaving it alone — apps/web/src/app/marketing/ads/suggestions/_shared/rowCells.tsx:213
- `Button variant="quiet"` has no MUTED tone. It inherits colour by design, but a deliberately de-emphasised text button often sits in a container that sets full-strength ink: `.h10-spw-ps-rh .rm` ("Remove All") is `--nds-grey-600` #5b6573 (5.91:1) inside a container computing grey-900 #1c2530, so `quiet` would render it near-black and promote a muted secondary action to full emphasis. Raising contrast is not the same as preserving hierarchy; there is no `tone="muted"` to ask for — apps/web/src/app/marketing/ads/_shared/KeywordTargetingPanel.tsx:117
- `.h10-editpen` → no DS icon button can be `opacity: 0` until its row is hovered. `ToolbarButton` is always visible, so converting would put a pencil on every grid row. The icon is #b6bdc8 on white = 1.89:1, so this is one of the sites the brief wants converted most and one of the few that cannot be — apps/web/src/app/marketing/ads/_shared/CampaignRowCells.tsx:290
- `.h10-ram-clear` → second sighting of "`Input` has no trailing ACTION slot" (after `.pf-search`). The clear-× lives in the DS `Input`'s `suffix`, which renders a shaded adornment, so the button inside it is styled by neither side — apps/web/src/app/marketing/ads/_shared/RuleAssignModal.tsx:187
- `Input` has no trailing ACTION slot. `suffix` is documented as a "shaded suffix adornment (e.g. `%`)" and paints `background: --nds-surface-sunken` + a left border, so a clear-× search field must cancel three of its declarations from the page's own stylesheet. Three call sites want one: `.pf-search`, `.h10-ram-clear` (RuleAssignModal:187), `.apm-searchfield`. — apps/web/src/design-system/primitives/Input.tsx:11, styles/primitives.css:331
- `Card` as a button cannot be DISABLED. `CardProps` is `Omit<HTMLAttributes<HTMLElement>, …>`, and `disabled` is a button attribute, not an HTML one — so it is unreachable even though the stylesheet already ships `.nds-card.btn:disabled`. Blocks the Recommendations strategy rail, where a strategy with zero recommendations must not be selectable; a guarded `onClick` would still take focus and announce nothing — apps/web/src/app/marketing/ads/recommendations/RecommendationsClient.tsx:246
- `TokenChip` has no SELECTED state, and no size tier that lines up with `FilterChip`. The control plane's scenario bar is one row of chips where the active one must read as active and one of them (the working set) has no × — so the page supplies the engaged trio itself (and must repeat it on `> .t`, which declares its own colour). Measured in the real bar: `.nds-token` 32px vs `.nds-fchip` 24px, because `FilterChip` sets `line-height: 1.2` and `TokenChip` inherits — which is why the two cannot be mixed in one row. And a token WITHOUT `onRemove` is 26px, not 32: the × button sets the height, so one row of tokens is ragged unless the page floors it. — apps/web/src/design-system/primitives/TokenChip.tsx:37, styles/primitives.css:.nds-token
- `Menu`'s trigger is still hard-coded to a full `nds-btn`, and the component's own comment now acknowledges "a trigger that may be a 28px icon button" while still rendering one. Blocks the four eBay row-action menus (`.eb-statusfix` + a `.ch` icon trigger) — apps/web/src/design-system/components/Menu.tsx:51
- `.eb-tablebox` (the eBay wizard's table skin, ~20 rules) lives in `design-system/styles/workspace-grid.css` but is used by exactly three files, all of which have now moved to `DataGrid`. Those rules are dead and should be deleted by whoever owns that stylesheet — this scope may not — apps/web/src/design-system/styles/workspace-grid.css:18
- `Stepper` is DISPLAY-ONLY — an `<ol>` of `<li>`, no click. Three wizards let you click a completed step to go back (`.h10-spw-step`, ×3 builders), and one of them nests sub-steps inside the active step's label. As it stands the component cannot replace any of them. — apps/web/src/design-system/components/Stepper.tsx:23
- No component for a structure TREE / nav rail: a scrollable list of nested rows, each selected-or-not, with a count, a badge and a struck-through "dropped" state. `Button variant="quiet" block` is "a button shaped like a list row" but carries no nesting, no trailing count and no selected tint. The replicate plan rail (`.h10-rep-rail`, campaign/ad-group rows) is the case. — apps/web/src/app/marketing/ads/campaign-builder/replicate/ReviewStep.tsx:230
- `SegmentedOption` has no per-option `disabled` — only the whole group can be disabled. The wizard's Rule-Based / AI-Control switch is two mutually-exclusive segments where AI is unavailable until the account qualifies, so it cannot adopt the primitive without silently making a blocked choice look available. — apps/web/src/design-system/primitives/SegmentedControl.tsx:24, apps/web/src/app/marketing/ads/campaign-builder/sp-super-wizard/StructureSelection.tsx:98
- The note-warn token trio has `--nds-note-warn-bg` / `-fg` / `-icon` but no `-border`, so an amber-hairline control (white fill, amber outline — the "accept the warning" affordance, `.h10-rep-tbl .mini` #e0d4a8) has to either keep a raw literal or drop the cue. The error trio has the same shape. — apps/web/src/design-system/styles/tokens.css:116
- ⚠️ CORRECTION to my own commit 463b0444f: `Button size="lg"` does NOT match the wizard nav it replaced. Measured on prod: `.h10-spw-next` is **41px** (14px, line-height 21px, pad 9px 28px); `.nds-btn.lg` is **35px** (14px, line-height **1.1** = 15.4px, pad 9px 18px). The DS button sets a tight line-height that the legacy rule did not, so `lg` is 6px shorter. I compared declarations instead of rendered boxes and wrote "the same 41px" into the history. Keeping `lg` — it is the DS's large tier and still twice the step above `md`'s 30px — but the claim was false.
- 🔴 DS COMPOSITES HARD-CODE THEIR TRIGGER — three sightings, one root cause. `Menu` renders `<button className="nds-btn">` and `DateRangePicker` the same; neither takes a variant, a size or a className for the TRIGGER (`className` lands on the wrapper). This blocks wholesale adoption where the surrounding chrome is not DS-secondary: the ads header's Action menu is `primary`, and the date-range trigger computes grey-900 #1c2530 (15.3:1) where `.nds-btn` is grey-700 #3a4452 (9.87:1) — adopting it LOWERS contrast on a data-bearing label, which the brief's Rule 3 forbids outright. `triggerProps` on Menu takes button attributes but not `className`/`variant` — apps/web/src/design-system/components/DateRangePicker.tsx:154
- `MenuItemDef` has no `href` and no selected/checked state. The ads header's Action menu carries `<Link href>` items — converting would turn navigation into an onSelect handler and lose middle-click / cmd-click / open-in-new-tab — and four menus in the shared shell mark their current row with `.on`, which the component cannot express — apps/web/src/design-system/components/Menu.tsx:8
- `Menu` takes a flat `items` array, so a menu whose first selection SWAPS the panel for a searchable pick list cannot use it: the single builder's "Add Rule" popover is two-stage (two menu items → a headed, scrollable list of existing rules in the same box). — apps/web/src/design-system/components/Menu.tsx:23, apps/web/src/app/marketing/ads/campaign-builder/single/SingleCampaignBuilder.tsx:419
- `DataGrid` hard-codes `checked={false}` for any row `rowSelectable` rejects (DataGrid.tsx:429), so a row that is unselectable BECAUSE IT IS ALREADY DONE cannot show a ticked, disabled box — the console's negative-mining table did exactly that for terms already negated. Folding those keys into `selected` has no effect. Either honour `selected` for disabled rows, or take a `rowSelectedLocked` — apps/web/src/design-system/components/DataGrid.tsx:429
- ✅ RESOLVED (DS session) — the tone tokens were LIGHTER than what the console already ships, which is why four separate gaps said "converting would lower contrast". Darkened so every one of them can converge: `--nds-danger-strong` #c0392b → **#a3211a (5.44 → 7.53)**, clearing the console's own #b3261e (6.54) and #a3342b (6.81); the warning pair → **#6d3f10 on #fff6e8 (5.69 → 8.27)**, which IS the stale chips' pair, so all four `-stale` spellings converge with ZERO loss and `--nds-stale-text` is now an alias; `--nds-success-text` → **#146034 (5.40 → 6.95)** without moving the wash. Verified no `-soft` token is used as a text colour and no dark override was bypassed.
- ✅ RESOLVED (DS session) — `Button` `tone` on the ENGAGED state (`.h10-ngrec-tog.on`). `active` had one look, but an alert channel that is ON is GREEN here and blue says something else. Every pair RISES: success 6.74 → 6.95, warning 5.69 → 8.27, danger 6.21 → 6.27.
- ✅ RESOLVED (DS session) — `Stepper` `onSelect` (filed twice; three builders). Completed steps become real `<button>`s; the hit target is the badge AND label together, because clicking the number of a finished step is the gesture people reach for. UPCOMING steps stay inert by default — jumping ahead past validation is a different feature, opt into it with `canSelect`. Without `onSelect` the stepper is display-only exactly as before.
- `.h10-cb-card` (the campaign-type / mode choice tiles) is convertible to `Card onClick` + `pressed` — four of its five sites have no `disabled`, so the Card gap does not block them, and they carry NO role today. But it is one idiom across two scopes: three sites in `ads/ebay/campaigns/new/**` and one in `ads/campaign-builder/CampaignBuilder.tsx:84`, styled from `ads.css:1153`. Converting one half alone splits the idiom, forces `.h10-cb-card`'s box to be restated at 0,2,0 in a second stylesheet, and retires nothing. Wants doing in one change by whoever can touch ads.css — apps/web/src/app/marketing/ads/ads.css:1153
- `MultiSelect` cannot keep a COUNT when everything is selected, and shows "1 selected" where the surface wants the single option's own label. The Ad Manager's two filter multi-selects carry a deliberate note — "H10 always shows the count (e.g. `5 selected`), never `All`" — and name the campaign when exactly one is picked, so adopting the DS would change both labels. `placeholder` covers the empty case only. — apps/web/src/design-system/components/MultiSelect.tsx:40, apps/web/src/app/marketing/ads/campaigns/CampaignsGrid.tsx:592
- `DateField` formats dd/mm/yyyy (en-GB, hard-coded) and the ads console renders m/d/yyyy. Adopting it on the campaign's start/end dates would silently reinterpret every date on the page — 08/09 means two different days in the two formats — so the hand-rolled calendar stays until the component takes a format. — apps/web/src/design-system/components/DateField.tsx:25
- 🔴 `Stepper`'s new `onSelect` changes a step's AXIS. `.nds-step` is `flex-direction: column`, and a selectable step wraps its badge and label in `.nds-step-hit`, which is `flex-direction: row` — so inside ONE bar a completed (clickable) step reads badge-beside-label and an upcoming (inert) one reads badge-above-label. Measured on /marketing/ads/campaign-builder/quick with the four-step bar converted: step 0 badge y=105 label y=110 (row), step 1 badge y=105 label y=138 (stacked), and the bar grew 47px → 68px. The three builders the `onSelect` note names still cannot adopt it; the conversion is written and reverted, waiting on this. — apps/web/src/design-system/components/Stepper.tsx:50, styles/components.css `.nds-step`
- `StepperStep.label` is `string`, so a step cannot carry sub-steps. Two of the five builders nest a `.h10-scb-substeps` list inside the active step's label (Guided step 2, Single step 1) and would lose it. — apps/web/src/design-system/components/Stepper.tsx:20

## ✅ RESOLVED — `DataGrid`: `Column` carries no per-cell `className`, and `td` has no `vertical-align`
*Session 1 · ROUND 2 · 2026-08-26 · found converting ten `<table>`s in `rules-automation/`*

Two things surfaced together while converting this half's tables, both about the cell.

**1. `Column` has no `className`.** `Column<T>` is `{ key, label, render, align, sortable,
sortValue, sticky, stickyRight, width, total }`. A hand-rolled table routinely puts a class on the
`<td>` — `td.nw` for `white-space: nowrap; font-variant-numeric: tabular-nums`, `td.hr` for a
column's own colour — and there is nowhere for it to land. `align` and `width` cover two of the
common cases; the rest has to become `:nth-child(n)` in app CSS, which is the same fact written
less legibly. Two tables here needed it (`h10-n24-t`, `h10-bd8-tbl`, 7 cells between them).
Suggested: `className?: string` on `Column`, joined onto the `<td>` beside `alignClass`/`stickyCls`.

**2. `.nds-grid tbody td` sets no `vertical-align`, so it falls to `middle`.** The DS td block
sets background, border-bottom, padding, color, font-weight and white-space — a complete cell
treatment except this one property. It matters because a converted table often stacks a second
line inside a cell (a sub-label under a campaign name, an evidence line under a reason), and
`middle` floats the first line away from the row it belongs to. Measured on the ten tables
converted here: five had asked for `vertical-align: top` and five had not, so after conversion the
same console rendered both. Suggested: `vertical-align: top` on `.nds-grid tbody td` — the only
value that is stable when any one cell in a row wraps.

**Worth stating alongside these:** the conversion is *silently* a handover. `.h10-n24-t td` is
(0,1,1) and `.nds-grid tbody td` is (0,1,2), so the DS outranks the app wrapper on every property
it sets, even though app CSS loads later. Across these ten tables **96 declarations in twenty
`.X th` / `.X td` blocks** were still written and none of them reached the page — including eight
separate hand-rolled uppercase header treatments. That is the alignment working, but nothing in
the DataGrid docblock says it will happen, and a stylesheet left un-swept afterwards reads as
though those rules are still live.

**Resolved 2026-08-26 in `3e7126ba0`** (nexus-commerce-95). `Column.className` lands on the `<td>`,
and `.nds-grid tbody td` sets `vertical-align: top`. Both workarounds removed in `40d534809`.

Worth keeping the second half of the story: the `:nth-child()` stand-in was not merely uglier, it
was **wrong**. Those cells name a COLUMN and `nth-child` counts a POSITION, so on a grid with
column customisation — which both of these are — hiding or reordering one column would have
painted the rules onto the wrong cells. Silent, and only on a customised view. When a DS gap
forces a positional workaround onto something that is logically named, that is worth treating as
a defect from the start rather than a stopgap.
- ✅ RESOLVED (DS session) — 🔴 my own `Stepper` `onSelect` regression. `.nds-step-hit` was `display: inline-flex`, which defaults to `row`, while `.nds-step` is `column` — so a selectable step read badge-beside-label and an inert one badge-above-label, in the same bar, and the bar grew 47px → 68px. I wrote `gap: inherit` assuming it carried the layout; **`flex-direction` is not inherited and nothing carries it**. Now written out explicitly and verified: all three step states measure badge y=32, label y=68, gap 7, centre-aligned, bar 51.6px. The conversion that was written and reverted can go back in.
- ✅ RESOLVED (DS session) — `StepperStep.label` is `ReactNode`, so a step can nest a sub-step list.
- `Toggle` has no `label` prop, unlike `Checkbox` and `Radio` which both take one. Four switches in the shared shell (`.h10-cd-switch` x3, `.h10-spw-sw`) are checkboxes styled as switches — visually a track+knob, but they announce as "checkbox", which `Toggle`'s `role="switch"` would fix. They cannot adopt it: each is wrapped in a `<label>` that makes the caption a click target, and a `<label>` cannot label a `<button>`. Converting trades correct switch semantics for a lost click target; a `label` slot on Toggle would give both — apps/web/src/app/marketing/ads/_shared/PlacementBidMultiplier.tsx:55
- `.opsn-exp` → second sighting of "`ToolbarButton` has no size below `sm` (24x24)" (after `.adock-scope-x` at 12px). This one is 18x18 and expands/collapses a node inside a React Flow graph where nodes are fixed-size, so a 24px minimum pushes the node's top row. Two sightings at 12px and 18px suggest an `xs` tier, not one-off overrides — apps/web/src/app/marketing/ads/_canvas/ObjectNode.tsx:25
- ✅ RESOLVED (DS session) — `DateField` takes `format` (`dd/mm/yyyy` | `mm/dd/yyyy` | `yyyy-mm-dd`) and `locale`. `value`/`onChange` were ALREADY ISO, so the stored date never changed meaning — only the display was locale-fixed, in two places. Default stays `dd/mm/yyyy`/`en-GB`, so nothing existing shifts. Verified: ISO `2026-09-08` renders `08/09/2026` or `09/08/2026` on demand — the exact ambiguity that blocked the campaign start/end dates.
- 🔴 `DataGrid.d.ts` omits NINE props the `.tsx` declares (updated count): `customizable`, `customizeOpen`, `customizeTitle`, `expanded`, `onCustomizeOpenChange`, `renderExpanded`, `rowProps`, `size`, `storageKey`. `size` is the one that would have cost most — without it a compact console grid converts at `md` and loses a third of its visible rows. Anyone planning a conversion from the declaration is planning against a component that does not exist — apps/web/src/design-system/components/DataGrid.d.ts
- `Stepper` STACKS and the console's step bar is a ROW. Both earlier gaps are closed and verified (the axis fix holds — all three steps now read the same way, bar 68px → 49px — and `label` takes a `ReactNode`), so this is the only thing left between the component and its five call sites: `.nds-step` is `flex-direction: column; align-items: center; text-align: center`, while `.h10-spw-step` is `row` with `gap: 9px`, left-aligned. Measured 2026-08-26 on /marketing/ads/campaign-builder/quick — DS steps `[stacked, stacked, stacked]` at 49px, the live bar `[row, row]` at 47px. Adopting it as-is redesigns the header of all five builders rather than aligning them, so it needs a row variant (or a decision that the stacked look is the one). The conversion is written and reverted twice now; it goes in the day this is settled. — apps/web/src/design-system/styles/components.css `.nds-step`

## `Button variant="link"` underlines on hover only, and the link token is 1.03:1 against body text
*Session 1 · ROUND 2 · 2026-08-26 · found converting 19 link-style buttons in `rules-automation/`*

`.nds-btn.link` sets `color: var(--nds-text-link)` and puts `text-decoration: underline` under
`:hover`. In prose that is not enough to say "this is a link". Measured against the body colours
these actually sit in:

| link colour | adjacent text | ratio |
|---|---|---|
| `--nds-text-link` #1a60c4 | `--nds-grey-600` #5b6573 | **1.03:1** |
| `--nds-text-link` #1a60c4 | #46536a | **1.30:1** |
| `--nds-text-link` #1a60c4 | white ground | 5.98:1 (text contrast is fine) |

WCAG 1.4.1 asks for ≥3:1 between the link and the text around it when colour is the only cue.
1.03:1 is not a cue at all — at rest these read as ordinary prose, and the link only announces
itself once the pointer is already on it, which is no help to anyone reading or tabbing.

Every hand-rolled version in this console had already reached the same conclusion independently:
**eighteen separate `.lnk` / `.h10-ar-lnk` rules, and every one of them underlines permanently.**
That unanimity is the finding. Nineteen of those call sites are the DS `Button` now, with one
retained class supplying the single declaration the DS will not:
`.nds-btn.h10-lnk { font: inherit; font-weight: 700; text-decoration: underline; }`. Ten `.lnk`
rules outside this half are still waiting on the same thing.

Suggested, in order of preference: (1) `text-decoration: underline` on `.nds-btn.link` itself,
with the hover reserved for a colour or thickness change; or (2) an `underline` prop on `Button`;
or (3) if the hover-only rest state is deliberate for toolbar-ish uses, raise `--nds-text-link`
far enough that it clears 3:1 against `--nds-grey-600` — which from #5b6573 means something
around #0b3f8f or darker, and that is a large change to make for this reason alone.
- 🔴 CORRECTION (DS session) — `.eb-tablebox` rules are **NOT dead. Do not delete them.** The gap says "used by exactly three files, all of which have now moved to `DataGrid`". Checked both directions just now: `ReviewStep.tsx:233`, `KeywordsStep.tsx:98` and `RatesStep.tsx:94` still render `className="eb-tablebox"`, and 18 rules in `design-system/styles/workspace-grid.css` still style it. Deleting them strips the table skin from three eBay wizard steps. (Likely measured while a conversion was in flight that was then reverted — the same way the Stepper conversion was written and reverted.) The MISPLACEMENT is real and still worth fixing: an app-specific eBay class should not live in a DS stylesheet. That is a move, not a delete, and it carries source-order risk — see the next entry.
- 📋 DEFERRED (DS session) — moving `.eb-tablebox` out of `design-system/styles/workspace-grid.css`. The misplacement is real, but the rules are LIVE on three eBay wizard steps, and relocating 18 rules between stylesheets changes source order for no user-visible gain. When `ReviewStep`, `KeywordsStep` and `RatesStep` convert to `DataGrid` the rules become genuinely dead, and deleting dead rules is trivial and safe. **Whoever converts those three steps: delete the 18 `.eb-tablebox` rules in the same commit** — and check `.nds-card .eb-tablebox` in `ads.css`, which will also be orphaned.
- `Menu` has no Escape handling, though `Modal`, `Listbox` and `DateField` in the same library all close on Escape. Noting it because it changes the value of fixing Menu's trigger gap above: the shared shell has 11 hand-rolled popovers (AdsPageHeader, CampaignDetailHeader x2, MarketSelect, DateRangePicker, CampaignRowCells, RuleColumnCells, RuleColumnEditors x4) and NONE handles Escape — each is dismissible only by clicking the `.h10-menu-back` catcher (a `position:fixed; inset:0` invisible button) or by tabbing to it. Adopting `Menu` today would carry that weakness across rather than fix it — apps/web/src/design-system/components/Menu.tsx:45
- ✅ RESOLVED (DS session) — `Pill` takes `onClick` and becomes a `<button>`, with `pressed` → `aria-pressed`. The eBay rules list hand-rolled `<button className="h10-pill ok">` with an inline `border: none` to toggle PROPOSE ↔ AUTOPILOT. Same shape as `Card`'s `onClick`; a clickable pill is visually identical to a static one, only the cursor and hover differ.
- ✅ VERIFIED STALE (DS session) — `.h10-rep-bulkbtn.danger` needs 6.21:1 and `Button variant="danger-outline"` gives **7.36:1**; the four `.h10-*-stale` spellings need 8.27:1 and the darkened `variant="warning"` gives **exactly 8.27:1**. Both were filed before those shipped. Nothing to do.
- `DateField` takes no `id`, so its visible label cannot be associated with it. `Field` auto-associates by cloning its single child with a generated `id`, and `DateField` has no rest spread — the prop is dropped, so `<label for>` names an element that does not exist (verified in the DOM: `getElementById` returns null; the control's only name is `ariaLabel`). This also blocks the campaign's read-only Start Date, which has a working `<label for="cd-startdate">` today and would LOSE it by converting. Same shape as `Listbox`. — apps/web/src/design-system/components/DateField.tsx:67, components/Field.tsx:48
- `DataGrid` renders `<tr {...rowProps(row)} className={…}>` — the explicit `className` comes AFTER the spread, so a `className` passed through `rowProps` is silently discarded. Every other `rowProps` key applies, which makes it look like the prop works. `rowClassName` is the right slot and the docblock says so, but the discard is silent: I shipped a probe grid whose rows were clickable with no `cursor: pointer` and neither tsc nor the diff could see it. Either merge the two or drop `className` from `rowProps`'s accepted type — apps/web/src/design-system/components/DataGrid.tsx:425

## `SegmentedOption` has no per-option `disabled`
*Session 1 · ROUND 2 · 2026-08-26 · found converting `_rank/RankTargetEditor.tsx`*

`SegmentedOption` is `{ value, label, icon?, title? }`, and `disabled` exists only on the whole
control. The Rank target editor's switch needs one segment disabled and the other live: until the
product or campaign is saved there is nothing to override, so "This product" is unreachable while
"Global defaults" must stay usable. Disabling the control disables both.

Handled here without the prop, and arguably better for it: when the scope is unavailable the
option is not rendered and the reason moves into the hint line beside the control as visible text.
The hand-rolled version put that reason in a `title` on a disabled button, which is the pattern
this console has already written down as a defect — a disabled control cannot explain itself, and
a hover tooltip reaches neither a keyboard nor a touch user.

Suggested: `disabled?: boolean` plus `disabledReason?: string` on `SegmentedOption`, with the
reason rendered somewhere a keyboard user meets it rather than as a bare `title`. Worth pairing
with a note in the docblock that dropping the option and explaining in adjacent text is often the
better answer — that is what this call site did.
- `Column.render` in `DataGrid` receives only `(row)` — no index — so an ordinal "#" column cannot be written. Numbering rows is a normal thing to want from a grid, and the workaround (an index Map built per render) exists only to avoid a quadratic `indexOf` per cell. Suggest `render: (row, index) => ReactNode`, which is additive and breaks no existing consumer — apps/web/src/design-system/components/DataGrid.tsx
- ✅ SELF-AUDIT (DS session) — swept every DS rule that sets BOTH a token colour and a token background: 113 pairs, **16 were sub-AA**, now **0**. Not filed by anyone; found by auditing my own session's output after the Stepper regression showed I ship bugs too. Fixed at the TOKEN level where possible so every consumer moves at once: `--nds-pill-warning-fg` was `--nds-amber-text` (4.39 on its own pill) → `--nds-warning-text` (7.99); `--nds-pill-neutral-fg` 4.18 → `--nds-text-2` (5.22). Rule level: `--nds-primary` used as TEXT on its own washes (4.17–4.36, nine rules) → `--nds-text-link`; `--nds-text-3` as text (2.74–3.10, three rules) → `--nds-text-muted`/`-2`; `.nds-navbadge` white on `--nds-danger` 3.91 → on `--nds-danger-strong` 7.53. Exempt and left alone: `:disabled` text (WCAG-exempt) and `.nds-empty .ico` (an icon, 3:1).
- `.az-bias-edit` (a joined −/number/+ stepper: one shared border, hairline dividers between three controls) → the DS has no numeric stepper, and building one from `Button` + `Input` + `Button` gives three separate boxes rather than one control. Left raw in the placement cockpit — apps/web/src/app/marketing/ads-console/amazon.css:230

## No disclosure primitive, and `TabItem` has no `title`
*Session 1 · ROUND 2 · 2026-08-26 · found converting `rules-automation/fleet/`*

**1. Nothing in the DS opens what sits under it.** `primitives/` and `components/` hold no
Disclosure, Accordion, Collapsible or Details. The Agent Fleet alone hand-rolled the same control
**eight times** — `acr-fl-checkstoggle` (×4), `acr-fl-runhead`, `acr-fl-rawtoggle`, `dt-ephead`,
`acr-fln-expand` — all a text-and-chevron row that toggles a block beneath it, all resetting
`border`/`background`/`padding`/`cursor` by hand. `Button variant="quiet" inline` covers the
chrome, which is what they are now, but nothing in the DS owns the *pattern*: the chevron
direction, the `aria-expanded` wiring, or the id linking the trigger to the region. Measured while
converting: **five of the eight had no `aria-expanded` at all**, so a reader was never told whether
the section was open. A primitive would have made that impossible rather than a thing each call
site remembers.

**2. `.nds-btn.quiet` declares `color: inherit`,** deliberately and well documented — but it means
any call site that *does* want its own colour must write `.nds-btn.my-class` rather than
`.my-class`, because a bare class at (0,1,0) loses to (0,2,0). Worth one line in the docblock;
five call sites here would have silently taken their container's colour otherwise.

**3. `TabItem` has no `title`.** Converting `ApprovalInbox`'s view bar to `Tabs` would have dropped
the only explanation of what each view holds ("Requests that ran out of time before anyone answered
them"). Handled by moving the active view's hint under the bar as visible text — better than the
tooltip it replaced, since a `title` reaches neither keyboard nor touch. Same shape of answer as
the `SegmentedOption.disabled` gap above: the DS not having the prop pushed the call site toward
visible text, which was the right place for it. That is worth saying in the `Tabs` docblock rather
than adding the prop.

**4. `Tabs` renders `role="tab"` with no way to name a panel.** No `aria-controls`, no
`id`/`aria-labelledby` pairing with the region a tab switches. Every hand-rolled tablist in this
console has the same hole and the DS inherits it. Low priority — but if `Tabs` is the console's
answer for tab bars, the panel association belongs in it, not in each caller.
- 🔴 OPEN — **dark mode is substantially broken, and it is LIVE.** `use-theme.ts:36` does `root.classList.add('dark')` and the nav rail has a light/dark/system toggle, so this ships. Audited the same 113 DS pairs against the `.dark` block: **41 were sub-AA**, some at **1.08:1** — a hover state that erases its own label. Fixed 13 by aliasing to values the dark block already chose (`--nds-surface-hover` → `surface-raised` 11.81, `--nds-text-strong` → `text` 12.73, `--nds-text-muted` → `text-2` 7.38); **28 remain**. Those need COLOURS CHOSEN, not aliased — the dark block overrides 29 tokens out of ~240, and `--nds-primary` (10 rules), `--nds-primary-soft` (5), `--nds-wash-primary` (2) and every tone wash have no dark value at all. **This is a design decision, not a mechanical fix, so it is left for the user.**
- 🔴 OPEN — `design-system/styles/workspace-grid.css` is built on RAMP tokens (`--nds-white`, `--nds-grey-25/100/700/900`) rather than semantic ones, which is why it fails in dark mode. The token-guard's ramp rule covers components/primitives/patterns but **not this file**, which is how they survived. Converting it is a prerequisite for dark mode there; adding it to `RAMP_FILES` afterwards would keep it converted.
- `Listbox` / `DateField` placeholder (`.nds-listbox-btn .ph`) is `--nds-text-3` (#8a93a1) — **3.10:1 at 13px on white**, under AA. Distinct from the `Input ::placeholder` case filed above (that one is `--nds-text-disabled` at 2.04:1 and a pseudo-element; this is a real span in a different component pair). Measured 2026-08-26 on /marketing/ads/campaigns/<id> with the empty states of both: "Select a Portfolio" 3.10, "Enter a Date" 3.10. When a field is empty that string is the control's only visible text, so it is informative, not decorative. The whole rest of that form measures 4.79–15.5. — apps/web/src/design-system/styles/components.css `.nds-listbox-btn .ph`

## `Button variant="primary"` is 4.79:1 — the console's hand-rolled CTAs were higher
*Session 1 · ROUND 2 · 2026-08-26 · found converting `keyword-tracker/BidAction.tsx`*

`.nds-btn.primary` is `--nds-text-inverse` on `--nds-primary` → white on `--nds-blue-600`
**#1f6fde**, which measures **4.79:1**. It clears the 4.5:1 floor for normal-size text, so nothing
here fails — but it is the tightest margin in the system, and it is on the most-used control.

It came up because the Keyword Tracker's Propose button drew white on **#1a5fbe (6.13:1)** by
hand, and converting it to `primary` *lowers* the ratio. That is the only conversion in this
half's ~130 that goes down rather than up; every other substitution raised its number, several
of them off failing values (2.04:1, 3.49:1). Two more hand-rolled CTAs measured in the same pass:
white on #b45309 (5.02:1) and white on #1a5fbe again.

Worth knowing rather than acting on immediately: three independent authors picked a darker blue
than the token when they needed white text on it. If `--nds-blue-600` ever moves, it should move
down. Anything that raises it — a lighter hover, a lighter disabled fill, a `lg` size with the
same pair — starts from 4.79 and has no room.

Not fixed locally: overriding the brand blue at one call site is how a console ends up with four
different primary buttons, which is the thing this whole exercise is undoing.

## `Menu` cannot express a destructive item, or explain a disabled one
*Session 5 · ROUND 2 · 2026-08-26 · found auditing the last raw buttons in `ads/ebay`*

`MenuItemDef` is `{ id, label, icon, disabled, onSelect, separator }`. Two things the console's
hand-rolled menus say and this cannot:

**1. No destructive item.** Every hand-rolled row menu ends in `<button className="danger">Delete…</button>`.
There is no `tone` on `MenuItemDef` and **no `.nds-menu` danger rule in any stylesheet** — checked
both the type and `styles/*.css`. Converting drops the red entirely, so Delete reads exactly like
Edit. Passing `label={<span className="danger">…</span>}` does not work either: the existing rule
is `button.danger`, so the class would land on a child and match nothing.

**2. No per-item `title`.** `RulesTab`'s "Run now" is `disabled={busy || !rule.enabled}` and
carries `title="Enable the rule first — disabled rules don't evaluate"`. `Menu` has `triggerProps`
but no per-item props, so the item goes disabled and silent — the failure mode already filed as
"a disabled control cannot explain itself".

Blocks **14 raw buttons across 3 files** that are otherwise a clean `Menu`: `ebay/automation/tabs/RulesTab.tsx`,
`ebay/campaigns/EbayCampaignsGrid.tsx`, `ebay/automation/tabs/SuggestionsTab.tsx`. All three share
`.h10-statusmenu` with `_shared/CampaignRowCells.tsx`, so this wants doing in one pass, not three.

## The last raw controls in `ads/ebay` are shared anatomies with out-of-scope twins
*Session 5 · ROUND 2 · 2026-08-26 · not a gap in the DS — a note on where the seam falls*

After converting the one genuinely eBay-local control left (the PROPOSE↔AUTOPILOT pill, below),
`ads/ebay` still greps **44 `<button>`, 4 `<input>`, 1 `<textarea>`, 1 `<select>`**. Every one of
them is styled by a class whose *other* call sites are outside a single session's scope, so
converting eBay's copy forks the anatomy rather than aligning it:

| class | eBay files | twin(s) outside `ads/ebay` |
|---|---|---|
| `.h10-spw-ps` (16 controls) | `campaigns/new/_wizard/steps/ListingsStep.tsx` | `_shared/KeywordTargetingPanel.tsx`, `campaign-builder/sp-super-wizard/ProductSelection.tsx` |
| `.h10-statusmenu` (14) | RulesTab, EbayCampaignsGrid, SuggestionsTab | `_shared/CampaignRowCells.tsx` |
| `.h10-open` (6) | 6 files under `campaigns/` | `_shared/CampaignRowCells.tsx`, `campaigns/CampaignsGrid.tsx` |
| `.h10-cb-card` (3) | EbayCampaignChooser, TargetingStepGen, RatesStep | `campaign-builder/CampaignBuilder.tsx` |
| `.h10-edit-in` (3 inputs) | KeywordsTab, AdsTab, AgKeywordsTab | `campaigns/[id]/tabs/AdGroupsTab.tsx` |

`.h10-spw-ps` is the sharpest case: `ads.css:1757–1861` styles its controls as **bare descendant
tags** — `.h10-spw-ps-tabs button`, `.h10-spw-ps-search input`, `.h10-spw-ps-pager button`,
`.h10-spw-ps-enter textarea` — at a specificity that beats the DS's own single-class rules. A
`<Button>` dropped in there is painted by `.addall` if it keeps the class and loses its layout if
it does not. The file's own docstring says it was built on "the FULL Amazon ProductSelection
anatomy", which is exactly the thing that must not drift.

The remaining 5 are `_lib/EbDateField.tsx` — a bespoke calendar popover (month nav + day cells),
which is a `DateField` question, not a button question.

**The unit of work here is the class, not the directory.** Each row above wants one pass that
touches every twin at once.

## `.h10-editpen` is 1.89:1 — the DS reveals it, `ads.css` colours it, and the colour fails
*Session 1 · ROUND 2 · 2026-08-26 · found in `apply-rules/ApplyRulesClient.tsx` (4 of 10 call sites)*

The in-cell edit pencil is a split-ownership control:
`design-system/styles/workspace-grid.css:332` reveals it (`.nds-wsgrid tbody tr:hover
.h10-editpen { opacity: 1 }`), and `app/marketing/ads/ads.css:581` colours it —
`color: #b6bdc8`, which measures **1.89:1 on white**. WCAG 1.4.11 asks 3:1 of a control's
graphical indicator; this is a little over half of it, on the only affordance saying a cell is
editable.

Ten call sites across the ads console, four of them in this half. Not fixed here: forking a shared
class four ways is the thing this whole exercise is undoing, and the rule that needs changing is
outside this scope. `--nds-grey-500` (3.10:1) clears it and is what
`rules-automation.css`'s `.h10-plc3-pencil` — the same control, hand-rolled — already uses.

The deeper gap: **the DS defines this pattern only for `WorkspaceGrid`.** `.nds-wsgrid tbody
tr:hover .h10-editpen` has no `.nds-grid` counterpart, so an in-cell edit affordance inside a
`DataGrid` has to hand-roll its own reveal — which is exactly why `.h10-plc3-pencil` exists as a
second copy with a `tr:hover` selector of its own. Either the reveal belongs on both grids, or the
pencil belongs in the DS as a primitive (`EditAffordance`?) that owns its own colour and hover.
- `DataGrid.renderExpanded` renders ONE full-width `<tr><td colSpan={all}>`, so it cannot express column-ALIGNED child rows — a campaign's spend under the same Spend header as its product's, which is the whole point of expanding in `ProductsTable` and `CampaignsTable`. Worked around by flattening parent+children into one `rows` array with a `kind` union and `sort={null}`; that works, but it means the grid cannot sort. A `subRows`/`getSubRows` that renders children as real rows would serve both. Also: the prop's docblock cites "as `CampaignsTable` already does" — `CampaignsTable` does NOT use it, that precedent does not exist — apps/web/src/design-system/components/DataGrid.tsx:70

## `.h10-cd-subnav` in `ads.css` is now dead — 4 rules, 1 raw hex
*Session 5 · ROUND 2 · 2026-08-26 · left for whoever owns `ads.css`*

`ads.css:661–664` styles the campaign-detail settings rail. Session 1 moved the Amazon side to
`.cd-subnav` + `Button variant="quiet"/"tonal" block` (see `campaigns-ds.css:41–48`); this session
moved the eBay side the same way, so **`.h10-cd-subnav` now has zero call sites in `apps/web/src`**
— verified by grep across `*.tsx`/`*.ts`/`*.css`, source only.

Deleting the four rules also retires `#1b2230` on line 663, one of the raw hexes the ratchet counts.
Not done here: `ads.css` is outside this session's scope and is the most contended file in the
console, so removal belongs to a session that owns it. The explanatory comment at
`campaigns-ds.css:44` describes the conflict in the present tense; once the rules go it is history,
and could say so.

## `DataGrid` has no density tier ABOVE `md` — it blocks the console's Comfortable/Spacious
*Session 6 · ROUND 2 · 2026-08-26 · found converting `ads-console/campaigns/CampaignsTable.tsx`*

`size` offers `md` (13px / 11px 14px), `sm` (7px 10px) and `xs` (5px 9px) — three tiers that all go
DOWN. `CampaignsTable` ships a live three-way density control in its View menu: `.az-table` 11px,
`.az-table.comfortable` 14px, `.az-table.spacious` 19px (`amazon.css:1392–1393`). Only `compact`
has a `DataGrid` equivalent, so converting today would silently collapse a shipped operator control
to one setting. The table was left hand-rolled and only its pager `<select>` converted (`77e4e16ea`).

The padding is hard-coded in `components.css` (`.nds-grid tbody td { padding: 11px 14px }`), not
tokenised, so a page cannot reach it from outside either — not via `className` (that lands on
`.nds-grid-wrap`) and not via `rowProps` (the padding is on the `<td>`, not the `<tr>`). Either two
tiers above `md` (`lg` 14px, `xl` 19px), or a `--nds-grid-cell-pad-y` the caller may set.

## `DataGrid` cannot express a column-DRAGGING grid — `CampaignsGrid` is not convertible
*Session 6 · ROUND 2 · 2026-08-26*

`marketing/ads/campaigns/CampaignsGrid.tsx:1937–1988` is a `<table>` inside `.nds-wsgrid` — it
already wears the DS grid's skin. It is NOT a hand-rolled table awaiting `DataGrid`; converting it
would DELETE shipped behaviour. Four things have no prop:

- `onPointerDown` / `onMouseEnter` / `onMouseLeave` on `<th>` — drag-to-reorder columns and the
  column hover highlight. `rowProps` covers `<tr>`; there is no `headerProps`/`thProps` counterpart.
- `data-item` / `data-col` on both `<th>` and `<td>` — the drag code reads them back off the DOM.
- a per-column `dragging` class while a drag is in flight.
- a loading state: it renders eight `.sk` skeleton rows, which under `DataGrid` would have to be
  faked as real rows carrying skeleton cells.

So the count of "unconverted tables" overstates the remaining work. This one is a bespoke grid
engine, and the honest ask is for `DataGrid` to grow header hooks — not for the page to give up
dragging to satisfy a metric.

- `DataGrid`'s left-pinned columns get no edge shadow, though right-pinned ones do: `components.css:1143–1147` gives `.sticky-right` an `inset 1px 0 0`, and `.sticky` nothing. Every ads-console table that pins a column hand-rolls `box-shadow: 6px 0 8px -6px rgba(0,0,0,.18)` (`amazon.css:1399` and `:1426`) — the cue that tells you a column is pinned while you scroll sideways. Every conversion of those tables loses it silently — apps/web/src/design-system/styles/components.css:1143
- ✅ RESOLVED (DS session) — **dark mode: 41 sub-AA pairs → 0, verified in the browser.** 14 dark values added, each measured against its ACTUAL usage. `--nds-primary` #6d9ee8 was the constrained one (a FILL under dark text AND text on the surface: 5.84 / 5.59) and deliberately NOT `#8ab6f0`, which is `--nds-text-link` — reusing it would make primary and link the same colour in dark and different in light. `--nds-pill-success-bg` is BLUE not green, because this console's success pill is blue ("ok = blue Enabled").
- 🔴 NEW GUARD — `scripts/check-dark-alias-scope.mjs`, in pre-push. **A custom property whose value is `var(X)` resolves in the scope where it is DECLARED, not where it is used.** So `:root { --nds-pill-warning-fg: var(--nds-warning-text) }` computes on `:root` with the LIGHT value and inherits that literal into `.dark` — overriding `--nds-warning-text` in `.dark` never reaches it. Four tokens had this shape; three pills measured **1.50, 2.09 and 2.21** in the browser while my static resolver reported all three passing. The fix is to re-declare the alias inside `.dark` with the same `var(X)`.

## A selectable card with a trailing badge has no DS answer
*Session 5 · ROUND 2 · 2026-08-26 · found converting `recommendations/RecommendationsClient.tsx`*

`.rec-strat` is the strategy rail: a bordered card per category, each carrying a colour dot, a
label, a **right-aligned count badge**, and a blurb. Single-select, and disabled when its count is
zero. Three DS components are close and each misses:

- **`Card onClick`** — the shape is right, but `CardProps` has no `disabled` (it extends
  `HTMLAttributes`, where `disabled` does not exist), and half these items are disabled at zero.
  Already filed; this is a second surface blocked by it.
- **`RadioCard`** — models the semantics exactly (single-select, `disabled` works, `title` +
  `description`), but `.rc-body` is `flex-direction: column` with **no `flex: 1`**, so it sizes to
  content. A title row with `justify-content: space-between` has no spare width and the count
  lands next to the label instead of at the card's edge. Reaching in with
  `.rc-body { flex: 1; min-width: 0 }` is overriding a DS component's internals, which is the
  thing this programme is undoing.
- **`FilterChip`** has `count` — the right idea, wrong shape: a capsule, not a card with a blurb.

**The gap in one line:** `RadioCard` needs either `flex: 1` on `.rc-body` (harmless — it is a
column in a flex row that currently cannot fill) or a `meta`/trailing slot like `FilterChip.count`.
Either would unblock this rail. Left raw; converting it today means adding a visible radio to a
surface that has none AND overriding the component's layout.

## More `ads.css` rules went dead this session
*Session 5 · ROUND 2 · 2026-08-26 · same disposition as `.h10-cd-subnav` above*

Converting the last two `ai-advertising/new-goal` fields retired their hand-rolled CSS. Both had a
single owner, both are now unreferenced in `apps/web/src`:

- **`.h10-aig-enter`** — `ads.css:1308-1310`, 3 rules, raw hex `#9eaebd`
- **`.h10-aig-money`** — `ads.css:1216-1220` + `1300-1302`, 8 rules, raw hexes `#667085`,
  `#9eaebd`, `#e0322a`

Together with `.h10-cd-subnav` (`661-664`, `#1b2230`) that is **15 dead rules and 5 raw hexes**
the ratchet is still counting. Not removed here — `ads.css` is outside this session's scope.

**Contrast note, filed rather than hidden:** `.h10-aig-enter::placeholder` was `#9eaebd`
(**2.27:1**) and the DS `.nds-textarea::placeholder` is `--nds-text-disabled` (**2.04:1**), so
this conversion *lowers* it. Both fail AA, and the DS value is already filed as a gap for
`Input`. Taken deliberately on the precedent set for `Button variant="primary"` earlier in this
document: overriding a DS token at one call site is how a console ends up with four spellings of
it, and moving onto the token means the eventual fix reaches this surface too. It is the second
conversion in ROUND 2 that goes down rather than up, and both are placeholders.

## Correction — the density gap above is real, but SOFTER than I wrote it
*Session 6 · ROUND 2 · 2026-08-26 · corrects my own entry two headings up*

I wrote that a page "cannot reach it from outside either — not via `className` (that lands on
`.nds-grid-wrap`)". **That is wrong.** Landing on the wrap is not the same as being out of reach:
`.nds-grid-wrap.comfortable .nds-grid tbody td` scores (0,3,2) against the DS's (0,1,2), and
`amazon.css` loads after `components.css`, so it wins on specificity and on source order both. The
counter-example was already in the tree while I was writing the entry — `amazon.css:1629` reaches
straight into `.nds-grid tbody tr.childrow td` to restore the parent/child tint that `.az-table`
used to carry.

So the gap is not "the console cannot have Comfortable/Spacious under `DataGrid`" — it converted
fine. It is that every page wanting a tier above `md` must hand-roll the override, and each one
hand-rolls it differently. That is an argument for `lg`/`xl` sizes or a `--nds-grid-cell-pad-y`,
not a blocker, and `CampaignsTable`'s table should not have been left hand-rolled on my reading of
it (another session converted it the same day and kept all three densities).

One thing to carry over when converting a density-bearing table: `className={density}` puts the
class on the wrap and **nothing styles it yet**. `.az-table.comfortable tbody td` and
`.spacious` (`amazon.css:1392–1393`) both need `.az-table`, which the DS grid does not render, so
the control goes silently inert the moment the table converts unless a matching
`.nds-grid-wrap.<density>` pair lands with it. Check the class against the stylesheet in both
directions, not just one.
- `DataGrid.size` only scales DOWN — `md` / `sm` / `xs`. The campaigns grid has a live "View: Compact / Comfortable / Spacious" density control whose two looser steps (14px and 19px vertical padding against md's 11px) have no DS equivalent, so a grid with no density above its default cannot host a density control at all. Both steps re-homed onto `.nds-grid` in amazon.css so all three settings survive; a `lg`/`xl` on the same scale would serve every consumer — apps/web/src/design-system/components/DataGrid.tsx
- ✅ RESOLVED (DS session) — the stale `.d.ts` files. **19 components were missing 52 props**; `ButtonVariant` listed 5 of its 10 members and `ButtonSize` 2 of 4 — nearly all props I added this session. All 88 regenerated. 🔴 BUT the durable fix is NOT a guard: these files are **gitignored** (`.gitignore:86`), so they are local artifacts, and a pre-push check on them is VACUOUS — I wired one in and then proved it passes with zero declarations present. Removed. The brief now says **read the `.tsx`, never the `.d.ts`**, and `scripts/check-ds-dts-fresh.mjs --write` regenerates them locally. Also: my first audit reported 345 missing props across 55 components — my parser required 2-space indent where the files use 4. The real number was 52.

## No colour-input primitive
*Session 1 · ROUND 2 · 2026-08-26 · found in `_rank/RankTargetEditor.tsx`*

`<input type="color">` has no DS counterpart. `Input` would wrap a swatch in a text field's
chrome, and `Select`/`Listbox` cannot open the platform's own picker. One call site here — the
rank target editor, where an operator picks the colour a paint brush uses on the week grid — so
this is the last raw `<input>` in this half. It had a three-property inline `style` including a
hand-written `#d8dde4`; that is a named class using `--nds-border` now, so the hex is gone even
though the control is not.

Low priority: one call site, and a native colour picker is genuinely hard to skin. Worth a
`ColorSwatch` primitive only if a second surface ever needs one — but worth *naming* in the
primitives README either way, so the next person does not re-derive the inline style.

## 🔴 `Pill onClick` renders at the AMBIENT font size — its own `font-size` is defeated
*Session 5 · ROUND 2 · 2026-08-26 · found on prod, after shipping the first call site*

`Pill` becomes a `<button>` when given `onClick`. `.nds-pill.btn` then applies, to strip the UA's
button chrome:

```css
.nds-pill.btn { font: inherit; font-size: inherit; font-weight: inherit; border-width: 0; cursor: pointer; }
```

That is **(0,2,0)** and it beats `.nds-pill` **(0,1,0)**, which is where the pill's own
`font-size: 11px; font-weight: 600` live. So a clickable pill does not inherit "the button's type",
it inherits **the page's** — whatever font-size the surrounding element happens to have.

Measured on prod, the eBay rule-card mode pill against the static `Pill` immediately beside it in
the same row:

| | clickable `Pill` | static `Pill` |
|---|---|---|
| font | **16px / 400** | 11px / 600 |
| box | **93 × 30** | 148 × 23 |

The component's own comment says "a clickable pill is visually identical to a static one; only the
cursor and the hover say it is interactive." It is not: 7px taller and half again the type size.

**Why nobody hit it:** parsing every `<Pill …>` tag across `apps/web/src/app` (multi-line aware —
a one-line grep misses it) finds **61 `Pill` sites and exactly ONE with `onClick`**, the one this
session converted. The prop was added to `Pill` FOR that call site, documented in its own
docstring, and never exercised until now.

**The fix is one line in the DS** — drop `font-size`/`font-weight` from `.nds-pill.btn` and keep
only `font-family`, or re-state the pill's own two values after them. `font: inherit` alone is the
culprit; the shorthand resets size and weight and the two longhands after it re-assert `inherit`.
Not done here: `design-system/**` is off-limits to this session.

Worked around locally at `ebay.css` — `.eb-rule-head .nds-pill.btn { font-size: 11px; font-weight: 600 }`
(0,3,0). **That workaround should be deleted when the DS is fixed.** Any future `Pill onClick`
call site will need the same until then.
- ✅ RESOLVED (DS session) — the last `DataGrid` cluster. `getSubRows` renders children as REAL rows using the same columns — verified live: child, parent and header share identical column right-edges (720.1 / 1262 / 1700), so a child's spend sits under the same Spend header. That removes the flatten-into-one-array workaround and its `sort={null}` cost. `headerProps` / `cellProps` give the `<th>`/`<td>` escape hatches column drag-reorder needs (`onPointerDown`, `data-col`), so a grid that already ships dragging can adopt `DataGrid` without deleting it. `size` now scales UP too — `lg` 14px and `xl` 19px, verified 38 → 44 → 54 per row — so a grid can host a Compact/Comfortable/Spacious control.
- ⚠️ NOT A DEFECT — the `renderExpanded` docblock's "as `CampaignsTable` already does" refers to the CARET pattern, which `CampaignsTable` does use (`aria-expanded` on a caret in a cell). It never claimed that file uses `renderExpanded`. Wording sharpened so it cannot be misread again, and it now points at `getSubRows` for column-aligned children.
- 🔴 `--nds-primary` (#1f6fde) as TEXT is 4.79:1 on white but **4.42:1 on the ads shell's own ground** (`.h10-shell`, #f4f6f9) — under AA. It matters most for `Tabs size="lg"`, whose ACTIVE tab is the one thing on the bar that must read, and which sits directly on that ground (no card) on every rules-automation / suggestions page: measured 4.42 on /marketing/ads/suggestions, 4.79 on /marketing/ads/campaigns/<id> where the same bar sits on white. Same applies to `Button variant="ghost"` text and anything else colouring text with the primary. A token that clears 4.5:1 on #f4f6f9 fixes every one at once. — apps/web/src/design-system/styles/components.css `.nds-tabs.lg .nds-tab.on`, tokens.css `--nds-primary`
- ✅ RESOLVED (DS session) — `NumberStepper` (`.az-bias-edit`, `.h10-hv-step`). ONE bordered track with hairline dividers on the INPUT, not three boxes — built from `Button` + `Input` + `Button` it would carry three borders and three radii. Native spinners suppressed (they are ~13px, hover-only, unusable on touch); clamping lives in the component so `min`/`max` cannot be bypassed by the buttons. Verified live: track 28px outer / 26px inner matching the originals, all three parts exactly 26px, parts adjoin with no gaps, no part carries its own border, value 15.48 light / 12.73 dark, buttons 5.36 / 6.85, both aria-labels present.
- ✅ RESOLVED (DS session) — `--nds-primary` used as TEXT on the console's own ground. Filed by Session 56: #1f6fde is 4.79:1 on white but **4.42:1 on `.h10-shell` #f4f6f9**, and `Tabs size="lg"` sits straight on that ground with no card. Three rules repointed to `--nds-text-link` (5.52 on the shell): `.nds-tab.on`, `.nds-tabs.lg .nds-tab.on`, `.nds-subitem.on`. Also `.nds-wsgrid td.empty` grey-500 **2.87 → 4.86**.
- 🔴 OPEN, and a HOLE IN MY OWN AUDIT — my contrast sweep only measured rules declaring BOTH a colour and a background token. **A rule that sets `color` alone inherits the page ground**, which on this console is #f4f6f9, not white — and that whole class went unchecked. 48 such rules are sub-AA on the shell across 9 tokens: `--nds-white` 1.08, `--nds-grey-300` 1.54, `--nds-wsgrid-icon-muted` 1.75, `--nds-text-disabled` 1.89, `--nds-text-3` / `--nds-grey-500` 2.87, `--nds-info` / `--nds-blue-600` 4.42. **NOT all defects** — several are icons (3:1 applies) and several get a background from a sibling rule, which is exactly the false-positive class Session 56 warned about. Needs per-rule browser verification before any bulk substitution.
- ✅ RESOLVED (DS session) — three filed by Session 56, plus two by Session 1. 🔴 **`Field` was producing a broken label association** — it clones its single child with a generated id, and `Listbox`/`DateField` had closed prop sets that silently dropped it, so `<label for>` pointed at nothing. That is worse than no label: the markup looks correct and the control reads as unlabelled. Both take `id` and `aria-describedby` now. **Placeholders**: `.nds-listbox-btn .ph` was `--nds-text-3` (3.10) and `.nds-ms-btn .ph` was `--nds-text-disabled` (**2.04**) — when a field is empty that string is its only visible text, so it is not decoration. Both → `--nds-text-muted` (5.01). **`--nds-note-warn-border` / `--nds-note-error-border`** added; the trios shipped bg/fg/icon and a session had to DROP the amber-hairline cue for want of a token. **`Column.className`** (a per-column tweak needed `:nth-child()`, which breaks when a column is hidden or reordered) and **`.nds-grid tbody td { vertical-align: top }`** (ten converted tables each carried the same override).
- `DateField` has `disabled` but no `readOnly`. They are not the same control: a disabled trigger leaves the tab order and its value cannot be focused or copied. The campaign's Start Date is a value Amazon owns and the operator reads — it is read-only, not disabled — so it stays a raw `<input readOnly>` rather than lose selection and keyboard reach. Its `<label for>` resolves today (verified in the DOM), so this is the only thing keeping it un-converted. Same shape as `Listbox`. — apps/web/src/design-system/components/DateField.tsx:74, apps/web/src/app/marketing/ads/campaigns/[id]/tabs/DetailsTab.tsx:224
- ✅ RESOLVED (DS session) — `--nds-text-3` is the ICON tier, floor 3:1, and it cleared that on a white card (3.10) while MISSING it on the console's own ground (#f4f6f9, **2.87**) and on `--nds-surface-sunken` (**2.74**). Handed back by Session 1, same shape as the `--nds-primary` finding: one token, one ground either side of the line. Now **#7e8796** — the smallest move that clears 3:1 on all three (3.62 / 3.35 / 3.20), so nothing shifts more than it must. Decoupled from `--nds-grey-500`, which its other consumers still use unchanged. Dark override untouched (already 4.62–5.20). Also extended `vertical-align: top` to `.nds-grid thead th` — Session 1 kept a narrowed override for exactly that gap.
- ✏️ CORRECTION to the `.bp-btn.warn` line above (line 43): it says `secondary` would "delete the only signal separating the safe rehearsal from the live write". That overstates it. The two buttons are labelled **"Dry-run preview"** and **"Run rebalance"**, and each carries its own icon — the amber is a semantic tint ON TOP of an already-distinguishable control, not the sole carrier of the distinction. At 5.66:1 it is a good cue and worth having (the DS `warning` variant now provides it), but "the only signal" is the kind of phrasing that gets repeated into a requirement. Same correction another session made to its own "the border IS the signal" claim; no hairline in this system could carry 1.4.11 alone — `--nds-border` is 1.3:1.

## Three tokens in a row pass on white and miss on a ground the system defines
*Session 1 · ROUND 2 · 2026-08-26 · found sweeping contrast in `rules-automation/`*

Measured against the three light grounds the design system itself defines — `#ffffff`,
the shell's `#f4f6f9`, and `--nds-surface-sunken` (`--nds-grey-100`, `#eef1f5`):

| token | white | shell | sunken | floor |
|---|---|---|---|---|
| `--nds-primary` #1f6fde | 4.79 | **4.42** | **4.24** | 4.5 (text) |
| `--nds-text-3` #8a93a1 → **#7e8796** | 3.10 → 3.62 | **2.87** → 3.35 | **2.74** → 3.20 | 3 (icon) |
| `--nds-text-muted` #667080 | 5.01 | 4.62 | **4.42** | 4.5 (text) |

`--nds-text-3` is fixed (`5a56c3ee6`). `--nds-primary` is filed (`bce870746`).
`--nds-text-muted` at 4.42 on sunken is the new one.

The pattern is the finding, not any single number: **whatever check produced these pairs was run
against white.** Every one of them clears on a card and misses on a ground the system ships. A
token that is only correct on `#ffffff` is a token that is correct in the token file and wrong on
the page.

Two cautions for whoever picks this up, both of which cost me time:

**Do not turn this into a count of broken text.** Checking every declaration against all three
grounds reported 346 failures in my four stylesheets; the live probe, compositing the real
background from the element outward, found **one per page**. Almost nothing that uses
`--nds-text-muted` ever paints on a sunken surface. 4.42 is a fact about the token, not a defect
count — worth fixing at the token, not worth chasing at call sites.

**A rule that names a RAMP gets no benefit when you fix a ROLE.** When `--nds-text-3` was raised,
three of my seven icon rules improved and four did not, because those four said
`var(--nds-grey-500)` — the same hex, none of the meaning. The same mistake ran the other way
earlier the same day: 137 text declarations naming grey ramp steps that should have been text
roles. A `color:` pointing at `--nds-grey-*` is nearly always a role wearing the wrong name, and
it is the kind of thing a ratchet could catch.

**Sharpened after a third instance.** It is not only ramp-vs-role — it is that **an alias hides
the miss**. `--nds-primary` is `var(--nds-blue-600)`; `--nds-text-3` was `var(--nds-grey-500)`.
A call site can name either the role or the ramp, they render identically, and only the role moves
when the role is fixed. Three times in one day a token fix landed and my files missed it:

| fix | reached | missed, and why |
|---|---|---|
| `--nds-text-3` raised | 3 icon rules | 4 said `--nds-grey-500` |
| `--nds-primary` text uses → `--nds-text-link` | 7 rules | 53 said `--nds-blue-600` |
| `--nds-grey-500` is not a text token | — | 137 text rules were naming the ramp to begin with |

So a ratchet on this needs to flag the ALIAS TARGET, not just the ramp names it knows about: a
rule saying `--nds-blue-600` is invisible to a check that only bans `--nds-grey-*`. Decoupling
`--nds-text-3` from the grey ramp (making it a literal) was the right move for exactly this
reason, and the same applies to any role that is still an alias.
- ✅ RESOLVED (DS session) — 🔴 **the systemic finding, named by Session 1: "whatever check produced the token pairs was run against WHITE ONLY."** Three tokens had been reported one at a time (`--nds-primary` 4.42, `--nds-text-3` 2.87, `--nds-text-muted` 4.42) — all fine on white, all failing on grounds the system defines itself. So I ran the full matrix instead of fixing a third instance: every text/icon role token against every ground (`white`, `.h10-shell`, `--nds-bg`, `--nds-surface`, `-raised`, `-sunken`, `-hover`). Exactly **2** failed. `--nds-text-muted` → **#626c7b** (worst ground 4.42 → 4.69), the smallest move clearing 4.5 everywhere. `--nds-primary` was NOT darkened — it is a FILL, and darkening it changes every primary button; instead the 7 rules using it as TEXT now use `--nds-text-link`, which is the same principle already applied to the tabs. Icons left on it (floor 3:1, clears). **Now 0 of 11 role tokens fail on any defined ground.**
- 📋 IDEA (Session 1) — a ratchet on `color: var(--nds-grey-*)`. Their point: "a rule that names a RAMP gets no benefit when you fix a ROLE" — they had four icon rules naming `--nds-grey-500` directly, so raising `--nds-text-3` left them exactly where they were. The token-guard already bans ramps in components/primitives/patterns but NOT in `workspace-grid.css`, which is built on them. Converting that file is the prerequisite.

## workspace-grid.css ramp→role conversion — SIZED AND FILED, deliberately not done
*DS session · 2026-08-26 · the prerequisite Session 1 named for a `color: var(--nds-grey-*)` ratchet*

**Scope, measured:** 99 ramp-token declarations across 22 tokens — 40 `background`, 38 `color`, 16 border-ish, 2 `box-shadow`, 2 `accent-color`. All 38 of the DS's ramp-as-colour uses are in this ONE file; `components`/`primitives`/`patterns` have **zero**, because token-guard already bans ramps there.

**Why it is not a rename.** Roles have DIVERGED from the ramps they once aliased, so 13 of 28 property-aware mappings change the rendered colour. Three change it badly:

| property | ramp | proposed role | ramp hex | role hex | |
|---|---|---|---|---|---|
| background | `--nds-purple-600` | `--nds-badge-sp-bg` | #7400bc | #f3e8ff | 🔴 dark purple → pale lavender |
| color | `--nds-grey-300` | `--nds-text-3` | #c2c9d3 | #7e8796 | 🔴 a resting sort arrow darkens hard |
| background | `--nds-green-500` | `--nds-success-strong` | #1e9e62 | #15803d | 🔴 visibly darker fill |
| color | `--nds-blue-600` | `--nds-text-link` | #1f6fde | #1a60c4 | ok, raises |
| color | `--nds-grey-450`/`-500` | `--nds-text-3` | #98a2b3/#8a93a1 | #7e8796 | ok, raises |
| color | `--nds-grey-800` | `--nds-text` | #2b3440 | #1c2530 | ok, raises |
| background | `--nds-grey-50`/`-75`/`-100` | surface tiers | — | — | ±1 step, subtle |
| border | `--nds-grey-100` | `--nds-border-subtle` | #eef1f5 | #e6e9ee | ok |

The remaining 15 map with no change at all.

**So it needs per-rule judgement, not a substitution** — and this grid is rendered by 58 files. The measurable failures in it are ALREADY fixed (the three sub-AA rules, and `.pb`'s `--nds-white` background that broke in dark). What is left is a consistency and dark-mode-completeness job, not a correctness one.

**When it is done:** add `styles/workspace-grid.css` to `RAMP_FILES` in `tools/token-guard.mjs` in the same commit, or it will drift straight back. And per Session 1: the check should flag ALIAS TARGETS too — a rule naming `--nds-blue-600` is invisible to a ban that only knows role names.
- 🔴 ✅ RESOLVED — **the console was illegible for anyone whose OS is dark, and I made it worse.** `.h10-shell` grounds itself on `--nds-grey-50` (a RAMP step, which `.dark` never touches) and sets `color-scheme: light`, but `.dark` lands on `<html>` whenever the OS prefers dark — `system` is the default mode — and redefines the SEMANTIC tokens. So the text flipped and the ground did not. Measured on that ground under `.dark`: `--nds-text` **1.11**, `--nds-text-strong` **1.11**, `--nds-success-text` 1.42, `--nds-warning-text` 1.70, `--nds-text-2`/`-muted` 1.91, `--nds-text-link` 1.93, `--nds-danger-text` 1.97. **My own dark-palette work caused half of it** — `--nds-text-strong` and `--nds-text-muted` had no dark override until I added one. Fixed by pinning all **54** flipping tokens to their DS light values on `.h10-shell`, at EOF of `shared-shell.css`. Verified in a real `html.dark`: pinned 14.30 / 9.11 / 5.46 / 4.91 / 5.52, and an UNPINNED control on the same ground still reads **1.11**, which is what proves the pin is doing the work. 🔴 **Adding a `.dark` override to any DS token now means adding its pin there too** — noted in the block.

## A token-name sweep has a blind spot by construction, and it is the aliased half
*Session 1 · ROUND 2 · 2026-08-26 · a search-strategy finding, not a contrast one*

`--nds-primary` **is** `var(--nds-blue-600)`. `--nds-text-2` **is** `var(--nds-grey-600)`.
`--nds-text-3` **was** `var(--nds-grey-500)`. Where a role is defined as an alias of a ramp step,
a call site can name either side and they render identically — so:

- a rule naming the **ramp** is invisible to a fix on the **role** (`--nds-text-3` was raised and
  reached 3 of my 7 icon rules; `--nds-primary`'s text uses moved to `--nds-text-link` and reached
  7 while 53 of mine said `--nds-blue-600`);
- a rule naming the **role** is invisible to a ground that pins the **ramp** — and vice versa.

**Whichever way the token is defined, the search for it misses the other side.** That is not a
contrast problem; it is a property of aliased design tokens, and it applies to any sweep keyed on
token names — deprecations, renames, theme audits, ratchets.

Three consequences worth acting on:

1. **A ratchet on this must resolve aliases**, not match names. A check banning `--nds-grey-*`
   never sees `--nds-primary`, and a check banning `--nds-primary` never sees `--nds-blue-600`.
2. **Decoupling a role from its ramp is a correctness change, not tidying.** Making `--nds-text-3`
   a literal was what let it move without dragging `--nds-grey-500`'s other consumers.
3. **A pin scoped to a subtree only protects that subtree.** Eight DS components portal to
   `document.body` — Modal, Menu, Drawer, Listbox, Combobox, MultiSelect, HoverCard, Toast — which
   is outside `.h10-shell`. This half styles ~100 rules on portalled surfaces, and for those a
   ramp step is the only theme-safe choice: correct on both sides of a portal, where a pinned
   semantic token is correct on one.

And the method rule underneath all of it, from nexus-commerce-56, who caught their own probe with
it: **containment is a DOM fact, so assert it.** `.h10-shell` sits INSIDE `main`, not around it —
there are two `<main>` elements and `document.querySelector('main')` returns the outer one. A
probe appended to `main` measures the UNPINNED zone while appearing to measure the page. Verify
the rendered value on a real element, not the token name on a synthetic one.
- ✅ RESOLVED (DS session) — two filed against my own variants. **`Button muted`**: `quiet` inherits by design (the 25 `.acr-btn` sites needed it), but inside a container computing `--nds-grey-900` an inherited `quiet` renders near-black and promotes a muted secondary action to full emphasis. The filer's line is the right one — *"raising contrast is not the same as preserving hierarchy"* — and there was no way to ask for the second. `muted` pins to `--nds-text-2` (5.91 white / 5.46 shell). **`ToolbarButton revealOnRowHover`**: put `nds-reveal-row` on the row and the button fades in on hover. 🔴 It stays visible on `:focus-visible` regardless — `opacity: 0` does NOT remove a button from the tab order, and an icon a keyboard user can reach but cannot see is worse than one that is always there. Unblocks `.h10-editpen`, which is **1.89:1** and was a site the brief most wants converted.
- ✅ RESOLVED (DS session) — `.h10-sug-buf`, the last genuinely-open gap. `Input` takes `affix?: 'inside' | 'outside'`. The filer's diagnosis was right and their self-correction was the useful half: the blocker is ANATOMY, not specificity. `inside` (default, unchanged) is the shaded adornment `[€|12.50]`; `outside` puts the mark beside the box as plain text `€ [12.50]`. **Not two anatomies** — the border stays on `.nds-field` either way, only the MARK moves, so a caller's `on`/`edited` tints still ring the input alone. Justified by count, not by one site: 26 rules in this console put the border on the input for exactly this reason, and `prefix=` already has 83 call sites. Verified live: `inside` unchanged (mark shaded, inside the border); `outside` mark unshaded, fully outside, row carries no border, field keeps its 1px.
- `.az-kebab` motion/blend disclosures → `ToolbarButton` has ONE engaged colour, and these two need two — `rank/RankTargetEditor.tsx:276,277`. Corroborates the `tone` gap Session 5 filed from `suggestions/` (DS-SPEC #2) with a second page and a second shape: not staged states but two sibling DISCLOSURES, indigo `#3730a3` (Motion, 9.93:1) and violet `#7c3aed` (Blend, 5.70:1), whose panels open in the same place. `[aria-expanded='true']` renders both at `--nds-text` 15.48:1 — contrast RISES, and the operator loses which of the two is open. Left hand-rolled; a `tone` that applies to the expanded state would close it.
- ✅ RESOLVED — 🔴 **the other half of the shell pin: portals escaped it.** Found by nexus-commerce-c4. Eight DS components portal into `document.body` (Listbox, Menu, Combobox, MultiSelect, HoverCard, Modal, Drawer, Toast), so they render OUTSIDE `.h10-shell` and a pin scoped to that selector never reached them. On a dark OS the console was light and every dropdown was dark. **No per-surface contrast probe can see this** — each popover is internally coherent and above AA in both themes; it is a COHERENCE failure, not a contrast one. Fixed by widening the pin to `body:has(.h10-shell)`, which covers every portal without any component needing to know about themes. Verified live with a popover rendered as a SIBLING of the shell inside `html.dark`: background white, selected option 5.45, plain option 9.87. Also removed a stale `--nds-text-3: var(--nds-grey-500)` pin from an earlier block in the same file — it silently undid the icon-tier darkening inside the console (2.74 vs 3.20 on tinted grounds), and only source order was saving it.

## `SegmentedOption` has no per-option `disabled` — it blocks the fourth call site
*Session 2 · ROUND 2 · 2026-08-26 · found converting the `.az-mode-seg` fake tablists*

`SegmentedControl` takes `disabled`, but it disables the WHOLE control; `SegmentedOption` carries
only `value`, `label`, `icon` and `title`. That is enough for three of the four `.az-mode-seg`
call sites, which converted cleanly (`ba0f3e2b4`). The fourth cannot:

`ads-console/rank/RankTargetEditor.tsx:234` offers "This product / This campaign" against "Global
defaults", and the scope option is `disabled={!scopeAvailable}` until the thing is saved, with
`title="Save the … first to set overrides here"`. Converting today would drop the `disabled` and
let an operator select a scope that does not exist yet — a real behaviour regression in exchange
for a conversion count, so it stays hand-rolled.

`title` already survives (`SegmentedOption.title` exists, added for exactly this kind of per-option
explanation), so the pairing is half there: the control can explain why an option is unavailable
but cannot make it unavailable. A `disabled?: boolean` on `SegmentedOption`, skipped by the
arrow-key `move()` the same way a roving-tabindex group skips a disabled radio, closes it.

Worth checking the same shape elsewhere before adding it: a segmented control whose options are a
SCOPE almost always has one that is conditionally unreachable.
- ✅ NEW GUARD — `scripts/check-shell-pin-fresh.mjs`, in pre-push. Two checks: **COMPLETE** (every token `.dark` flips is pinned by `.h10-shell`) and **FRESH** (every pin still resolves to the DS's own light value). Session 56's rule — *"a pin must name a LITERAL, or it inherits the drift it exists to prevent"* — is right, and this is the alternative to relying on that discipline: a pin may be written either way and the guard fails when it stops agreeing with the DS. Proven against BOTH failure modes, using the exact bug that shipped. 🔴 Its first run reported `--nds-shadow-rail` stale — a FALSE positive, because my resolver expanded only a bare `var(x)` and the pin says `rgba(20, 28, 38, 0.13)` where the DS says `rgb(var(--nds-shadow-rgb) / 0.13)`: identical values, different notation. Fixed the probe, not the pin. A guard that cries wolf on a correct pin gets ignored on a real one.
- `.az-ins-nav` → `SegmentedControl`/`Tabs` cannot interleave a labelled DIVIDER between options — `automation/InsightsTab.tsx:45`. The tablist runs reports first, then a `.az-ins-div` reading "Tools", then the tool views; the divider is generated inside the same `.map`, keyed off `v.kind !== VIEWS[i-1].kind`. `SegmentedOption` is `{value,label,icon,disabled,title}` with no group or separator, so converting would silently drop the only thing telling an operator where reports end and tools begin. Left hand-rolled. A `group?: string` on the option, rendered as a separator when it changes, would close it.
- `.az-rowmenu` destructive item → `MenuItemDef` has no per-item tone or `className` — `campaigns/CampaignsTable.tsx:526`. The row menu's last item is Archive, styled `.danger`: #cc1100 text AND icon, with a #fdeceb hover. `MenuItemDef` is `{id,label,icon,disabled,onSelect,separator}` and `.nds-menu` is PORTALED, so a wrapper `className` cannot reach the item either. Converting would render a destructive action identically to Duplicate. Left hand-rolled — the other two menus in the same file converted fine. A `tone?: 'neutral' | 'danger'` on the item would close it.
- 🔴 STILL OPEN and now blocking a second session — `--nds-text-disabled` as `.nds-field > input::placeholder` is **2.04:1** (`--nds-grey-400` #aeb6c2). Session 5 filed this as its #1 and wrote "if only one of these lands, make it #1"; `Input` has since gained `affix`, `SegmentedControl` gained `ariaLabel`, and this one has not moved. It blocks **12 of the 29 raw `<input>` left in `ads-console/**`, across 5 files**, because a raw input with no declared placeholder colour inherits the UA's #757575 at 4.61:1 — so every conversion of a field that HAS a placeholder more than halves it, to below the 3:1 non-text floor. The sibling `.nds-field .lead` did improve, #8a93a1 → #7e8796, 3.10 → 3.62:1, but Amazon's own search glyph is #565959 at 7.07:1, so `.az-search` (`campaigns/CampaignsTable.tsx:430`, `campaigns/CustomiseColumns.tsx:102`) is blocked on both halves at once and stays hand-rolled.

## /products/next DS alignment · 2026-08-26

- ✅ RESOLVED — **`Column.prefsLocked`**. `customizable` derived "locked in the Customise dialog" from `sticky`/`stickyRight`, so a grid whose Product and Actions columns must not move could only say so by PINNING them. That is a different, visible decision: this page had its sticky toggles removed deliberately (`showSticky={false}`) because pinning the Product column was not wanted, and the columns still have to stay put. `prefsLocked` holds a column at whichever end its position implies, without pinning. With no `prefsLocked` present the partition reduces case-for-case to the `filter(c.sticky)` / `filter(c.stickyRight)` it replaces. Also split `showSticky` off lockedness onto a new `anyPinned` — the toggles govern PINNING, and with `prefsLocked` those stopped being the same question — apps/web/src/design-system/components/DataGrid.tsx:237
- ✅ RESOLVED — **`DataGrid.subRowSelectable`**. `getSubRows` children rendered an EMPTY `td.ck` when `selectable`, so children could not be selected and select-all could not reach them. Correct for the two consumers that had it (an ad group is acted on through its campaign) and wrong for a product variation, which has its own status and its own price. Opt-in, so `ads-console/{campaigns,products}Table` are untouched; `rowSelectable` still gates each child, which is what keeps the lazy-load sentinel row out of select-all — apps/web/src/design-system/components/DataGrid.tsx:122
- ✅ RESOLVED — **`Metric.onClick` / `active` / `hint` / `accent`** on `MetricStrip`. Metric tiles are very often FILTERS and there was no way to say so, so this page shipped four `<div role="button">` with a hand-written `onKeyDown` and no pressed state at all. `onClick` makes the tile a real button with `aria-pressed`; `hint` is the sub-line that says what the number counts (muted tier, not the icon tier — it is 11.5px running text); `accent` is the status dot. All optional, so `AiAdvertisingDashboard` is unchanged — apps/web/src/design-system/components/MetricStrip.tsx:9
- `Pill tone="success"` renders **blue**, in both themes: `--nds-pill-success-bg` is `#d2e6fc` and `--nds-pill-success-fg` is `--nds-blue-900`, with `.dark` flipping them to `#1c2f4d` / `--nds-text-link`. NOT a contrast defect — the blue is 6.37:1, better than the green a page reaching for it would pick (`--nds-green-700` on `--nds-green-soft` is 4.57:1). It is a SEMANTIC one: an entity-status pill cannot say "Active, and that is good". `/products/next` works around it by redefining the two tier-3 component tokens inside its own page wrapper, which is a page reaching into the DS's component namespace to change what a tone MEANS — apps/web/src/design-system/styles/tokens.css and apps/web/src/app/products/next/styles.module.css:18
- `DataGrid customizable` hard-codes `sortFieldOptions={[]}`, so a grid that adopts the DS Customise dialog LOSES any sort section it had. Defensible for a grid that sorts from its headers — and this page now does — but it is not a choice the caller can make: `/products/next` previously offered Product name / Available stock / Price in the dialog and that section is simply gone. A `prefsSortFields` pass-through would close it — apps/web/src/design-system/components/DataGrid.tsx:559
- `Menu` has no icon-only or compact trigger. The row-actions "⋯" is a 28×28 square; `.nds-btn` is `padding: 7px 13px` with no height, so squaring it takes five `!important`s at equal specificity. Compounding it, `triggerProps` is spread AFTER `className="nds-btn"`, so a custom class REPLACES the DS one — deliberate, and depended on by budget-manager.css:43 and rules-automation.css:951, but it means a trigger that forgets to re-pass `nds-btn` is a bare unstyled button with no border, background, hover or focus ring. This one had been exactly that — apps/web/src/app/products/next/styles.module.css and apps/web/src/design-system/components/Menu.tsx:51
- No live/sync STATUS INDICATOR (dot + label: "Live" / "Syncing…"). `--nds-live` exists as a token but its only consumer is the Toast success dot; `Pill`/`Tag` are static text with no dot slot. Left hand-rolled as `.liveChip`/`.liveDot` — apps/web/src/app/products/next/styles.module.css
- No tri-state COVERAGE BADGE — a 22px square carrying one letter per channel, tinted live / issues / not-listed, wrapped in a Tooltip. `Tag` is pill-radius, auto-width and single-tone. Third variant of the same shape after `.h10-cl-sum .chip` and `.hl-fchip`, but square and fixed-size rather than a chip. Left hand-rolled as `.ch`/`.chOn`/`.chOff`/`.chIss` — apps/web/src/app/products/next/styles.module.css
- `PreferencesModal` does not collapse to ONE panel when every left-panel section is hidden. It is a two-panel dialog whose left side holds page-size, sticky and sort; `DataGrid customizable` passes `sortFieldOptions={[]}` and `pageSizeChoices={[]}`, and `showSticky` is false for any grid with nothing pinned — so a grid that locks its edge columns with `prefsLocked` rather than `sticky` gets a dialog that is ~50% empty. Measured on /products/next at 1512px: the columns list occupies the right 375px of a 800px dialog body. Either collapse to a single panel when the left is empty, or let the caller pass the width — apps/web/src/design-system/patterns/PreferencesModal.tsx
- `.mmin` (ads range filter, `ads.css`) rests on `--nds-grey-300` with NO `:hover` rule, where the DS's own `.nds-field` / `.nds-ms-btn` / `.nds-fpanel` select all rest on `--nds-border` and move to `--nds-border-strong` on hover. So the ads min/max boxes read darker at rest than every control beside them, and the app's TWO range filters now disagree: the DS one was corrected 2026-08-27 (`.nds-range-in`), this one was not. Reported by nexus-commerce-c3 while checking whether the DS double-outline bug had siblings — it does not (`.h10-am-fpanel .mm` is a borderless flex row, so it never had the concentric-outline defect), but the resting tone drifted the same way — apps/web/src/app/marketing/ads/ads.css:150 (`.h10-am-fpanel .mmin`), against `.nds-range-in` as of `338743995`
- **`PreferencesModal` has a second, un-migrated implementation** — `app/_shared/grid-lens/PreferencesModal.tsx`, 416 lines, its own DOM, **zero** `--nds-*` tokens, Tailwind throughout. It borrows only `Listbox` + `tokens.css` + `components.css` from the DS, then re-implements the dialog. Six pages render it and NOT the DS one: `ProductsWorkspace`, `ListingsWorkspace`, `PricingMatrixClient`, `StockWorkspace`, `ReplenishmentWorkspace`, `PurchaseOrdersClient` — all via the `@/app/_shared/grid-lens` barrel, which re-exports it at `index.ts:14`. So the app ships two visually different Customise dialogs, and a change to the DS pattern reaches neither of those six. Compounding it, the ONE dialog now has three titles across its DS consumers — `WorkspaceGrid.tsx:955` `"Table Customisation"`, `CampaignsGrid.tsx:1987` `"Table Customization"`, DS default `'Customise'` — differing by a single s/z; the app's prevailing spelling in user-visible strings is American (86 `Customiz*` vs 19 `Customis*`; 9 `Organiz*` vs 1). Found by `nexus-commerce-53`; independently verified here. **This gap was invisible to every previous audit** — see the next entry — apps/web/src/app/_shared/grid-lens/PreferencesModal.tsx
- **Six files in `apps/web/src` are skipped by plain `grep`, silently.** Each embeds a raw U+0000/U+0001 byte as a `join()` separator — written as a literal control character rather than the escape `'\u0000'` — so `file(1)` reports `data` and grep declines to read them, with nothing on stderr. `WorkspaceGrid.tsx` returns **0** hits for `PreferencesModal` under plain `grep` and **4** under `grep -a`. That is how the DS's own `workspace-grid` — the entire ads console — went unlisted as a `PreferencesModal` consumer. Full list and the lossless fix (swap the raw byte for the escape; verified behaviour-identical, and the file flips from `data`/0 hits to `ASCII text`/1 hit) in `docs/2026-08-27-products-next-rebuild-handoff.md` §6.7. **Scope of the damage, corrected 2026-08-27 after measuring rather than inferring: this affects ad-hoc `grep` audits ONLY — it does NOT affect the ratchets.** Every guard in `scripts/` reads via Node `readFileSync`, which is byte-agnostic; `file(1)`/`grep` binary detection never enters. Proved by instrumenting `readFileSync`: `ds-conformance-guard.mjs` reads both binary files that sit inside its scope (`ImportClient.tsx`, `VariationValueOrderModal.tsx`). `WorkspaceGrid.tsx` is unscanned by the two `.tsx` guards for an unrelated and deliberate reason — `design-system/**` is exempt (`check-raw-primitives-ratchet.mjs:24` "it IS the design system"; `ds-conformance-guard.mjs:28` roots at `apps/web/src/app`). So **no ratchet is passing for the wrong reason on account of these bytes**, and fixing them will NOT move any baseline. The cost is confined to manual and agent-run `grep` censuses — which is exactly where it did land — apps/web/src/design-system/patterns/workspace-grid/WorkspaceGrid.tsx:470
- 🔴 **The fork-drift guard covers NONE of the four DS stylesheets.** `scripts/ds-fork-baseline.json` freezes 9 files, and four of them are `styles/tokens.css`, `styles/patterns.css`, `styles/components.css` and `styles/primitives.css`. The guard only asserts that files which *were* identical still are, so for all four it passes no matter what either copy says. **Consequence: a DS CSS fix that lands in `apps/web` and not `apps/factory` — or vice versa — is caught by nothing today.** Not the guard, not tsc, not the pre-push build. This is wider than the single-file case it was found through, and it is the highest-traffic part of the DS. Confirmed independently by `nexus-commerce-c3` and this session on 2026-08-27, from both directions (baseline contents, and an instrumented run).
  **Per-change workaround until it is closed** — extract your own added lines from both copies and hash them, asserting the extraction is non-empty first:
  ```sh
  f=components.css
  w=$(git diff -- "apps/web/src/design-system/styles/$f"     | grep -a '^+[^+]' | sed 's/^+//')
  x=$(git diff -- "apps/factory/src/design-system/styles/$f" | grep -a '^+[^+]' | sed 's/^+//')
  [ -z "$w" ] && echo 'EXTRACTION EMPTY — the diff below would be meaningless'
  [ "$(printf %s "$w" | md5)" = "$(printf %s "$x" | md5)" ] && echo mirrored || echo DRIFT
  ```
  The empty-check is not paranoia: c3 ran a mirror probe whose extraction silently produced nothing (`head -n -1`, rejected by BSD `head`), `diff` found no difference between two empty strings, and it reported IDENTICAL. A miss and a match look the same when the instrument produced nothing — scripts/ds-fork-baseline.json

## GDS Phase 1 · 2026-08-28 · grid tokens

- ✅ RESOLVED (GDS-1) — **the AG theme bound ramp steps and said they were dark-aware.** `engine/theme.ts` bound `--nds-white`, `--nds-grey-25/150/200` for ground, header, rules, partition and frame; `.dark` flips 54 semantic tokens and zero ramp steps, so a dark NexusGrid was dark text on a white ground. Now `tokens/grid.ts` → `--nds-grid-*`, every colour a semantic role, re-declared in `.dark` AND pinned in `.h10-shell`. Both guards fired on the first run and were right — apps/web/src/design-system/tokens/grid.ts
- ✅ RESOLVED (GDS-1) — **a header partition was 30 % of the CELL, not the header row.** A cell spanning the column-group strip is 76px tall, so the inventory editor drew 22.8px marks beside 13.8px ones. `headerColumnBorderHeight` is now `calc(var(--nds-grid-header-h) * 0.3)`, the wrapper stamps the header height — apps/web/src/design-system/patterns/workspace-grid/engine/theme.ts
- ✅ RESOLVED (GDS-1) — **factory's `tokens.css` was ahead of its generator.** `generate-tokens-css.ts --check` reported it stale: `--nds-warning-border` and the dark tone/link roles existed only in the CSS. Ported into factory's `css-vars.ts` and regenerated; `--nds-pill-neutral-fg` converged from `#6b7480` to web's `var(--nds-text-2)` — apps/factory/src/design-system/tokens/css-vars.ts
- OPEN — **the 37 grid pins in `shared-shell.css` are pasted, not generated.** They are the `.dark` grid block of `tokens.css` copied in by hand. `check-shell-pin-fresh` catches a pin that goes STALE or MISSING, so nothing can ship wrong — but every change to `tokens/grid.ts` costs a manual paste. A `tokens:gen` that also writes that block would close the step — apps/web/src/app/_shared/shared-shell.css

## GDS Phase 2 · 2026-08-29 · the grid folder, the cell library, the hosts

- ✅ RESOLVED (GDS-2) — **the DS grid imported the Tailwind kit it retires.** `Thumbnail`, `DensityContext` and the `Density` type came from `app/_shared/grid-lens`; `Thumbnail` is now `design-system/components/Thumbnail` (both apps, `.nds-thumb-*`) and density is `grid/hooks/useGridDensity` — apps/web/src/design-system/components/Thumbnail.tsx
- ✅ RESOLVED (GDS-2) — **16 of 71 DataGrid sites rendered `null` as blank because the DS had no cell that knew the difference.** `grid/renderers` — every numeric/date/status cell goes through `formatGridValue`, tested per kind: null → muted dash, no title; measured zero → dash WITH a title, or the literal — apps/web/src/design-system/grid/renderers/format.ts
- ✅ RESOLVED (GDS-2) — **a per-cell server round-trip had no DS expression** (the ads bid/budget cells need saving → saved | refused, a refusal staying visible). `CellSaveTracker` + `roundTripClassRules` + `saveCell`, tokens `--nds-grid-saving-bg` / `--nds-grid-refused-*` — apps/web/src/design-system/grid/editors/roundTrip.ts
- 🔴 CAUGHT (GDS-2) — **the cell library's first class namespace collided with the retiring DataGrid's.** `.nds-grid-empty` already exists in `components.css` (the `<table>` grid's 40px empty state), so a `.nds-grid-empty` dash span would have inherited 40px of padding. The library is `.nds-cell-*`; the boundary guard scopes `.nds-grid-*` to the GDS hosts only. A new namespace must be grepped against ALL FOUR DS sheets first — apps/web/src/design-system/grid/theme/grid.css
- OPEN — **`GridSheet` (Q15) is not built yet.** The flat-file rebuild needs the one page-level bounded, virtualised host; it comes with that page — docs/2026-08-28-grid-design-system-gds.md Q15

## GDS Phase 3 · 2026-08-29 · the lab measured what the pages had by hand

- ✅ RESOLVED (GDS-3) — **a pinned totals row drew at the DATA row's height on every grid but the inventory editor.** The editor carried a private `getRowHeight`; the reporting and tab-panel scenarios did not, so their totals row was 49px beside a 46px header. The engine now supplies the pinned-row height (= the header's) unless a page brings its own — apps/web/src/design-system/grid/NexusGrid.tsx
- ✅ RESOLVED (GDS-3) — **AG does not re-read a changed `getRowHeight`.** Switching Spacious → Compact left the totals row at 46px: row heights are cached, and pinned rows are measured only when their data is set. The engine calls `resetRowHeights()` and re-sets pinned data when the tier changes — the products page had been doing the first half by hand — apps/web/src/design-system/grid/NexusGrid.tsx
- OPEN — **the `/design` style-guide page (`app/design/page.tsx`) is a Tailwind demo of `components/ui/*`**, not the DS catalog; the DS catalog is `/design-system`. Two style guides for one product; the GDS section went into the DS one — apps/web/src/app/design/page.tsx
- ✅ RESOLVED (CX.2) — **`Stat` (settings/channels detail) → no description-list / key-value primitive in the DS; fourth local spelling of a `<dl>` (term 11px uppercase, value 13px)** — apps/web/src/app/settings/channels/[type]/ChannelDetailClient.tsx:626 → added `KeyValue`
- `.nds-btn[aria-disabled="true"]` → the DS styled `:disabled` only; a HELD button (aria-disabled, focusable so it can state its reason — check-silent-disabled) rendered indistinguishable from a live one — apps/web/src/app/settings/channels/[type]/ChannelDetailClient.tsx (Reconnect/Disconnect holds) → added the held rule to primitives.css (CX.2)

## TB Top bar · 2026-08-31 · the DS has no "on chrome" surface

- 🔴 OPEN — **no DS control has a variant for sitting on dark chrome.** The bar and rail became one dark surface (operator, 2026-08-31), and every DS primitive placed on it is styled for a LIGHT ground: `.nds-field` stayed white, `AccountSwitcher`'s trigger rendered a white pill and `NotificationsBell`'s a white disc — three bright blobs rather than controls, measured on the prototype before adoption. `app-topbar.css` re-surfaces them via `--nds-chrome-control-*`, scoped to `.nds-topbar`, without forking geometry/radius/focus. The DS answer is a proper `on-chrome` modifier so a control can be dropped on the frame without the consumer restating its surface — apps/web/src/app/_shared/app-topbar.css
- 🔴 OPEN — **`.nds-field`'s placeholder is `--nds-text-disabled`, which is a HINT colour, and fails when the placeholder is the LABEL.** The search field's only visible text is "Jump to anything…", so on the light bar it measured **2.04:1** — the most prominent affordance in the app chrome was its least readable. The DS has no way to say "this placeholder is the label"; the bar pins `--nds-chrome-control-placeholder` (5.51:1) instead — apps/web/src/design-system/styles/primitives.css:356
- ✅ RESOLVED (TB) — **a `var()` alias in a token file cannot follow a scope that redefines its target.** `--nds-topbar-bg: var(--nds-rail-bg)` declared on `:root` resolved the ROOT rail colour and inherited that literal downward, so `.app-rail-host` / `.h10-shell` / `body:has(.h10-shell)` redefining `--nds-rail-bg` never reached the bar: a #f1f3f5 bar against a #f1f4f8 rail. Fixed by making chrome LITERALS (`tokens/chrome.ts`), which also removed the `.dark` re-declaration and the per-shell light pin the aliased version needed — apps/web/src/design-system/tokens/chrome.ts
- ✅ RESOLVED (TB) — **`.nds-tbtn` had a stylesheet but no owner**, so every consumer hand-rolled `<button className="nds-tbtn">` and the raw-primitive ratchet correctly refused two new files. Added `ToolbarButton`, with `label` REQUIRED — it becomes both `aria-label` and the tooltip, because an icon alone names nothing and optional labels are exactly how the sweep found icon buttons at 1.89:1 — apps/web/src/design-system/components/ToolbarButton.tsx
- ✅ RESOLVED (TB) — **no DS expression for "looks like a field, behaves like a button".** The bar needs a search box that delegates to the command palette. Added `SearchTrigger`, which owns the two things that were bugs in the consumer first: `onMouseDown`+preventDefault (a plain click opened the palette, the palette focused its input, then the click's own default focus stole it back — the palette sat open and UNFOCUSED and every keystroke went nowhere), and a placeholder held to body-text contrast because here the placeholder IS the label (the DS's hint role measured 2.04:1) — apps/web/src/design-system/components/SearchTrigger.tsx

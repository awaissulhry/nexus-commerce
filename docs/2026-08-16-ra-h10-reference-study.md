# Rules & Automation — the Helium 10 reference study, and the page-by-page reduction plan

**Date:** 2026-08-16 · **Status:** STUDY + PLAN, awaiting operator approval — nothing under
`/marketing/ads/rules-automation` was changed. · **Scope:** the eleven Rules & Automation pages
(RD page + RD builder excluded by instruction).

**Source of truth:** `~/Desktop/h10 videos/recorded/rules-and-automation.mov` (Helium 10 Ads,
account "UPANI SERVICES", amazon.in, recorded 2026-06-17; 3352×2088, 211.77 s, 12,285 frames,
sped-up), watched frame-by-frame — see §0 for exactly how — plus the Helium 10 help-centre research
in §5 and the section inventory of our own pages in §6.

---

## 0. How the video was watched (so the claims below are checkable)

1. Every one of the 12,285 frames was decoded (`ffmpeg -fps_mode passthrough`) at 838 px (for
   change detection) and 1676 px (readable text).
2. A per-frame change signal was computed (fraction of pixels changed vs the previous frame at two
   thresholds, plus a vertical-scroll estimate). Result: 5,980 frames identical to their predecessor,
   4,471 cursor-only frames, 1,911 frames of real change inside 181 change-runs (navigation, scroll,
   dropdown, typing), 31 sub-threshold hover events.
3. **899 keyframes** were selected: the settled state before and after EVERY change-run, every 4th
   frame INSIDE every run (peak scroll speed is ~5 % of the viewport per frame, so no content can
   pass between samples), plus the 31 hover events. That is every screen state the recording
   contains.
4. The keyframes were rendered as 450 legible 2-up sheets and read in order by ten parallel
   readers (forks of this session), each writing a verbatim per-keyframe narrative with the URL bar,
   layout, every label/column/button/option and the interaction — zooming to full source resolution
   wherever text was small (`crop.py`, 21 zooms). Narratives: `narr_00.md … narr_09.md`
   (4,071 lines) in the session scratchpad; the decisive frames (selection toolbar + Automation
   popover, the Bid criteria card, the harvest mapping table, the Negative grid, the SOV grid, the
   Keyword-Tracker builder) were then re-viewed directly and matched the narratives exactly.
5. Not in the recording (and therefore not claimed): the Share-of-Voice builder and the
   Negative-Targeting builder were never opened; no dropdown option list was opened except
   "Metric 1" of the schedule editor and the three Ad-Group-View filters; the Keyword Harvest
   **Ad Group View grid never finished loading** (its columns are unknown); the Placement builder's
   THEN dropdown lists were not opened; "Learn", "Apply Template", "Save Template", "+ Assign Rule",
   "Target ACoS", "Min/Max Bid" popovers were never opened.

## 1. Timeline of the recording

| t (s) | frames | URL slug (`…/panel/1547747787/`) | what is on screen |
|---|---|---|---|
| 0.0–1.5 | 0–86 | `campaigns` | Ad Manager campaigns grid (Bid Rule · Target ACoS · Min/Max Bid · Bid Automation · Min/Max Budget · Rules ⚙ · Bidding Strategy; toolbar has **+ Create Rule**); left rail expands: Account Overview · Dashboard · Budget Manager · AI Advertising · Suggestions · Analytics · Ad Manager · **Rules & Automation** · AMC ▸ · Reporting ▸ · Change Log · Training & Resources · Settings |
| 1.5–4.8 | 86–282 | `rules-automation/bid` | click "Rules & Automation" → **lands on the Bid tab** (skeleton → 0 rules) |
| 4.8–26.1 | 282–1512 | `rules-automation/AI-bid` | **Apply Rules** tab: Filters (collapsed) + campaign grid; select row → toolbar [Automation] [+ Assign Rule] [Target ACoS] [Min/Max Bid]; Automation popover On/Off → Apply → toast "✓ Bid Automation Turned On"; expand Filters; scroll to bottom (nothing below the grid) |
| 26.1–44.3 | 1516–2570 | `rules-automation/bid` | **Bid** tab (one empty rules grid) → "Create Rule" → **Create Rule - Bid** builder, scrolled end-to-end, add 1 campaign, Control → Automate, Cancel (no confirm) |
| 44.3–75.9 | 2570–4402 | `rules-automation/keyword` | **Keyword Harvest**: pill "Rules View \| Ad Group View"; Rules View = grid with 3 rules; Ad Group View = Filters (Source Campaign · Destination Campaign · Harvest Rule) + a grid that stays a skeleton for ~17 s; back to Rules View |
| 75.9–83.0 | 4403–4808 | `rules-automation/keyword` | "+ Rule" on the grid → **Create Rule - Keyword Harvesting** builder, scrolled end-to-end, Cancel |
| 83.0–86.0 | 4809–4984 | `rules-automation/keyword` | Rules View again; Ad Group View again (skeleton) |
| 86.0–90.7 | 4984–5258 | `rules-automation/negative` | **Negative Targeting**: one grid, 2 rules ("Sales=0, Clicks>=…", Daily 06:00 AM); hover shows Open + pencils |
| 90.7–99.4 | 5258–5766 | `rules-automation/budget-rules` | **Budget**: one grid, 0 rules → "+ Rule" → **Create Rule - Budget** builder end-to-end → × |
| 101.2–104.6 | 5869–6066 | `rules-automation/schedule-rule` | **Dayparting Schedules**: "Hourly Campaign Performance" card + "Showing 0 Schedules" grid |
| 104.6–159.5 | 6067–9253 | `rules-automation/schedule-rule` | **Create Dayparting Schedule** builder: Add All (20), Portfolios/Products picker tabs, criteria card (Metric 1 dropdown opened; chart↔table; heat-table tooltips), Never Expire toggled off/on, Cancel |
| 159.5–164.4 | 9254–9536 | `rules-automation/schedule-rule` | Dayparting Schedules tab re-fetch |
| 164.4–178.2 | 9536–10339 | `rules-automation/budget-schedule` | **Budget Schedules** tab (same two sections, wider grid) → "+ Rule" → **Create Budget Schedule** builder end-to-end → × |
| 178.2–197.3 | 10339–11443 | `rules-automation/placement` | **Placement**: one grid, 0 rules → **Create Rule - Placement** builder end-to-end (Control → Automate) → × |
| 198.2–199.7 | 11498–11586 | `rules-automation/sov` | **Share of Voice**: one grid, 0 rules (extra column "SOV Reports") |
| 199.7–211.8 | 11587–12284 | `rules-automation/keyword-tracker` | **Keyword Tracker**: one grid, 0 rules → **Create Rule - Keyword Tracker** builder end-to-end → ×; recording stops |

## 2. Anatomy of the H10 section — what is constant

- **Page shell:** eyebrow "Helium 10 Ads" · H1 "Rules & Automation" · subtitle "Create and manage
  rules for all of your campaigns" · top-right: [Learn] (per-tab video pill; absent on Apply Rules
  and Budget) · [↗ Share Feedback] · account/marketplace picker · **[+ Rule]** (primary; opens the
  builder for the ACTIVE tab's type — no type chooser was ever shown).
- **Tab bar — 10 tabs, this order:** Apply Rules · Bid · Keyword Harvest · Negative Targeting ·
  Budget · Dayparting Schedules · Budget Schedules · Placement · Share of Voice · Keyword Tracker.
  Slugs: `AI-bid` · `bid` · `keyword` · `negative` · `budget-rules` · `schedule-rule` ·
  `budget-schedule` · `placement` · `sov` · `keyword-tracker`. Entering the section from the rail
  lands on **Bid**.
- **Every rule-type tab is ONE card**, nothing above or below it (the site footer follows
  immediately):
  - card header: "Showing 0 <Type> rules" / "Viewing 1-N of N <Type> Rules" + 🔍 · right **[+ Rule]**
  - columns: ☐ · (⋮ kebab where rows exist) · "<Type> Rule ⇅" · "Automation" (toggle; on = Automate,
    off = Manual) · "Criteria" (one-line summary, truncated with …) · "Frequency" (two lines: "Daily"
    / "06:00 AM"); Share of Voice adds "SOV Reports"
  - row hover: "↗ Open" beside the name; on Keyword Harvest and Negative Targeting also ✎ pencils on
    the Criteria and Frequency cells
  - empty state: illustration + "Create a <Type> Rule to generate suggestions for a campaign!" +
    outlined [Create Rule] (SOV: "Create a rule to generate campaign suggestions"; KT: "Create a
    Keyword Tracker Rule to generate campaign suggestions")
  - footer: pager "‹ 1 ›" · "Rows per page: 100 ▾"
  - **no filters, no KPI chips, no charts, no census, no drawers, no activity feed** on any of Bid ·
    Negative Targeting · Budget · Placement · Share of Voice · Keyword Tracker.
- **The builder is a full-screen overlay** (URL does not change), header × · icon · "Create Rule -
  <Type>" · [Learn] · [Create Rule] (disabled until valid); left scroll-spy step nav; footer
  "Cancel" · "Save Template" · "Create Rule". Cancel/× close with no confirmation.
- **Loading pattern:** blue progress bar → (transient "No data"/empty flash) → skeleton grid → data.
  Every tab re-fetches after a builder closes.

## 3. Per-tab reference (verbatim)

### 3.1 Apply Rules (`AI-bid`) — TWO sections
1. **"Filters" card**, collapsed by default ("⌄ Show Filters" / "⌃ Hide Filters"). Row 1:
   Portfolio [Select a Portfolio ▾] · Campaign [Select a Campaign ▾] · Campaign Type [5 selected ▾].
   Row 2: Status [2 selected ▾] · Bid Automation [All ▾]. Footer right [Clear]. Filters apply live —
   no Apply button.
2. **Campaign grid** "Viewing 1-20 of 20 Campaigns" 🔍. Columns: ☐ · **Campaign ⇅** (frozen: [M]/[A]
   badge · SP chip · name → `/campaigns/<id>/details`) · **Bid Rule** ("⧖ Target ACOS") · **Target
   ACoS** ("30.00%") · **Min/Max Bid** ("None") · **Bid Automation** (toggle) · **Budget Rule**
   ("None"). Row hover: [↗ Open] + ✎ on Bid Rule / Target ACoS / Min/Max Bid / Budget Rule.
   With a selection the toolbar becomes **"Selected N Campaign" [Automation] [+ Assign Rule]
   [Target ACoS] [Min/Max Bid]** 🔍. [Automation] popover: "Automation" · ◉ On / ○ Off · Cancel ·
   [✓ Apply] → toast "✓ Bid Automation Turned On", grid reloads, toggle persisted. Sticky column
   header while scrolling; floating pager. Nothing below the grid.

### 3.2 Bid (`bid`) — ONE section: the rules grid ("Showing 0 Bid rules"; Bid Rule ⇅ · Automation ·
Criteria · Frequency; "Create a Bid Rule to generate suggestions for a campaign!").

### 3.3 Keyword Harvest (`keyword`) — a pill toggle + ONE card
- Segmented pill directly under the tab bar: **"Rules View" | "Ad Group View"** (no URL change).
- **Rules View:** grid "Viewing 1-3 of 3 Keyword Harvest Rules" 🔍 · [+ Rule]; columns ☐ · ⋮ ·
  Keyword Harvest Rule ⇅ · Automation · Criteria · Frequency. Rows: "Guided campaign Promotion"
  (off · "PPC Orders>=1, S…" · Daily 06:00 AM) · "keyword harvesting" (on · "PPC Orders>=1, P…" ·
  Daily 12:00 AM) · "test - Auto - Promotion" (on · "PPC Orders>=2, S…" · Daily 06:00 AM).
- **Ad Group View:** "Filters" card ("⌃ Hide Filters"): **Source Campaign** [Select a Campaign ▾] ·
  **Destination Campaign** [Select a Campaign ▾] · **Harvest Rule** [Select a Rule ▾] · [Clear] —
  each a searchable checkbox multi-select whose choices render as removable chips; the campaign
  lists offer only 8 campaigns (the Auto/Performance/Product Target/Research ones — i.e. eligible
  harvest sources/destinations), the rule list offers the 3 harvest rules. Below: a wide grid
  (frozen left block of 3 columns + right block of 4, horizontal scrollbar, three toolbar buttons
  top-right) that **never loaded** in the recording.

### 3.4 Negative Targeting (`negative`) — ONE section: the rules grid ("Viewing 1-2 of 2 Negative
Targeting Rules"; rows "Guided campaign Negative" off · "Sales=0, Clicks>=…" · Daily 06:00 AM and
"test - Auto - Negative" on · same). No pill, no filters.

### 3.5 Budget (`budget-rules`) — ONE section: the rules grid ("Showing 0 Budget Rules"; "Create a
Budget Rule to generate suggestions for a campaign!"). No filters, no chips, no campaign grid, no
baseline tool.

### 3.6 Dayparting Schedules (`schedule-rule`) — ONE card in two parts
1. **"Hourly Campaign Performance" ⓘ** — metric selects [● Spend ▾] (left) and [● ACoS ▾] (right);
   body: illustration + **"Hourly data is not available for this marketplace."** (amazon.in).
2. **Schedules grid** "Showing 0 Schedules" 🔍 · right: 👁‍🗨 (eye-slash) · [+ Rule]; columns
   **Schedule Name · Adjustments · Days · Start Date ⇅ (default sort) · End Date ⇅**; empty
   "No schedules created"; pager · Rows per page 100.

### 3.7 Budget Schedules (`budget-schedule`) — the SAME two parts; grid columns **Budget Schedule
Name · Type · Days · Auto Refill · Start Date ⇅ · End Date ⇅ · Exclude Start Date · Exclude End
Date** (+ a trailing row-action column).

### 3.8 Placement (`placement`) — ONE section: the rules grid ("Showing 0 Placement Rules").
### 3.9 Share of Voice (`sov`) — ONE section: the rules grid ("Showing 0 rules"; **SOV Rule ⇅ ·
Automation · Criteria · Frequency · SOV Reports**; horizontally scrollable).
### 3.10 Keyword Tracker (`keyword-tracker`) — ONE section: the rules grid ("Showing 0 Keyword
Tracker rules"; Keyword Tracker Rule ⇅ · Automation · Criteria · Frequency).

## 4. The builders (verbatim)

### 4.1 The shared shape (Bid · Budget · Placement · Keyword Tracker; Keyword Harvesting differs)
Steps: **Rule Name · <Type> Rule Setup · Criteria · Advanced Settings · Control**.
- **Rule Name** — input "Enter a rule name".
- **Setup = the campaign picker** ("Campaigns" — "Select the Campaigns you want to include"):
  LEFT: 🔍 · "Campaign Status: ○ All ◉ Enabled ○ Paused" · [Add All] · rows `[A|M] [SP] name ·
  Enabled · [+ Add]` (Add disables once added; rows stay listed) · pager · page size 50.
  RIGHT: "N Campaigns Added" · [🗑 Remove All] · column "Campaign" · rows with × · empty "No
  Campaigns Added". (Keyword Tracker replaces this with an **ASIN picker** — §4.3.)
- **Criteria** — "Set up the performance criteria and actions" · right [⊕ Apply Template].
  Card "Criteria 1" (⧉ duplicate · 🗑 delete; drag handle on hover):
  `IF [metric ▾] [operator ▾] [value]` ✕ · "+ AND" · `THEN [action ▾] [value]` · then
  **"+ Criteria"** adds another whole block (each block = its own IF…THEN).
  Defaults per type:
  | type | IF | THEN | lookback |
  |---|---|---|---|
  | Bid | ACOS · Greater than > · __ % | **Set Bid to($)** ₹__ ⓘ | inside the criteria card: "Lookback period * ⓘ [Last 60 Days ▾] Exclude [Last 3 Days ▾]" |
  | Budget | ACOS · Greater than > · __ % | **Set Daily Budget to($)** ₹__ | in Advanced Settings: "Lookback period — Set the time range of the data used to trigger this rule — Last 60 Days · Exclude Last 3 Days" |
  | Placement | **Campaign ▾** · ACOS · Greater than > · __ % | **Top of Search ▾ · Set to ▾ · __ %** | in Advanced Settings (as Budget) |
  | Keyword Tracker | **Keyword Tracker ▾ · Organic Rank ▾ · Average Position ▾ in the Last [3 ▾] Days** · Greater than > · __ | **Set targeting Bid to($)** ₹__ ⓘ; plus required "**If Your Product Has No Rank** *ⓘ": ◉ "Count it as position 306(Organic Rank) or 96(Sponsored Rank) — Data points with no rank are treated as the lowest position in the Calculation" / ○ "Ignore them — Only data points where your product had a rank are used in the calculation" | none |
- **Advanced Settings** — "Frequency — Set how often the rule should check the criteria —
  [Daily ▾] at [12:00 AM (00:00) ▾]" · "Timezone — Select the timezone for this rule —
  [PST/PDT - Pacific Standard/Daylight Time, Los Angeles ▾]" (+ Lookback for Budget/Placement).
- **Control** — "Determine the level of control over the actions of this rule":
  **◉ Manual — "Manually approve rule actions on the Suggestions page"** (default) ·
  **○ Automate — "Automate this rule to have Helium 10 Ads automatically apply rule actions"**.
- Footer: Cancel · Save Template (disabled until valid) · Create Rule (disabled until valid).
  The Budget builder's step nav marks incomplete steps orange.

### 4.2 Keyword Harvesting builder (the one that differs)
Steps: **Rule Name · Positive Rule Setup · Criteria · Search Terms · Advanced Settings · Control**.
- **Positive Rule Setup** (right: [+ Ad Group Mapping] · collapse ⌄). Helper: "Add related Ad
  Groups in any order and select which ones you'd like Helium 10 Ads to use to find converting
  search terms/ASINs. For each Ad Group, you can then decide which type of target you want to
  create when it finds a converting search term/ASIN." Banner: "Helium 10 Ads is checking for
  search terms that hit the specified criteria per ad group, and not aggregating performance
  metrics across all selected ad groups". Card "0 Ad Groups" · [+ Ad Group]. Table header groups:
  **"What Ad Groups would you like included in this rule?"** → "Ad Group" | "Look for Search Terms
  in These Ad Groups ⓘ"; **"What targets would you like created? ⓘ"** → "Create New Targets ⓘ"
  [B · P · E · ASIN] | "Create New Negative Targets" [P · E · ASIN, red]. Empty states "Add an Ad
  Group / Start by adding related ad groups to this rule" and "Create a New Target / Select the
  type of target you want to create with the search term".
- **Criteria**: `IF [PPC Orders] [Greater than or equal to >=] [1]` · + AND · "Lookback period *
  [Last 60 Days] Exclude [Last 3 Days]" · [+ Criteria] · `THEN Create new target in selected ad
  groups and set the starting bid to [Current CPC ▾]`.
- **Search Term** — "Isolate specific search terms using the "contains" or "does not contain"
  operator." · "Only suggest if search term:" ◉ Contains ○ Does Not Contain · textarea "Enter or
  paste search terms here" · [Add Search Terms] · right card "0 Search Terms Added" · [🗑 Remove
  All] · columns Search Term | Operator.
- **Advanced Settings** (Frequency · Timezone) · **Control**: toggle ON "Select to NOT suggest any
  search terms that already exist with the same match type in the campaigns from this rule group"
  + Manual/Automate. Footer: Cancel · Create Rule (no Save Template on this type).

### 4.3 Keyword Tracker builder — Setup = **ASIN**
"ASIN — Select the product you are using in your keyword tracker" · [⟳ Refresh List] · [+ Create
New Keyword Tracker]. LEFT: marketplace chip "a 🇮🇳 www.amazon.in" · Search · "Viewing 1 ASINs ⓘ" ·
[Add All] · row: thumbnail · title · ASIN B07NL9QMP7 ⧉ · [+ Add] · pager · Rows per page 25.
RIGHT: "Added ASINs (0)" · [🗑 Remove All] · column ASIN · "No ASINs added yet". Then Criteria as
in §4.1, Advanced Settings, Control.

### 4.4 Create Dayparting Schedule (from the Dayparting Schedules tab; **reference only — RD is
untouchable**)
Steps: Schedule Name · Timezone · Campaign Section · Criteria · Advanced Settings.
"Dayparting Schedule Name" (Enter schedule name) · "Timezone — Select the timezone for this
schedule." [Select Timezone ▾] (empty by default) · "Campaigns Section — Select the Campaigns and
products you want to include" with info banner "If you pause a campaign within a schedule, it
removes it from the schedule, and enabling a campaign that is paused via a schedule will add it
back to the paused state based on your schedule." and picker sub-tabs **All Campaigns · Portfolios
· Products** (Products rows: thumb · title · SKU ⧉ · [+ Add All]) · "Campaign Status: ◉ Enabled" ·
[Add All] → "20 Campaigns Added". "**Dayparting Schedule Criteria** ⏱ –" — "Setup a schedule for
campaign status and define the time periods and criteria when this schedule will be active.":
Metric 1 [● Spend] · Metric 2 [● ACoS] · [chart | table] · Period ⓘ [04/18/2026 - 06/16/2026] ·
Group By ⓘ [Hour of Day] · Days of Week Included [All Days] · chart (or, in table mode, a MON–SUN ×
12AM…11PM heat-table with legend ">₹0 >₹1 … >₹5" and cell tooltip "Saturday, 04:00 AM / Spend ₹0")
· then the editor table ☐ · Days · Time Period · Actions with rows MON…SUN each "Select time ▾ –
Select time ▾ · Select adjustment type ▾ · + ⧉ 🗑". Advanced Settings › "Schedule Start & End Date
— Set the start and end date for this schedule.": Start Date * ⓘ [06/17/2026] · End Date ⓘ [Enter a
Date] (disabled) · toggle **Never Expire** ON (off → End Date becomes required). Footer Cancel ·
Create Schedule. Metric 1 options seen: Clicks · Spend · PPC Orders · Impressions · Sales · ACoS ·
ROAS · CPC · … .

### 4.5 Create Budget Schedule (from the Budget Schedules tab)
Steps: Schedule Name · Campaign Section · Budget Schedule · Advanced Settings.
"Budget Schedule Name" (Enter a budget schedule name) · Campaigns Section (same picker; here
"Campaign Status: ◉ All ○ Enabled ○ Paused" and SD/paused campaigns are listed) ·
"**Budget Schedule** — Select the type of budget schedule you want to create and then set up the
hourly/daily adjustments.": ◉ **Campaign Budget — Set up an hourly schedule to adjust your
campaign's budget** / ○ **Budget Multiplier — Set up a daily schedule to adjust your campaign's
budget multiplier** · the same Metric/Period/Group By/Days editor + MON–SUN table · Advanced
Settings: Start Date * [06/17/2026] · End Date · **Never Expire** ON · **Exclude Dates** OFF.
Footer Cancel · Create Schedule.

### 4.6 The rule lifecycle H10 implies (from the UI itself)
Rules grid (per type) → [+ Rule] → builder (criteria · frequency · action · **Control**) →
Manual rules surface their actions on the **Suggestions** page for approval; Automate rules apply
them; the **Apply Rules** tab shows, per campaign, which Bid Rule / Budget Rule is attached, the
Target ACoS, Min/Max Bid and the Bid Automation switch, and lets you assign rules in bulk;
**Analytics** and **Reporting** are separate rail items. Nothing analytical lives on the rules tabs.

## 5. How Helium 10 says it works (help-centre + app-bundle research)

Sources: the 35 Zendesk KB articles of the "Helium 10 Ads" section (pulled via the KB's JSON API),
Wayback copies of the retired release-notes page, and — the decisive one — the **public JS bundle of
`advertising.helium10.com`**, whose English UI dictionary and rule-builder option tables were read
verbatim. (Adtomic was renamed "Helium 10 Ads" in Feb 2025; the backend is Pacvue.) Everything below
is verbatim UI text or a KB sentence; it agrees with §§2–4 wherever both cover the same thing.

### 5.1 The section, confirmed
- Tabs and routes, in order: Apply Rules `/AI-bid` · Bid `/bid` · Keyword Harvest `/keyword` ·
  Negative Targeting `/negative` · Budget `/budget-rules` · Dayparting Schedules `/schedule-rule` ·
  Budget Schedules `/budget-schedule` · Placement `/placement` · Share of Voice `/sov` · Keyword
  Tracker `/keyword-tracker` (the last four are hidden for Walmart profiles). Release notes: Budget
  Schedules joined the page 2024-07-08; Dayparting Schedules were MOVED onto it 2024-11-25 (they used
  to be a rail item) — which is why both schedule tabs share the "Hourly Campaign Performance" card.
- Rule types and their one-line descriptions ("Select a Rule Type"): **Bid** — "Adjust the bid of
  keywords in selected campaigns based on keyword performance" · **Keyword Harvesting** — "Find
  converting search terms for creating new targets" · **Negative Targeting** — "Find poor performing
  search terms and create new negative targets" · **Budget** — "Adjust the daily budget of selected
  campaigns based on campaign performance" · **Budget Schedule** — "Create a budget campaign schedule
  based on hourly performance data" · **Dayparting Schedule** — "Create a dayparting campaign
  schedule based on hourly performance data" · **Placement** — "Adjust the placement value of the SP
  campaigns based on placement performance" · **SOV** — "Create a keyword bid adjustment rule based
  on the SOV report." · **Keyword Tracker** — "Adjust keyword bids based on the product's organic
  and paid rankings in the keyword tracker."
- KB: "The Helium 10 Ads Rules & Automation page allows you to review Bid Automations, Keyword
  Harvest Rules, Negative Targeting Rules, and Budget Rules … You also have the ability to create new
  … rules on this page." — i.e. the page is create / review / assign; nothing else.

### 5.2 The rules grids and the builder skeleton (all types)
- List columns: [edit/delete] · "<Type> Rule" (hover "Open") · "Automation" (toggle) · "Criteria"
  (summary; "Edit Criteria") · "Frequency" (inline-editable: Time / Day of Week / Day of Month) ·
  (SOV only) "SOV Reports". Bulk "Delete Rules". Empty states as in §2 (Positive/Negative variants:
  "Create a Positive Keyword Rule …", "Create a Negative Keyword Rule …").
- Operators: Greater than > · Greater than or equal to >= · Less than < · Less than or equal to <= ·
  Equal to =.
- Lookback ("Set the time range of the data used to trigger this rule's criteria. If multiple
  criteria are set, it is recommended that the requirements or actions be different to prevent
  conflicts."): Previous Day · Last 2/3/4/5/6/7 Days · Last 14 · 30 · 60 · 90 Days; Exclude: Today ·
  Last 2 · 3 · 4 Days. Bid rules carry it per criteria block; Budget/Placement carry ONE in Advanced
  Settings. Code default 60 / Last 3 Days.
- Frequency: Daily · Every 2/3/4/5/6 days · Weekly (on Mon…Sun) · 2 Weeks · Monthly (on the 1–30
  day) · Custom (Every N Weeks|Days) — "at" 12:00 AM (00:00) … 11:00 PM (23:00). Default Daily,
  hour 0. Timezones: PST/PDT Los Angeles (default) · EST/EDT New York · CST/CDT Chicago · CET
  Berlin/Paris · GMT London · CST Beijing · JST Tokyo · AEST Canberra/Sydney · GST Dubai · MST · IST.
- Control: "Manual — Manually approve rule actions on the Suggestions page" / "Automate — Automate
  this rule to have Helium 10 Ads automatically apply rule actions" (code default manual).
- Templates: "Save Template" / "Apply Template" → "Select Template" (Bid Templates · Budget
  Templates · Favorites · Saved Templates · "Helium 10 Ads Default"); the newer "Templates and
  Tactics" flow ("Template Library — a group of tactics … apply one to build the whole rule at once";
  "Tactic Library — a single building block of a rule — the criteria and action for one job").
- **Precedence** (release note 2024-06-20): "Order does not affect precedence. If multiple criteria
  are met and the change is in the same direction, a greater change will be suggested or applied …
  If … not in the same direction, no suggestion will be made or automatically applied."
- **Exclusivity:** "A campaign can only be in one bid rule at a time" (same for budget, placement,
  SOV, Keyword Tracker; harvest/negative: "If added to this new rule, it will be removed from its
  current association"); schedules: "Settings for the most recently created schedule will apply if
  there are any time or state conflicts." Paused campaigns can be added but do nothing until
  reactivated; "Automation is not available for Auto campaigns" (bid algorithms).
- Runs nightly (PST); Automate output → Change Log ("Automatically in Helium 10 Ads"); Manual output
  → Suggestions ("Semi-auto in Helium 10 Ads" once approved).

### 5.3 Per type — metrics, actions, setup
- **Bid** — metrics ACOS · ROAS · Clicks · Current Bid · Impressions · CVR · CTR · CPC · PPC Orders ·
  Spend · Sales · Inventory (sellers). Actions: Set Bid to($) · Increase Bid($/%) · Decrease Bid($/%)
  · Revenue per Click · Set to CPC · "CPC * Target ACOS / ACOS" · "Current Bid * Target ACOS / ACOS"
  · Enable Targeting · Pause Targeting; guardrails "Set Min Bid" / "Set Max Bid" (+ "Enforce
  Maximum"). Acts on the targets inside the selected campaigns. Suggestions → "Bids".
- **Keyword Harvesting** — Setup = the ad-group mapping (§4.2); per ad group: "Look for Search
  Terms in These Ad Groups" (input) · "Create New Targets" (Broad · Phrase · Exact · ASIN) · "Create
  New Negative Targets" (Negative Exact · Negative Phrase · Negative ASIN — "search term isolation
  … optional"). Metrics: ACOS · ROAS · Clicks · Impressions · CVR · CTR · CPC · PPC Orders · Spend ·
  Sales; default "PPC Orders >= 1"; THEN "Create new target in selected ad groups and set the
  starting bid to" Set to Current CPC · Set to Ad Group Default · Set Custom Bid · Set to Current CPC
  + %. Control extra: "Select to NOT suggest any search terms that already exist with the same match
  type in the campaigns from this rule group". Suggestions → "New Keywords".
  **Ad Group View** (the grid the recording never loaded) — filters Source Campaign · Destination
  Campaign · Harvest Rule; **columns "Ad group Type" · "Ad Group" · "Campaign" · "Of Target" ·
  "Harvest Rule" · "Keyword BPE" (B/P/E/ASIN) · "Negative Keyword" (P/E) · "Negative Targets"
  (ASIN)**; expandable rows source ad group → destination ad groups; empty "There are no rules
  currently. Please create a rule."
- **Negative Targeting** — Setup = "Negative Rule Setup" (same mapping table; outputs Negative Exact
  · Negative Phrase · Negative ASIN); "Use Helium 10 Ads's Algorithm" toggle vs fixed "Click
  Threshold" / "Spend Threshold"; generic criteria same metric list; default "Sales = 0 AND Clicks >=
  20"; THEN "Create new negative target in selected ad groups". Applied at ad-group level.
  Suggestions → "Negative Keywords".
- **Budget** — metrics Budget Utilization ("Average Budget Utilization: Spend in the selected period /
  Sum(daily budget …) * 100%") · ACOS · ROAS · Clicks · Impressions · CVR · CTR · CPC · PPC Orders ·
  Spend · Sales. Actions: Set Daily Budget to($) · Increase Daily Budget($/%) · Decrease Daily
  Budget($/%); guardrails Set Min/Max Budget. Suggestions → "Budget" (Campaign · Date Added · Rule ·
  Current Budget · Suggested Budget). Distinct from **Budget Manager** (profile-level monthly pacing,
  "Auto Pacing", "Stop Over Spend"; "only impacts budget allocation, not bidding") and from Budget
  Schedules.
- **Placement** — IF [Campaign | Top of Search | Rest of Search | Product Pages] [ACOS · ROAS ·
  Clicks · Impressions · CVR · CTR · CPC · Spend · Sales] [op] [value]; THEN [Top of Search | Rest of
  Search | Product Pages] [Set to | Raise | Reduce] [%] with Floor/Cap (max 900). Suggestions →
  "Placement" (Placement · Campaign · Suggested Change · Date Added · Rule · Reason · ROAS…).
- **SOV** — Setup: "Report — Select the reports you want to reference data for" (an SOV report made
  under Reporting; up to 20 per account) · "ASIN — Select the product you are using in your SP
  campaign" · "Keyword — Select the corresponding keyword from the SOV report" · "Campaigns Section —
  … which are using the selected product". Criteria: first group must be **ASIN SOV** (Avg.Position ·
  Avg.Organic Position · Avg.Paid Position · Page 1 Frequency % · Top 3 Frequency %) with "SOV Data
  Lookback period"; further ANDs may be **Keyword Performance** (bid-rule metrics) with "Keyword Data
  Lookback period"; THEN Set/Increase/Decrease targeting Bid($/%) · Enable/Pause Targeting; min/max
  bid. Grid column "SOV Reports" = the report(s) the rule reads ("Because the SOV report has been
  deleted, this rule will no longer take effect.").
- **Keyword Tracker** (KB 2026-04) — Setup: ASINs from Keyword Tracker (child ASINs only; "+ Create
  New Keyword Tracker") · Keywords ("only keywords tracked in Keyword Tracker") · Campaigns ("only
  campaigns containing a single ASIN are eligible"). Criteria: [Keyword Tracker] [Organic Rank |
  Sponsored Rank] [Average Position | Median Position | Consecutive Checks] in the Last [3|5|7|10]
  Days [op] [value] AND optional [Keyword Performance] metrics; "If Your Product Has No Rank"
  (306/96 vs ignore); THEN Increase/Decrease/Set targeting bid · Enable/Pause; "Rules only run when
  sufficient Keyword Tracker data is available". Marketing name "Keyword Rank Rules".
- **Budget Schedules** — types **Campaign Budget** (hourly: per-day intervals "Increase Budget By /
  Decrease Budget By / Set budget to") and **Budget Multiplier** (daily: "On Weekdays / On Weekends"
  multipliers) plus **"Budget Auto-Refill Criteria — Set up automatic budget increases for campaigns
  that have exhausted their budget based on real-time data"** ("If selected campaigns run out of
  budget … Increase Daily Budget … Max"; daily-multiplier schedules only → the "Auto Refill" column).
  Advanced: Start/End (Never Expire) · Exclude Dates · Timezone.
- **Dayparting Schedules** — adjustment types: Pause Campaign · Increase Bid (by %) · Decrease Bid ·
  Increase Budget · Decrease Budget · Set Budget to · Max Bid · Min Bid; "Copy Time Periods to…";
  Never Expire · Exclude Dates · Timezone. (Reference only — RD untouched.)

### 5.4 Apply Rules, Suggestions, Change Log, Analytics — the division of labour
- **Apply Rules** (KB "Bid AI Settings"): "quickly view your Bid AI Settings … Target ACoS, Min/Max
  Bid, Bid Automation … Select the checkbox next to the campaign; Click the button …; Input the value;
  Click Apply." App columns: Campaign · **Bid Algorithm** (algorithm/rule name — "Target ACOS", "Max
  Impressions", "Max Orders", "None", or a custom Bid Rule; "Target Value" %; "Min/Max Bid"; "Bid
  Automation" toggle) · **Budget Rule**. Filters: Campaign Type · Status · Bid Automation. Bulk:
  **"Assign Rule"** (dialog "Rule Type": Bid Rule · Budget Rule · Placement Rule · Dayparting
  Schedule · Budget Schedule → toast "Rule Applied") · Automation · Target ACoS · Max Bid. Bid
  algorithms are H10's own AI (Max Impressions / Target ACoS default 30% / Max Orders / Custom).
  Rules also attach from Ad Manager's "Rules" cog ("Campaign Rules for "{name}"" · Add Rule · Add
  Negative Rule · Remove rule from campaign).
- **Suggestions** — "Review and apply suggestions for bids, new keywords, and negative keywords";
  tabs Recommendation · A.I. Bids · Bids · New Keywords · Negative Keywords · Budget · Placement;
  row actions Approve · Remove until a new one is generated · Pause suggestions for this target;
  bulk "Apply N changes". "Once this Automate button is activated, keyword suggestions will no longer
  appear on the Suggestions page." **This is where a Manual rule's output lives — not on the rules
  tabs.**
- **Change Log** — Change Type (Bid · Budget · Keyword · Negative Keyword · Campaign Status ·
  Placement …) · Change Source ("Automatically in Helium 10 Ads" · "Semi-auto in Helium 10 Ads" ·
  Manually · Seller Central/3rd party) · Change By (Rule · Dayparting Schedule · Budget Schedule ·
  Budget Manager · Recommendation · AI). **This is where an Automate rule's output is audited.**
- **Analytics** — Portfolio · Campaign · Ad Group · Target · Search Term · Product views with bulk
  actions (+ Negative Targets, + Add to Schedule, Target Bid…); "Placement level data … within
  Analytics -> Campaigns" (2024-12-19). **This is where the numbers live.**
- **AI Advertising / Product Goals** are separate and mutually exclusive with rules: "If you've added
  rules to your campaigns while AI Control is OFF, and later … turn AI Control back ON, the campaigns
  will be removed from the rules."

### 5.5 Not found / uncertain (so not claimed)
No KB article exists for Placement or SOV rules (bundle strings only; `hidePlacementRule` /
`hideSovRule` / `hideKeywordTrackerRule` flags exist). Template-library contents unknown. Whether
harvested terms are negated in the source by default: NO — only via "Create New Negative Targets" /
"Search Term Isolation" (default off). "Rank Goal" / "Bid to Rank" do not exist under those names;
the equivalent is the Keyword Tracker rule.

## 6. Our eleven pages against the reference

Inventory of what each of our pages renders today (from a read-only sweep of
`apps/web/src/app/marketing/ads/rules-automation/`, 2026-08-16) set against §3. "Sections" counts
visual blocks the operator sees (filter bars, sentences, censuses, grids, drawers, dialogs, panels).

| tab (ours) | ours today | H10 | delta |
|---|---|---|---|
| Apply Rules | header · tabs · filter bar · resolution sentence · notes · **grain segment [Campaigns \| Portfolios \| Product lines \| Markets]** + search · grid (Delivery · Portfolio · Product line · Managed/Off-limits · **Bid bounds** ✎) · line-grain note · bounds dialog · empty states — 12 blocks, `ApplyRulesClient.tsx` 1,067 lines | Filters + ONE campaign grid (Bid Rule · Target ACoS · Min/Max Bid · Bid Automation · Budget Rule); bulk [Automation] [+ Assign Rule] [Target ACoS] [Min/Max Bid] | **closest to H10 already.** Differences: three extra grains, no Bid Rule / Budget Rule / Bid Automation columns, no bulk verbs, no "+ Assign Rule". |
| Automations | census band · [Actors \| Ledger \| Queue \| Limits] · [All \| Rules \| Engines] · actors grid · rule/engine/history drawers — 16 blocks, 956 lines | **does not exist** (its Queue ≈ H10 "Suggestions"; its Ledger ≈ H10 "Change Log") | our invention; today the *owner* of every rule record (all other tabs link `?rule=` here). |
| Bid | filter bar · bidder band · resolution · **census strip** · notes · targets/campaigns grid · **Bounds section** · **Activity section** · **Staged tray** · target drawer · goal dialog · TabRules (governance table) — 15 blocks, 1,103 lines + 8 files | ONE rules grid | everything but the rules grid is extra; and our "rules" table is a governance table, not H10's Rule · Automation · Criteria · Frequency. |
| Placement | own scope bar · resolution · freshness · **census cells** · **lane split** · "the hour" · notes · refusal alert · campaign×lane grid + inline editor · inspector rail · bulk panel — 14 blocks, 1,178 lines | ONE rules grid | **no rules grid at all** today (the old one was removed and not replaced). |
| Rank & Dayparting Schedules | fleet band · schedules/campaigns grid · ceilings · hourly performance + coverage — 8 blocks | Hourly Campaign Performance card + Schedules grid (Schedule Name · Adjustments · Days · Start · End) | **untouched by instruction** — page and builder stay as they are. |
| Budget Rules | filter bar · resolution · **census** · ratchet warning · notes · campaigns/rules grid + Restore/Transfer · **Guardrails & baseline** · footer "+ New budget rule" · transfer dialog — 14 blocks, 1,051 lines | ONE rules grid | our `?view=rules` grid is close (autonomy + refusals columns) but sits under a campaign grid, chips and the baseline tool. |
| Budget Pacing & Schedules | pinned **pacing band** · six cards (Binding now · Hour of day · Schedules · Events · Ceilings & precedence · Change log — four still "pending") · inspector rail · limits modal — 3,681 lines/19 files | Hourly Campaign Performance card + Schedules grid (Name · Type · Days · Auto Refill · Start · End · Exclude Start · Exclude End) + a builder with **Campaign Budget (hourly)** vs **Budget Multiplier (daily)**, Never Expire, Exclude Dates | most of the page is extra; the Schedules card is the part H10 has. |
| Keyword Harvest | filter bar · [Candidates \| Harvested] · **criteria bar** · resolution · census lede · **census strip** · candidates grid · cohort view · destination panel · promote dialog · **actors panel** · TabRules · **queue** · empty states — 18 blocks, 875 lines + 9 files | pill **Rules View \| Ad Group View**; Rules View = rules grid; Ad Group View = Filters (Source Campaign · Destination Campaign · Harvest Rule) + ad-group grid | the operator's three sections (Rules · Ad Group View · builder) map exactly onto H10; everything else is extra. |
| Negative Targeting | filter bar · resolution · **census** · note · negations/terms grid · term drawer · removal dialog · **Attention** · **Protected terms** · **Wasteful words** · Rules (own table) · **The record** — 16 blocks, 645 lines + 9 files | ONE rules grid | rules grid + "+ Rule" is all that is asked; ours has no "+ Rule" and its rules table links into the builder by `?ruleId=`. |
| Share of Voice | market gate · filter bar · reach · freshness band · rejection reckoning · override banner · summary strip · coverage note · banners · **signal chips** · SOV grid (saved views · weeks · ad window · brand toggle · watchlist) · row drawer — 14 blocks, 1,261 lines | ONE rules grid (SOV Rule · Automation · Criteria · Frequency · **SOV Reports**) | **no rules grid, no builder entry** today; the whole page is analytics. |
| Keyword Tracker | market gate · filter bar · resolution · feed-health line · banners · watchlist modal · term grid · term drawer (chart · ASINs · campaigns · bid action · change log) — 11 blocks, 964 lines | ONE rules grid; builder picks **ASINs** | **no rules grid, no builder entry** today; the whole page is analytics. |

Two structural facts that shape the plan:
- **The H10-shaped rules grid already exists and is unmounted.** `tabs/RuleListTab.tsx` (377 lines)
  renders through `AdsDataGrid` with exactly H10's columns — Rule (+ "Open" · History) · Automation
  (a REAL toggle that PATCHes the builder rule's `control` — manual/automate — and is disabled with
  the reason on engine rules) · Criteria (one-line summary) · Frequency (cadence / time) — plus bulk
  Automation/Delete and the empty state. Every tab retired it in favour of the governance table
  `_shared/TabRules.tsx` (Rule · May it act? · Where · Caps · Executions), which is the wrong shape
  for the operator's ask. Only its `HistoryDrawer` export is still imported (Automations).
- **The builder already IS the H10 builder.** `_shared/RuleBuilder.tsx` (1,224 lines) was
  frame-verified against H10 in an earlier study: steps Rule Name · {Setup} · Criteria · (Search
  Terms) · Advanced Settings · Control; "Criteria N" blocks with IF/AND/THEN; Frequency/Timezone;
  Control = Manual ("Manually approve rule actions on the Suggestions page") / Automate; Apply/Save
  Template. `_schedule/ScheduleBuilder.tsx` covers budget schedules; `_rank/RankGoalBuilder.tsx` is
  the untouchable RD builder. **The builders are not the problem; the pages around them are.**
  One Setup-step delta is worth recording (not page work): H10's Keyword Tracker builder picks
  **ASINs** ("Select the product you are using in your keyword tracker") → keywords → campaigns, and
  its SOV builder picks **Report · ASIN · Keyword → campaigns**; ours use the campaign picker for both
  (`RuleBuilder.tsx` `SETUP.sov` / `SETUP['keyword-tracker']`). See D9.

## 7. The plan — page by page

### 7.0 Principles (all four are the operator's own instructions, restated)
1. **Target shape = §2/§3, on our design system.** Each rule-type tab becomes ONE card:
   `AdsDataGrid` + `GridToolbar` ("Showing N <Type> rules" · search · **+ Rule**) with columns
   ☐ · <Type> Rule ⇅ · Automation · Criteria · Frequency, H10's empty state and pager, opening the
   existing builder. Our page header (market picker, Change Log) and tab bar stay.
2. **Nothing is deleted — sections are PARKED IN PLACE** (✅ D7, operator 2026-08-16). Every extra
   section is unmounted from its page and the file **stays exactly where it is**, gaining a `PARKED`
   header comment (what it did · why it left · candidate new home) and one line in the manifest
   `docs/2026-08-16-ra-parked-sections.md`. No file moves ⇒ no import churn on a tree other sessions
   share; the pre-push gate has no dead-code detector, so parked files still build. Their API
   endpoints stay live. When Suggestions / Analytics / Reporting want a section, it is a mount, not
   a rewrite.
3. **The builders stay.** `_shared/RuleBuilder.tsx` unchanged (except wiring, if any); RD page and
   RD builder untouched; `ScheduleBuilder` reused for Budget Schedules.
4. **One unit at a time** (✅ D8, operator 2026-08-16): each unit is approved before its prompt is
   written, click-verified on **prod** (`ui-self-verify` + geometry), then committed and pushed on
   its own before the next begins — so any regression is traceable to one small change.

### 7.1 Unit U0 — the shared rules grid (foundation; changes no page yet)
- Promote `tabs/RuleListTab.tsx` → `_shared/RulesGrid.tsx` (move + rename; `HistoryDrawer` export
  kept for Automations). Bring it to §2 exactly: card header "Showing N <Type> rules" / "Viewing
  1-N of N <Type> Rules" + search; **+ Rule** top-right (→ `/builder/<slug>`); columns ☐ · "<Type>
  Rule ⇅" (name → builder edit `?ruleId=`; hover "↗ Open" · "History") · Automation (existing real
  toggle) · Criteria · Frequency; empty state "Create a <Type> Rule to generate suggestions for a
  campaign!" + outlined [Create Rule]; pager + Rows per page.
- Membership = `ruleBelongsToTab(actions, tabKey)` — the same predicate the tab badges use, so
  badge and grid cannot disagree; **verify per tab on prod that the builder slugs
  (`keyword-harvesting`, `sov`, `keyword-tracker`, `placement`, …) all resolve** (the earlier
  "badge says 5 over a grid that shows 0" defect class).
- Criteria summary: extend `summariseRule` for the non-budget THEN verbs (bid, placement lane, SOV,
  rank) so the cell never prints "—" for a saved rule.
- ~120 lines net; no page mounts change in U0. Prod check: the grid renders on a scratch route or
  behind the first page unit (U1) — I would fold U0 into U1's verification.

### 7.2 Unit U1 — Bid (15 blocks → 1) — ✅ SHIPPED + prod-verified 2026-08-16
Commits `5aabc2730` (U0+U1) · `71ed16157` (both rule shapes) · `32d34310d` (disabled chip + units).
Verification and the three corrections it forced: `docs/2026-08-16-ra-parked-sections.md` § U1.
🔴 Two facts for every later unit: **a builder-created rule is stored `enabled: false`** (it does
nothing until enabled on Automations), and **an engine rule has no schedule** — its cadence is its
trigger, so a Frequency column must not print one.

`bid/page.tsx` mounts a new ~60-line `BidRulesClient` (header · tabs · `RulesGrid tabKey="bid"`).
Park: `BidClient.tsx` (filter bar, bidder band, resolution, census, notes, targets/campaigns grid,
selection actions), `BidBounds.tsx`, `BidActivity.tsx`, `BidStagedTray.tsx`, `BidTargetDrawer.tsx`,
`BidGoalDialog.tsx`, `BidBidderBand.tsx`, `BidSpark.tsx`, `BidRules.tsx` (TabRules mount).
Candidate homes: census/bounds/activity/bidder band → **Analytics**; staged tray → **Suggestions**;
target drawer + goal dialog → Ad Manager campaign detail (later).
Header: `primaryAction` "+ Rule" → `/builder/bid` (H10 has it on every tab).

### 7.3 Unit U2 — Placement (14 blocks → 1) — ✅ SHIPPED + prod-verified 2026-08-18
Commits `adaff0950` (page) · `d5779c9c1` + `a9ad3975b` (name-column overflow). Verification and the
defect it caught: `docs/2026-08-16-ra-parked-sections.md` § U2. 🔴 **All 8 placement rules are
disabled** — the "off" chip surfaced it; operator decision, not this unit's.
`placement/page.tsx` mounts `PlacementRulesClient` (`RulesGrid tabKey="placement"`; builder
`/builder/placement`). Park: `PlacementClient.tsx` (scope bar, census cells, lane split, "the hour",
campaign×lane grid + inline lane editor, refusal alert), `PlacementScopeBar.tsx`,
`PlcInspector.tsx`, `PlcBulkPanel.tsx`. Candidate homes: lane split + census → **Analytics**;
campaign×lane grid + bulk panel → **Bulk Operations** / Ad Manager (later).
Note: the multiplier write path (`/placements/:id/lane`, PLC.3) stays intact behind its endpoints;
nothing on the new page writes multipliers — that is H10's shape too.

### 7.4 Unit U3 — Share of Voice (14 blocks → 1) — **the first tab that gains a rules grid**
`share-of-voice/page.tsx` mounts `SovRulesClient` (`RulesGrid tabKey="share-of-voice"`; builder
`/builder/sov`; column set = H10's incl. **"SOV Reports"** — the SOV report(s) the rule reads,
per §5.3; our SOV builder must expose the same Setup: Report · ASIN · Keyword · Campaigns, criteria
"ASIN SOV" first, "Keyword Performance" as ANDs). Park: `ShareOfVoiceClient.tsx`
(market gate, freshness band, rejection reckoning, override, summary strip, signal chips, the SOV
grid with saved views / weeks / ad window / brand toggle / watchlist), `SovRowDrawer.tsx`,
`SovSavedViews.tsx`, `sovExport.ts`. Candidate homes: the whole SOV grid + chips + drawer →
**Analytics › Coverage** (which already owns SOV-flavoured columns); export → **Reporting**.
Also: today's page GATES on one market ("Pick one market") — the rules grid does not need that.

### 7.5 Unit U4 — Keyword Tracker (11 blocks → 1)
`keyword-tracker/page.tsx` mounts `KeywordTrackerRulesClient` (`RulesGrid tabKey="keyword-tracker"`;
builder `/builder/keyword-tracker`, whose Setup step is the ASIN/keyword-list picker — ours already
takes ASINs via `/keyword-ranks`; verify it matches §4.3's shape). Park: `KeywordTrackerClient.tsx`
(market gate, feed-health, watchlist notes), `WatchlistPanel.tsx`, `TermDrawer.tsx`, `TermChart.tsx`,
`BidAction.tsx`, `ChangeLog.tsx`, `csv.ts`. Candidate homes: term grid + drawer + chart →
**Analytics › Coverage**; watchlist → the KT builder's Setup ("+ Create New Keyword Tracker" is
exactly what H10 puts there); csv → **Reporting**.

### 7.6 Unit U5 — Negative Targeting (16 blocks → 1)
`negative-targeting/page.tsx` mounts `NegativeRulesClient` (`RulesGrid tabKey="negative-targeting"`;
"+ Rule" → `/builder/negative-targeting`). Park: `NegativeTargetingClient.tsx` (filter bar, census,
negations/terms grid), `NegTermDrawer.tsx`, `NegRemoval.tsx`, `NegAttention.tsx`,
`NegProtectedTerms.tsx`, `NegWastefulWords.tsx`, `NegRules.tsx` (its own table — superseded by
RulesGrid), `NegRecord.tsx`. Candidate homes: Attention + Wasteful words → **Suggestions** (they are
proposals); Protected terms → **Control Room › Guardrails** (`ProtectedTermsPanel` already lives
there); the record + negations grid → **Analytics** / **Change Log**.
⚠ The gate/whitelist logic is server-side and stays armed; parking the UI removes no protection.

### 7.7 Unit U6 — Budget Rules (14 blocks → 1)
`budget/page.tsx` mounts `BudgetRulesClient` (`RulesGrid tabKey="budget"`; "+ Rule" →
`/builder/budget`). Park: `BudgetClient.tsx` (filter bar, census, ratchet warning, campaigns grid,
Restore/Transfer, the `?view=rules` grid, footer), `BudGuardrails.tsx`, the transfer dialog.
Candidate homes: campaigns/budget grid + Restore + Transfer → **Budget Manager** (the rail item H10
also has); Guardrails & baseline → **Control Room › Guardrails**; census → **Analytics**.
Keep the H10 distinction explicit: this tab = *rules that change budgets*; the next = *schedules*.

### 7.8 Unit U7 — Keyword Harvest (18 blocks → pill + 1 card)
`keyword-harvest/page.tsx` mounts `KeywordHarvestClient` (new, small): pill **[Rules View | Ad Group
View]** (`?view=rules` default | `?view=ad-groups`).
- Rules View = `RulesGrid tabKey="keyword-harvest"`; "+ Rule" → `/builder/keyword-harvesting`.
- Ad Group View = Filters (Source Campaign · Destination Campaign · Harvest Rule — multi-select with
  chips, Clear) + the ad-group grid. H10's grid never loaded in the recording, but its columns are in
  the app bundle (§5.3): **Ad group Type · Ad Group · Campaign · Of Target · Harvest Rule · Keyword
  BPE (B/P/E/ASIN) · Negative Keyword (P/E) · Negative Targets (ASIN)**, expandable rows source ad
  group → destination ad groups, empty state "There are no rules currently. Please create a rule."
  The data is the rule's ad-group mapping (already stored by our builder) — no new endpoint beyond a
  read of the rules' mappings joined to ad groups/campaigns.
Park: today's `KeywordHarvestClient.tsx` (candidates/harvested views, thresholds bar, census lede +
strip, candidates grid), `HvThresholds.tsx`, `HvCohort.tsx`, `HvDestination.tsx`, `HvPromote.tsx`,
`HvActors.tsx`, `HvQueue.tsx`, `HvRepairs.tsx`. Candidate homes: candidates grid + promote + queue →
**Suggestions** (they are literally the harvest suggestions H10 shows there); cohort ("did the last
batch work") → **Analytics**; actors → **Automations › Engines**.

### 7.9 Unit U8 — Budget Pacing & Schedules → **Budget Schedules** (7 cards → 2 parts)
`budget-schedules/page.tsx` mounts `BudgetSchedulesClient` (new, small):
1. **"Hourly Campaign Performance"** card — two metric selects (Spend / ACoS defaults) over the
   hourly chart from `GET /advertising/budget-schedules/hourly-performance` (17,963 rows — unlike
   H10's amazon.in account we HAVE hourly data, so the card is real, not the constant it once was).
2. **Schedules grid** "Showing N Schedules" · search · eye-slash (show ended) · **+ Rule** →
   `/builder/budget-schedule`; columns **Budget Schedule Name · Type · Days · Auto Refill · Start
   Date ⇅ · End Date ⇅ · Exclude Start Date · Exclude End Date**; row → the builder `?scheduleId=`.
   `SchedulesSection.tsx` already renders most of this; it becomes the card.
Park: `PacingBand.tsx`, `BindingSection.tsx`, `CampaignBindingRail.tsx`, `InspectorRail.tsx`,
`PlanEditor.tsx` (+ `CalendarEditor`, `EnforcementPreview`), `CampaignLimitsModal.tsx`, the four
"pending" section shells, `planMath.ts`, `usePlanWrites.ts`. Candidate homes: pacing band + binding
+ limits → **Budget Manager**; events/ceilings/change log → Control Room / Change Log.
Decision D5: the builder's **Campaign Budget (hourly) vs Budget Multiplier (daily)** radio — our
`ScheduleBuilder` has hourly campaign-budget schedules; the daily "multiplier" type (On Weekdays /
On Weekends) and its **"Budget Auto-Refill Criteria"** ("If selected campaigns run out of budget →
Increase Daily Budget … Max", which is what the "Auto Refill" column shows) are new.

### 7.10 Unit U9 — Apply Rules (already the H10 shape; small delta) — decision D6
Keep the page. Proposed delta only: (a) columns **Bid Rule · Target ACoS · Min/Max Bid · Bid
Automation · Budget Rule** in H10's order (ours has Target ACoS + Bid bounds; Bid Rule / Budget Rule
would read the assigned rule names, Bid Automation the campaign's write-gate flag); (b) selection
toolbar verbs **[Automation] [+ Assign Rule] [Target ACoS] [Min/Max Bid]** — H10's "Assign Rule"
dialog picks a Rule Type (Bid Rule · Budget Rule · Placement Rule · Dayparting Schedule · Budget
Schedule) then one rule, under H10's exclusivity ("a campaign can only be in one bid rule at a
time"); for us it needs the additive plural-scope columns noted in the RA memory (assigning from the
campaign side must ADD a binding, not MOVE the rule); (c) whether the four-grain segment stays (H10
has campaigns only).

### 7.11 Unit U10 — the tab bar and the header (D1 ANSWERED; D2 open)

**✅ D1, operator 2026-08-16: H10's ORDER; H10's LABELS for the two budget tabs; the RD tab keeps
ours.** The decided array (`_shared/tabs.tsx`, `RULES_TABS`):

| # | key | label | change |
|---|---|---|---|
| 1 | `rules` | Apply Rules | — |
| 2 | `automations` | Automations | not in H10 — **stays 2nd** (D2, answered) |
| 3 | `bid` | Bid | moved (was 3rd) |
| 4 | `keyword-harvest` | Keyword Harvest | **moved up** (was 8th) |
| 5 | `negative-targeting` | Negative Targeting | **moved up** (was 9th) |
| 6 | `budget` | **Budget** | **relabelled** (was "Budget Rules") |
| 7 | `dayparting` | Rank & Dayparting Schedules | **label KEPT** (H10 says "Dayparting Schedules"); moved |
| 8 | `budget-schedules` | **Budget Schedules** | **relabelled** (was "Budget Pacing & Schedules") |
| 9 | `placement` | Placement | moved down (was 4th) |
| 10 | `share-of-voice` | Share of Voice | moved down |
| 11 | `keyword-tracker` | Keyword Tracker | — |

Two consequences of the reorder, both flagged now rather than discovered later:
1. 🔴 **The four-cluster hairlines cannot survive it.** `tabs.tsx:358` renders a separator wherever
   `group` changes, and the array order IS the grouping. Under H10's order the clusters interleave
   (act · bid-place · terms · terms · spend · bid-place · spend · bid-place · terms · terms) → **8
   stray dividers**. H10's own bar has none. **Plan: delete the separator render + the `group`
   field** (`h10-rt-sep` has no other consumer; nothing else reads `.group`). Say so if you want the
   clusters kept instead — then the order cannot be H10's.
2. The two relabelled tabs keep their `key` and route (`budget`, `budget-schedules`), so no URL,
   no `RULE_TAB_ACTION_TYPES` entry and no deep link changes. Their subtitles are revisited when
   their pages are reduced (U6/U8), not here.
- Also in U10: "+ Rule" in the page header on every tab, opening the ACTIVE tab's builder (H10).
- ✅ **D2, operator 2026-08-16: Automations stays, in its current 2nd slot** (right after Apply
  Rules). It owns every rule record — all other grids link `?rule=` to it — plus the Queue and the
  Limits. Its longer-term fate is revisited after U1–U8 land, not now.

### 7.12 Order and size
U0+U1 (Bid) → U2 (Placement) → U3 (SOV) → U4 (KT) → U5 (NEG) → U6 (Budget Rules) → U7 (Keyword
Harvest) → U8 (Budget Schedules) → U9 (Apply Rules) → U10 (tab bar). Simplest first, so the shared
grid is proven on prod before the pages with new UI (KH ad-group grid, BSP hourly card). Each unit
= one small new client (~60–150 lines), one page.tsx edit, PARKED comments + manifest lines, prod
verification, commit+push. Rough net effect on the section: ~11,000 lines unmounted, ~900 written.

## 8. Decisions — D1 · D2 · D7 · D8 answered 2026-08-16; D3–D6, D9 still open
(The four answered ones are the ones that gated U0/U1, so the build can start; D3–D6 gate later
units and are asked when those units come up.)
- **D1 — Tab bar — ✅ ANSWERED 2026-08-16:** H10's order; relabel `budget` → "Budget" and
  `budget-schedules` → "Budget Schedules"; **the RD tab keeps "Rank & Dayparting Schedules"**. Built
  in U10; the array and its two consequences (cluster hairlines go; keys/routes unchanged) are in
  §7.11. Open sub-question: where does **Automations** sit in that order — 2nd, as today, or last?
  (Folded into D2.)
- **D2 — Automations tab — ✅ ANSWERED 2026-08-16:** keep it, in its current **2nd** slot; revisit
  its fate after U1–U8.
- **D3 — Keyword Harvest › Ad Group View:** build it with H10's exact columns (§7.8, now known from
  the bundle) — confirm.
- **D4 — Share of Voice rules:** H10's SOV rule reads an **SOV report** (made under Reporting) for
  chosen ASINs + keywords, then bids on the campaigns using that product. Our SOV data is our own
  SQP-derived share (no "report" object). Options: (a) the "SOV Reports" column names the SOV
  dataset/market the rule reads (our equivalent), or (b) drop the column. Recommend (a).
- **D5 — Budget Schedules "Budget Multiplier (daily)"** type: build it as a second schedule type
  now, or ship U8 with Campaign Budget (hourly) only?
- **D6 — Apply Rules delta:** (a) H10 columns, (b) bulk verbs incl. "+ Assign Rule" (needs the
  additive plural-scope schema), (c) keep or drop the four-grain segment — which of the three?
- **D7 — Parking mechanics — ✅ ANSWERED 2026-08-16:** park **in place** + `PARKED` header comment +
  the manifest doc. No file moves.
- **D8 — Verification cadence — ✅ ANSWERED 2026-08-16:** one prod verification + one commit/push
  **per unit**.
- **D9 — (optional, later) builder Setup parity for SOV / Keyword Tracker:** re-shape their Setup
  step to H10's (KT: ASIN → keywords → campaigns; SOV: report/dataset → ASIN → keyword → campaigns)
  or leave the campaign picker as is? Not required for the page reduction; the operator said the
  builder is right as it is, so the default is "leave".

## 9. Appendix — artefacts
Session scratchpad `…/scratchpad/`: `ra-frames/hi|lo` (all frames), `diffs2.csv` (change signal),
`storyboard.json` (899 keyframes), `sheets/` (450 sheets), `narr_00.md…narr_09.md` (+`narr_00b.md`)
the frame-by-frame narratives, `crop.py` (full-res zoom by frame number), `sheet.py`,
`inventory_summary.md` (our pages). Re-run: `diff2.py` → `storyboard.py` → sheets.

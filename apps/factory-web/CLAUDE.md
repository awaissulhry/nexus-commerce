# apps/factory-web — the factory web app

Next.js 16 (App Router), the same Next and React versions as `apps/web`, built from the design system `@nexus/ui`
(packages/ui, compiled here: `transpilePackages`). Four views as route groups: Office `(office)` (built), Links
`(links)` (built), Floor `(floor)` (built: B-W0-29) and Portal `(portal)` (later steps); office sign-in `(auth)` (built:
B-W0-26).

## Commands (from the repository root unless noted)
    FACTORY_API_URL=http://127.0.0.1:8190 npm run dev -w @nexus/factory-web     # :3200
    npm run typecheck -w @nexus/factory-web     # next typegen + tsc; needs no API
    cd apps/factory-web && npx vitest run
    cd apps/factory-web && FACTORY_API_URL=http://127.0.0.1:1 npx next build
    node scripts/factory/run-guards.mjs        # check-view-boundaries, check-i18n, check-no-design-route among them
    node scripts/factory/check-no-design-route.mjs --require-build   # after `next build`: no /design in the build
    # Beside a running dev server, build elsewhere (Next adds that folder to tsconfig.json's include: do not commit it):
    cd apps/factory-web && FACTORY_WEB_DIST_DIR=.next-check FACTORY_API_URL=http://127.0.0.1:1 npx next build
    node scripts/factory/check-no-design-route.mjs --require-build --dist .next-check

The design index: `FACTORY_API_URL=http://127.0.0.1:1 npm run dev -w @nexus/factory-web`, then
http://localhost:3200/design (every screen by SCR id) → a screen (every case in light and dark, desktop 1440, tablet 1024
(the floor's first size) or phone 390, Italian or English) → "Open alone" for the keyboard. It needs no API.

## Layout
- `src/app/layout.tsx` — every view's root: DS stylesheets (tokens → primitives → components → patterns → a11y),
  Inter + JetBrains Mono, theme (`factory_theme` cookie; "system" set before paint by `THEME_SCRIPT`), language
  (`factory_locale` cookie, else Accept-Language, else Italian), skip link, pdf.js for every PdfViewer.
- `src/app/(office)/layout.tsx` — the session loader (`GET /auth/office/me`; no session → `/sign-in`); the person's
  language. `(office)/w/[company]/layout.tsx` — one company (`x-factory-company` = the address's company; 403 → "go to
  your company"), the Office shell. Pages live under `/w/<company code>/<area>/…`.
- The Office shell's area navigation is the DS `WorkspaceSubheader` NOT `pinned`, exactly as Commerce's Settings
  (`apps/web/src/app/settings/_shell/SettingsShellHeader.tsx`): a band on top of the page — the toggle button, then a
  dense `DetailHeader` (page title, area › group as meta) — whose button opens the area's pages as an overlay. No
  permanent column, no collapse strip (Owner, 2026-10-28).
- `src/app/(auth)/` — office sign-in (SCR-001), no chrome, no session: `/sign-in`, `/forgot-password`, and the mailed
  links `/reset-password#token=…`, `/accept-invitation#token=…` (the token read from the fragment once, then removed
  from the address bar). One flow container (`_auth/OfficeAuth.tsx`) over one view; the company's sign-in name is a
  page cookie (`factory_tenant`). A new session opens `/w/<company>`, or the profile's authenticator card while
  the person's role needs two-factor they have not set up. `src/areas/me/` — my profile & security (SCR-007,
  `/w/<company>/me`, from the person menu; no navigation row).
- Office entries — `/w/<company>` and each area's own address (`/home`, `/admin`; the rail and the brand link go
  there) — redirect on the server to the first page the person may open, in navigation order, among the BUILT pages
  (`shell/office/office-entry.ts`, `OFFICE_PAGES` in shell/nav/office-nav.ts); none built: My profile. A step that
  builds an office page adds its address to `OFFICE_PAGES`; a new area adds its entry page (`office-entry.vitest.test.ts`
  holds both).
- `src/app/(links)/` — no chrome: `/l#token=…` (a one-off link; the token is read from the fragment, removed from the
  address bar, sent only in `x-factory-link`), `/privacy/<company id>` (the privacy-notice slot, GAP-005).
- `src/app/(floor)/` + `src/floor/` — the Floor view (SCR-020 … 025): `/floor` (tile home), `/floor/enrol`,
  `/floor/sign-in`, `/floor/notice`, `/floor/scan`, `/floor/sync` (Waiting to send, SCR-023), the web app manifest
  `/floor/manifest.webmanifest` and icon (no service worker yet). The offline queue (B-W0-30, `floor/queue/`): every
  floor action that may queue (factory-domain floor-sync QUEUED_ACTIONS) is saved in IndexedDB first (queue.ts:
  `store.queue.enqueue(kind, payload)`; a bundle's ticket numbered from the tablet's own BUNDLE block) and sent in
  order to `POST /floor/sync` when the network is back, on view, after each action and every 20 s; receipts,
  inspections, releases and serials never queue (Home says what waits). The shell's banner counts come from
  `floor/shell/banner.ts`; dev builds expose the queue as `window.__nexusFloorQueue` for the live check (never in a
  production build). One client root (`floor/FloorApp.tsx`, mounted by the group's
  layout) knows the device (`GET /floor/device`) and the operator (`GET /floor/me`), speaks the operator's language
  (else the one picked on the screen, else the tenant's; both catalogues come from the layout), runs the idle sign-out
  and the frame's pop-ups, and sends each state to its screen (no device → enrol; nobody → sign-in; a PIN to choose →
  sign-in; just signed in → the notice when due, else Home). Rules without a screen in `floor/model.ts` (mode from the
  work centre, tiles = mode AND permission, only built pages open) and `floor/scan/scan-model.ts` (the scan router);
  calls in `floor/api.ts`. A step that builds a floor page sets its tile `built` in `TILE_RULES`.
- `src/app/design/` — the LOCAL design index. Route files are `*.design.tsx`: `next.config.ts` reads that extension
  only under `next dev` (`src/lib/design/route.ts`), so `/design` does not exist in a build.
- `src/shell/` — the frames: `office/` (SCR-003), `switcher/` (SCR-002), `palette/` (SCR-004), `links/` (SCR-028),
  `nav/office-nav.ts` (assembles the area manifests). `src/areas/<area>/nav.ts` — one navigation declaration per area.
- `src/lib/` — shared by every view: `api/` (the client), `session/`, `i18n/`, `theme/`, `pdf/`, `links/`, `design/`.
- `src/areas/products/styles/` — Products › Styles (SCR-040 list, SCR-041 … SCR-045 the Style studio): `api.ts` (every call, checked
  against factory-domain's own contracts), `model.ts` (pure rules), `list/`, `record/` (studio shell, Overview, Colourways &
  sizes), `bom/`, `routing/`, `cost/`, `compliance/` (the revision tabs), `demo/fixtures.ts` (made-up data for the design cases).
- `src/areas/products/{materials,operations,sizes}/` — the product libraries: Materials & trims (SCR-047 list, SCR-048
  the record: Overview with the units converter, Colours, Properties & grades, Suppliers & prices (cost grain only),
  Compliance, Stock), Operations (SCR-049, the record with Where used → "Update N to the library value" on draft
  routings), Sizes & measurements (size scales; the scale record with its sizes' body measures). Shared parts, rules,
  role cases and the `library` catalogue's test in `products/library/`. Each folder: `api.ts`, `model.ts`, the page
  container, `view/`, `record/`, `fixtures.ts` (made-up data).
- `src/areas/compliance/certificates/` (SCR-050 register, SCR-051 the record with coverage and the lapse check; B-W2a-66: the
  Renewals tab `?tab=renewals&act=renew|applied|link` in `renewals/` — api, model, `use-renewals.ts` container hook, view, made-up
  fixtures — and the register's "Change waiting" column and `?view=changes`; the style compliance tab's "Changes that may need the
  notified body" + Tell Compliance (the ONE New task dialog)) and
  `src/areas/compliance/labels/` (SCR-053 list, `SCR-053-label` the PPE label builder: the preview re-rendered as you
  type with factory-domain's `renderLabel` over the values the API's preview answers; CE mark, pictogram and care
  symbols are named stand-ins). Catalogues `certificates`, `labels`.
- `src/links/<task>/` — a one-off link's task page, in the Links view (`links/quote-accept`, SCR-099: the link landing
  opens it for a QUOTE_ACCEPT link with the same client; the token stays in its header; `links/deposit-pay`, SCR-199:
  a DEPOSIT_INFO link's deposit to pay by bank transfer, each field with Copy). `src/areas/_shared/` — Office
  parts several areas share (`document-send`, SCR-037: the send dialog any document uses; the host passes its words).
- `src/list-frame/` — the ONE list frame of every Office list with actions over many rows (Owner rule 2026-10-29):
  `<ListFrame rows rowId columns count search tools right selection updates more keys onHelp onOpen state />` — the DS
  grid (NexusGrid in GridCard), toolbar count/search ⇄ bulk actions while rows are selected, the header select-all box
  (mixed when some), shift-click range, keys `/` j k x Enter Space ?, a footer with Show more and ONE keys icon
  (`ListKeysInfo`; never key hints above a table). Its words are `messages/<locale>/lists.json`; lab: `/design/list-frame`.
  Its toolbar also holds the list tools (B-W2a-23, `list-frame/tools/`, SCR-232): Columns ▾ (saved views — mine, shared
  with a role or everyone, a role's default; Save view as…, Update, Rename or share with Copy link, Remove; Customise
  columns… = the DS PreferencesModal with the density) and Export ▾ (this view as CSV or Excel, my recent exports, the
  export-job dialog) for every Office list page without work: the key is the page's (`/sales/orders` → `sales.orders`;
  a second frame `<page>.2`; `listKey` prop to name one, null for none; record pages have none). A view's filters are
  the list's own address terms, so a list keeps its state in its address as before. The seam is `ListToolsContext`
  (`tools/transport.ts`), mounted once by the Office shell (`areas/_shared/list-tools/ListToolsProvider.tsx`: the API,
  the address, the clipboard, the working layout in localStorage per list); `areas/_shared/list-tools/memory.ts` is the
  same in memory (the gallery). Export ▾ appears only for a list with an API export source.
  B-W2b-13 (`list-frame/w2b/`, SCR-232's `w2b-*` cases) adds the W2b frame, each part OPT-IN by one prop (a list without
  it keeps its table): `modes` { mode, onMode, board?, calendar? } (Table · Board · Calendar · Cards, a DS SegmentedControl
  beside Columns ▾; the mode is the list's OWN address term `?mode=` — `modeOfAddress` / `withMode` — so a saved view keeps
  it; board = DS BoardView over the rows (a card from the columns, `onMove` only where no review is needed, `moveHeld`,
  `heldReason`); calendar = DS CalendarGrid (rows per day) + the chosen day's rows, moved through the inline edit's save),
  `cards` { fields?, hrefOf?, sort? } (DS GridCardList below 720 px and the Cards mode; a trailing right-pinned column is
  the card's ⋯), `edit` { fields (by colId: kind date|integer|text|choice, valueOf, held), versionOf, labelOf, onSaved,
  bulk?: { noun }, held? } (cells edit in AG read-only mode and save through the list's API bulk target —
  `POST /views/bulk/apply`, version-checked — with the DS CellSaveTracker marks and SaveStatus; a pasted range is one
  write; `bulk` adds Edit N → fields → ReviewChangesModal (old → new, already so, refused, conflicts) → Done with Undo),
  `quick` { filters (me | date with RELATIVE_DAYS | flag), values, onChange } (Quick filters ▾ + chips; the words stay in
  the address, the API resolves them), `selection.exportSelected` (Export N of the selected rows through the export
  engine, `ids`), `withheld` (Columns ▾ "Hidden: …"). Columns ▾ also offers Freeze the first column and the density.
  The transport gained `bulkPreview` / `bulkApply`. First list on it: Production › Work orders (due date, priority).
- `src/areas/search/` — global search (B-W2a-32): All results (SCR-248, `/w/<company>/search?q=&type=`, a frame page
  with no navigation row) and the shared parts of the palette's record groups (`model.ts`: where a result opens —
  its company's Office, `recordAddress`, a supplier on the buying side —, the type/status words of `search.json`;
  `RecordTypeIcon`). The palette's record search is `shell/palette/use-record-search.ts` (the shell container asks
  `GET /search`; the view only reads `model.records`). A step that indexes a new record type adds its words
  (`type.<Type>`, `chip.<Type>`, new status codes) to `messages/*/search.json` and the type to `SEARCH_TYPES`, its icon to
  `RecordTypeIcon` and its view permission to `SEARCH_VIEW_PERMISSIONS` (B-W2b-23: 32 types; a type without a page of its own,
  `Ddt`, opens its record panels — the navigation test's PANELS_ONLY).
- `src/record-panels/` — SCR-006, the panels every record page mounts: `<RecordPanels record={{ type, id, companyId,
  siteId }} title party />` (thread, files, history; live refresh from `/live`). A screen with its own catalogue wraps its
  view in `WithMessages` (record-panels/i18n.tsx): the layouts load `shell` only.
- `src/areas/quality/` (Inspections SCR-075, the record SCR-076 with its release, reversal and quality-rules dialogs, the
  evidence trail `/compliance/evidence/<batch|serial>/<subject>`) and `src/areas/compliance/` (Tests & substances SCR-054:
  lots, Cr VI results, the lot release; PPE register SCR-113): their shared parts are `areas/quality/_shared/` (record
  frame, check list = the gate in words, step-up hook + DS StepUpModal, live hook, `qualityCan`, the lot schema);
  catalogues `quality`, `lab`, `register`.
- `src/areas/quality/complaints/` — Quality › Problems › Complaints (B-W2a-65; SCR-113-complaints list, SCR-113-complaint the record; catalogue `complaints`): `?view=new|safety|dueSoon|open|answeredMonth|closed|all` (the tiles = named filters), `?category=` `?severity=` `?mine=1` `?q=`, `?new=1` Log complaint (a scanned serial fills customer, garment, order, shipment through `POST /quality/complaints/preview`; photos after logging through the generic files routes), `?open=<id>` the triage DetailModal (J / K over the NEW queue; Safety asks `ComplaintSafetyConfirm`, which names who is told from `/quality/complaints/people`); the danger safety banner (one at a time, never timed out; Acknowledge = the owner's `quality.complaints.acknowledge`); the record `?tab=complaint|linked|activity` (`?do=ncr|register` from the list's verbs; NCR via POST /quality/ncr from Complaint, repair via POST /sales/repairs {complaintId}); held steps are the API's `held/<CODE>` in words (`held.<CODE>`).
- B-W2a-40 (every day at Home): `src/areas/home/notifications/` (SCR-005, `/home/notifications?tab=&state=`, catalogue
  `home-notifications`; the shell's bell is `shell/office/use-bell.ts`: ONE `GET /notifications/counts` when the shell
  mounts, then live `notification.created`, a reconnect, or the window event `factory:notifications-changed` that any
  screen sends after it marks notifications read, done or snoozed), `src/areas/home/tasks/` (SCR-233, `/home/tasks?tile=
  &scope=&q=&open=&new=1`, catalogue `home-tasks`), the record panels' Tasks tab, Follow / Followers and `@name` mentions
  (`record-panels/tasks/` = every task and follower call and its zod, `view/TaskNewDialog.tsx` = the ONE New task dialog),
  and Today with `include=TASKS,MENTIONS,ALERTS` (six tiles, my tasks and mentions with Done / Snooze, Coming up). "Snooze
  until" is ONE dialog (`areas/home/today/view/SnoozeDialog.tsx` over `today/snooze.ts`: the site's times).
- B-W2a-79 Home › Insights › Reports (`src/areas/home/reports/`, catalogue `home-reports`): SCR-104 the library `/home/reports?q=&area=&outside=1` (the shared list frame; reports outside the role hidden until asked; "last opened by me" in localStorage), SCR-104-report `/home/reports/<key>?tab=results|schedule|about&<filters>&group=` (filters + Group by, "What you see" banner, rows → records, Export ▾ CSV of the rows the API sent / PDF = the print tab), SCR-104-print `…/print`. My numbers on Today: `areas/home/today/numbers/` (GET /home/numbers; the flow strip's lens picks the numbers; ⓘ = "How this number is made"). A report's words: `report.<area>.<name>.{title,question,definition,sources,col.*,filter.*,choice.*}`, codes `code.<CODE>`, numbers `number.<key>.*` (the API's registry test reads them).
- B-W2a-78 (alerts and the exception rules): `src/areas/home/alerts/` Home › Insights › Alerts (SCR-234, `/home/alerts?tile=
  &severity=&kind=&q=&open=<alert>&rule=<id>|new`, `#rules`; catalogue `home-alerts`: an alert is said from its phrase `w.<key>` =
  factory-domain ALERT_TEMPLATES, held equal by a test): tiles, the open alerts (list frame, Acknowledge N), the alert's
  DetailModal (D acknowledge, Assign through `GET /alerts/:id/assignees`, Snooze = today's SnoozeDialog ≤ 30 days, Resolve with a
  note), the Rules; `RECORD_PAGES.Alert`. `src/areas/admin/automation/` Admin › Platform › Approvals, automation & AI (SCR-167
  W2a part, `?view=timers`, keys 1–5; the other four lists held with their wave; catalogue `admin-automation`). Both keep rules
  through `src/areas/_shared/rules/` (catalogue `rules`): `use-rules.ts` (THE hook: list, switch, number, the dialog's choices
  / dry run / timers / save), `view/RuleSentence.tsx` (the NEW part: a rule as one sentence with its parts as fields; its words
  equal factory-domain `ruleSentence`, held by a test), `view/RuleDialog.tsx`, `view/RulesList.tsx`, `demo.ts` (made-up rules).
- B-W2b-05 shell foundations: `src/shell/scope/` (`useOfficeScope()` = the top bar's company and site: `siteId` for the
  API, `allSites` → `siteColumn(...)` + `<ScopeSiteChip model={scope} />` "Site from the top bar"; the sites are
  `me.sites`, the person's reach; a switch re-reads the pages that put `scope.siteId` in their reads; `start/` = My
  profile's "Where I work" start page, kept in the scope cookie), `src/shell/live/` (ONE live connection per tab:
  `useLiveBus` / `useLiveChanges`; never `new EventSource` in a screen), `src/shell/print/` (`?print=1` on any office
  address = its print view; `usePrintMode()`; the band's Print opens a page's own `<page>/print` when it has one),
  window pages = `WINDOW_PAGES` in shell/nav/office-nav.ts (window frame, their row opens a new tab), the phone's tabs
  per person (`shell/office/phone-bar.ts`).
- `src/lib/records/record-links.ts` — where a record opens: its own page once built (`RECORD_PAGES`, one line per record
  page; list pages in `LIST_PAGES`), else the record panel route `/w/<company>/records/<type>/<id>` (SCR-006 panels).
  Home › Today (`src/areas/home/today/`, SCR-029) and its lists open records through it.
- `src/areas/sales/orders/` — Sales › Orders (SCR-038 list + board by state, SCR-039 the order studio): `api.ts` (every
  call: orders, the deposit's page and payment, an invoice's SDI state and send, the settlement, the order's work
  orders), `model.ts` (saved rows ⇄ address = the API's own filters `?late=true` `?deposit=OPEN` `?status=` `?rows=all`,
  `?view=board`; lanes, next step held with its reason, the deposit's five steps, words for API codes), `hooks.ts` (live,
  thread dock, step-up asked first when the session has none fresh), `list/` (list frame; Export N), `record/` (tabs
  `?tab=lines|dates|production|shipments|money|documents|activity`, dialogs), `_demo/fixtures.ts` (made-up data).
  "Make work orders" opens `/production/work-orders?new=1&order=<number>` (the dialog picks that order).
  B-W2a-50 (the order every day): `daily-model.ts` (pure: the daily verbs held in words, close/reopen lines, the
  amendment draft `DraftLine` and what it sends, the API's refusals by PLACE in words (`issueWords`), the cancel's impact
  in words, schedule, before → after); `record/view/LinesEditor.tsx` = ONE lines editor for "Amend order" (Lines tab in
  amend mode) and the typed New order; `record/view/DailyDialogs.tsx` (Review amendment, Close / Reopen lines, Cancel
  with the impact and the typed number, Copy as new quote, Before → after — composed: the DS ReviewChangesModal,
  ActionConfirm, ConfirmPhraseField and EditModeBar speak English only); `record/changes/` (SCR-107, `?tab=changes`);
  `new/` the typed New order `/sales/orders/new?company=&party=&contact=&ref=` (no draft row: the page holds the lines,
  session storage keeps them over a reload; Confirm = POST /sales/orders/manual); the list's New order dialog (`c`,
  `?new=1`) and "Board in a new tab" (the board re-reads its lanes on live changes).
- `src/areas/finance/` — Finance (area order 10, Italian "Amministrazione"; SCR-080 … SCR-083): `_shared/` (api.ts every call + zod,
  model.ts the pure rules — saved views ⇄ address = the API's own `?status=` `?docType=`, journey, next step held with its
  reason, the checks in words with where to fix, payment state, placement oldest first, CSV, problems —, hooks.ts live,
  step-up asked first, thread dock; parts.tsx the named stand-ins JourneyStrip, CheckList, Bridge, DialogFrame;
  placement.tsx = MatchPanel), `invoices/list` (Shipped, not invoiced + All invoices: two list frames), `invoices/record`
  (`?tab=lines|money|sdi|documents|activity`; issue = P1 confirm then send; fix and resend; credit note), `payments/list`
  (Record a payment: two steps; `?new=1&invoice=<id>`), `payments/record` (`?tab=allocation|bank`), `settings`,
  `_demo/fixtures.ts` (made-up data). `RECORD_PAGES.Invoice|Payment` and `LIST_PAGES['/invoicing/invoices'|'/payments']`.
  B-W2a-51: `finance/accounting/` Close › Accounting export (SCR-156 `/finance/accounting`: the Exports list; the wizard
  `?new=1` / `?month=&step=period|checks|contents|intrastat|review|export`; `?lock=` the lock dialog; `files/` the Export
  files tab SCR-156-files `/finance/accounting/files?export=|exports=`, `RECORD_PAGES.AccountingExport`) and
  `finance/reports/` Reports › Finance reports (SCR-239 `/finance/reports?asOf=&site=&category=&q=&group=`: the stock
  valuation, "How this lot is valued" in the value cell; `print/` SCR-239-print); catalogues `finance-accounting`,
  `finance-reports`. Words of the accountant's open questions ("to confirm with the accountant") are said on screen.
- `src/areas/production/` — Production (SCR-069 … SCR-073): `work-orders/` the list (list frame; Export N, Release N) and
  New work order (`?new=1`), `work-orders/record/` the work order studio (`?tab=overview|materials|cutting|bundles|
  operations|quality|activity`, `?at=<seq>`; tabs in `cutting/`, `bundles/`, `progress/`), `wip/` Floor now
  (`/production/floor`); `_shared/` api, rules (`model.ts`), hooks, made-up fixtures. Totals per work order, operation
  and line only: no person's output and no station anywhere (Statuto art. 4, Owner F2); worker names only inside one record.
  `cutting/` (B-W2a-60) Production › Cutting room › Cutting (SCR-238 `/production/cutting?view=&q=&new=1&alloc=<work order>`: tiles, one cut per work order (W2a: leather by hide), New cut order → Allocate hides = the Find hides dialog over `/inventory/reservations`; the Cut record `/production/cutting/<work order>?tab=lay|pieces|yield|tickets` with the AreaBalanceBar, the pieces matrix and recuts, yield per lot, tickets reprint/void; catalogue `cutting`) and `scrap/` Floor control › Scrap & rework (SCR-140 `/production/scrap?view=&period=&kind=&by=&group=&q=&open=&replace=`: tiles, the pareto (a bar filters), rows, the DetailModal with A / R, Replace scrapped quantity; catalogue `scrap`).
  `reports/` (B-W2a-38) Production › Reports › Production reports (SCR-240 `/production/reports?site=&date=`: band with ⋯ Email me / Print, Daily production tiles + PerformanceGraph bars per lane + a SummaryTable per lane by style and size; `view/SubscribeDialog` = pop:prr-subscribe; `print/` = SCR-240-print `/production/reports/print` in a new tab; catalogue `production-reports`, also Floor now's `wip/view/LinesPanel` (fn-lines: a card per line sets `?line=`, [ / ] step)). Never a person: per line, work centre, style, size; per station only signed in / machine down (F2).
- The buying office (one catalogue `buying`; shared parts `areas/_shared/buying/`: abilities with the cost grain, words for
  problems and quantities, live hook, sites from `/inventory/locations`, layout CSS, made-up fixtures): `areas/planning/mrp/`
  What to buy & make (SCR-055: `?site=` `?view=` `?q=` `?line=` the Why detail; one-click Draft PO with Undo, Draft POs per
  supplier, Set aside), `areas/purchasing/orders/` (SCR-058 list `?view=`/`?status=`/`?waitingOver48h=true`/`?new=1`; SCR-059
  studio `?tab=lines|answer|receipts|documents|activity`, the shared send dialog through `model.ts sendModelOf` with the PDF from `…/preview` (cost grain), the
  supplier's answer and the buyer's accept/refuse), `areas/warehouse/receipts/` (SCR-063 list `?view=expected|posted|today|
  waiting|reversed|all`, the receiving page `/warehouse/receipts/new?order=&lines=` posting the whole receipt at once with the
  hide entry sheet (SCR-061), the receipt `?tab=lines|lots|activity` with its lots and quality state (SCR-062) and Reverse).
- `src/areas/plant/` — Plant › Maintenance (B-W2a-53, area order 12, Italian "Stabilimento"; catalogue `plant`): `_shared/`
  (api.ts every plant call + zod; model.ts the pure rules — saved rows ⇄ the API's own filters, the board's lanes and why a
  card may not go there, the job moves a person may make, refusals `refusal/<CODE>` in our words, costs and due times typed
  in the site's zone, people in words: a floor worker never by name in a list; parts.tsx pills, the record band, the
  composed step-up; AssigneeField; fixtures.ts made-up data), `requests/` Machine requests (SCR-148 `?view=&tile=&site=&open=
  &report=1&machine=`: the queue, its DetailModal with J / K and A / M / D / C / S, Make a job, Close, Merge, Sign safe with a
  fresh code, Report a problem with the icon grid and the photo capture; `print/` SCR-148-print), `jobs/` Maintenance jobs
  (SCR-149 `?view=&site=&machine=&mode=board&new=1`: list with inline priority / due / technician, the DS board, New job,
  Assign jobs; `record/` `?tab=problem|handback|activity`; `sheet/` the job sheet with its QR), `machines/` Machines & tools
  (SCR-150 `?view=&q=&site=&class=&new=1`: inline station / work centre, New machine, Retire N; `record/`
  `?tab=overview|history`; `tags/` the tag sheet). Pickers: `GET /plant/places`, `GET /plant/technicians?siteId`.
  B-W2a-73: `settings/` Plant settings (SCR-241 `/plant/settings?class=`, catalogue `plant-settings`: the W2a section
  Symptoms on the floor — the SCR-242 editor model on the group's symptoms, saved per cell; New symptom, the starter set,
  Stop offering / Offer again / moves; `SymptomIconPicker` over `lib/plant/symptom-icons.ts`, the ONE symptom icon map the
  Office and the Floor share), and the floor's `floor/tasks/machine/` (SCR-179 `/floor/machine`, tile `machine`, catalogue
  `floor-machine`: which machine → symptom tiles (DS ReasonGrid) → the report queued as `plant.report`; a technician's My
  jobs, the job, start / wait / hand back / take back, sign safe with the PIN; Scan anything's machine card).
- The stock screens (catalogue `stock` shared + one per page; shared parts `areas/_shared/stock/`: api (every inventory read and
  write, zod), model (abilities with the cost grain, words for API faults, units never added across, leather's two numbers
  and both area units, state tones, `movesHref`), parts (pills, Qty, Dual, NoAccess, ReadFailed), made-up fixtures):
  `areas/warehouse/stock/` (SCR-060; `adjust/` the ONE Adjust stock dialog), `moves/` (SCR-064: the why panel, the ledger
  as ONE long grid = ListFrame `endless`, the move's DetailModal `?open=`, reverse), `hides/` (SCR-200 + record), `lots/`
  (SCR-201 + record: stock, trace both ways, moves; release/block/reject stay in Compliance › Tests & substances, linked),
  `locations/` (SCR-065 + record); `areas/production/settings/` (SCR-074: who floor records name, its legal basis, step-up
  when widening); `areas/admin/privacy/` (SCR-086: duties, notices, DPIA, register; sample texts said on screen);
  `floor/tasks/labels/` (SCR-096, `/floor/labels`: garment labels behind the certificate gate; online only).
  B-W2a-76: `floor/tasks/returns-in/` (SCR-180, `/floor/returnsin`: scan the RMA → parcel condition + photos → lines by serial/batch
  scan or tap → ONE receipt, photos onto it → grade per garment (suggestion = factory-domain suggestedOutcome; the office
  decides) → the inspection place scanned) and `floor/tasks/kits/` (SCR-181, `/floor/kits`: Send a kit = ticks by scan,
  held while incomplete, the DDT's facts, send + the DDT PDF full screen with Print; Receive back = bundles by scan,
  reject/scrapped with a REWORK reason, material back) on the floor routes `/purchasing/subcontracting/kits…`; both online
  only for the write; each view wraps its catalogues (+ reason-kit, photo-kit, shell for the PDF words) in WithMessages.

## Rules
- `FACTORY_API_URL` has NO fallback: without it `next dev`, `next build` and `next start` refuse to start
  (`next.config.ts`). Only `next typegen` loads without it. Never point it at a production API from this machine.
- The API client (`src/lib/api/client.ts`) is the only way to call the API. The browser calls `/api/<route>` (rewritten
  to `<FACTORY_API_URL>/<route>`; the session cookie stays first-party); a server component calls FACTORY_API_URL with
  the request's factory cookies only (`serverApi`). Unsafe methods send `x-csrf-token` (the `__Host-factory_csrf`
  cookie); office pages use `useOfficeApi()` (adds `x-factory-company`); link tokens only in `x-factory-link`. Errors are
  `ApiError` with a kind (`signed_out`, `step_up`, `forbidden`, `not_found`, …); show your own words, never the API's.
- Screens: a view `…/view/<Screen>.tsx` takes ONE typed view model and fetches nothing (`check-view-boundaries`); the
  page or a container loads data and maps it. Beside `view/`, `fixtures.ts` exports
  `designScreen = defineDesignScreen({ screen: 'SCR-…', title, view, cases })` with made-up data (never real business
  data); `/design` finds it by itself. A view's labels from a manifest are message keys; the view translates them.
- Navigation: `src/areas/<area>/nav.ts` exports `officeArea = { order, area }` (the DS `AreaNavArea`; labels are
  `shell:`-style message keys; each row's `permission` is the one its page's API needs). The rail, sub-sidebar, crumbs,
  phone bottom bar and palette all read it; `officeNavFor(can)` filters it per person. A permission not yet declared in
  factory-domain must be in `PENDING_PERMISSIONS` (shell/nav/office-nav.ts) until its step declares it. `order` and the
  words are the approved tree's (`shell/nav/approved-tree.ts`, its W0–W2a part, checked whole by B-W2a-83: Admin is
  "Sistema" in Italian, Finance "Amministrazione", Plant 12 right above Admin 13); `shell/nav/navigation-map.vitest.test.ts`
  walks it against the rail, every overlay, the palette, RECORD_PAGES/LIST_PAGES (and every searchable record type's
  page), the floor tiles per mode and permission (the build's differences from the tree named there) and scan router, the
  link registry (`links/_nav/link-types.ts`: purpose × record type → link task page, else the link frame) and every "Area
  › Page" pointer in the catalogues. A page that ships adds its tree entry there.
- Views never import each other (`check-view-boundaries`): Office (`app/(office)`, `shell/{office,nav,switcher,palette}`,
  `areas`), Links (`app/(links)`, `shell/links`), Floor, Portal. Share through `src/lib`. No `@nexus/factory-db`.
- UI text: `messages/<locale>/<area>.json` (it, en), found by themselves; every key in both languages with the same
  `{placeholders}` (`check-i18n`). `useT('<area>')` in client code; plurals as `<key>_one` / `<key>_other` + `count`.
  Times are UTC from the API, shown in the site's zone (`lib/i18n/format.ts`, Europe/Rome by default).
- A page never sets its own max-width: it fills the shell's main area (`.fw-office-main`, equal gutters). Inner parts (a
  search field, a text column in a card, a dialog) may; on wide screens use the width (more columns, two-column cards).
- Design system only: `@nexus/ui` primitives, components, patterns (the narrower `@nexus/ui/patterns/shell/index` for
  the rail); BottomBar, PdfViewer and QrCode from their own entry points (`@nexus/ui/components/<Name>/index`). No
  Tailwind. App CSS is layout only, with semantic `--nds-*` tokens (no raw colours). A server component never imports a
  DS barrel (it holds client components): render a client component.
- `import.meta.glob` (Turbopack and Vitest): a pattern outside the calling folder needs `base` (`{ base: '../../areas' }`
  with `'./*/nav.ts'`); the keys differ between the two, so read only the last path parts.
- `tsconfig.json` has `noUncheckedIndexedAccess: false`: tsc checks the DS source this app compiles, and the DS is not
  written for it. `vitest.config.ts` compiles the DS's JSX (`oxc`), as the Commerce web's does.
- Environment only as `process.env.FACTORY_…` (`scripts/factory/check-env-loader.mjs`).

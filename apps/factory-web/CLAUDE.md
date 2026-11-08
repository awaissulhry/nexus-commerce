# apps/factory-web — the factory web app

Next.js 16 (App Router), the same Next and React versions as `apps/web`, built from the design system `@nexus/ui`
(packages/ui, compiled here: `transpilePackages`). Four views as route groups: Office `(office)` (built), Links
`(links)` (built), Floor `(floor)` (built: B-W0-29) and Portal `(portal)` (the frame: B-W2b-173); office sign-in `(auth)` (built:
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
- `src/app/(portal)/p/signin/` + `src/portal/signin/` — the portal's Sign in (B-W2b-164, SCR-026), outside the portal frame:
  `/p/signin?tenant=<slug>&company=<code>&next=<portal path>&ended=idle|revoked` (the invitation mail's address; the frame's
  `next`; with neither, the portal this device remembers: cookie `factory_portal`), `/p/signin/continue#token=…` (the mailed
  link: read with `…/link/preview`, used only on Continue), `/p/signin/privacy?company=<id>` (the company's public privacy
  notice, a new tab). Whose portal comes from `GET /branding/portal-sign-in`; `server.ts` reads an open session (PORTAL cookie
  only) and sends it on, or to its first visit; `PortalSignIn.tsx` is the container (the proof of work in `pow.ts` only after
  a 429 `challenge`), `model.ts` the rules, `view/PortalSignInView.tsx` the view (DS CodeInput, EndState). Catalogue
  `portal-signin` (+ `ds-words`).
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
  inspections, releases and serials never queue (Home says what waits). A screen that tries the route first falls back to
  the queue through `queue/online-first.ts` (or `enqueue(kind, payload, clientEventId)` itself): the try and the retry are
  ONE client id, because a network failure says nothing of the office (B-W2b-77). The shell's banner counts come from
  `floor/shell/banner.ts`; dev builds expose the queue as `window.__nexusFloorQueue` for the live check (never in a
  production build). One client root (`floor/FloorApp.tsx`, mounted by the group's
  layout) knows the device (`GET /floor/device`) and the operator (`GET /floor/me`), speaks the operator's language
  (else the one picked on the screen, else the tenant's; both catalogues come from the layout), runs the idle sign-out
  and the frame's pop-ups, and sends each state to its screen (no device → enrol; nobody → sign-in; a PIN to choose →
  sign-in; just signed in → the notice when due, else Home). Rules without a screen in `floor/model.ts` (mode from the
  work centre, tiles = mode AND permission, only built pages open; `homeTiles` = every tile, the scan router reads it,
  `tilePage` = what one page shows, B-W2b-73: more than six, a More tile) and `floor/scan/scan-model.ts` (the scan router);
  calls in `floor/api.ts`. A step that builds a floor page sets its tile `built` in `TILE_RULES`.
- `src/floor/moves.ts` (B-W2b-F6) — a floor move with the network gone. A screen moves with `useFloorRouter()` (FloorApp), never Next's `useRouter` (a test holds it). A move needs no network between `FLOOR_PAGES` (Home, every tile, what the frame and the menu open): FloorApp prefetches them whole while online and `experimental.staleTimes.static` keeps that a day; a page once on screen, which Next does not prefetch, stays by its `export const unstable_dynamicStaleTime = 86_400`. `experimental.useOffline` makes Next wait instead of falling back to a full page load (the browser's error page: a kiosk has no reload button). A page the tablet does not hold: `FloorMoves` takes the waiting move back, the frame says why (`frame.moveHeld`). A new floor page joins `FLOOR_PAGES` and exports the stale time. `tasks/scans/left.ts`: what a person typed on Operation comes back with the bundle after a move, and an offline Home offers Continue. No service worker and no offline shell (B-W0-30): a real reload offline ends on the browser's error page. A check of any of this needs `next start` behind a TCP proxy: `next dev` has no prefetch, and Playwright's `setOffline` alone leaves sockets open.
- `src/floor/tasks/myday/` — SCR-171 My day (B-W2b-68; `/floor/myday`, catalogue `floor-myday`): the one floor screen with money, the worker's own, on a tablet other people can see. The figures live in the container's state only (never `AsOfMemory`, a cache, the queue or storage; the only thing kept is the ids of answers opened, for the tile's badge), and leave with another person (`key`), the tab out of view, the network, Done, and 60 s without a touch (the last 10 hide them). It always opens on the PIN.
- `src/floor/tasks/scans/` — SCR-090 Operation, the screen every operator uses all shift (B-W2b-69; `/floor/operation`, catalogue
  `floor-scans`): `model.ts` (W1: counts, report, undo, correction), `timing.ts` (the bundle's clock, what the tablet knows after a
  queued action), `checks.ts` (findings, the quantity rule, steps, lots, why Finish waits), `stack.ts`, `indirect.ts`, `notes.ts`, all
  pure and held by `shift.vitest.test.ts`; `Operation.tsx` the container; `view/` one part per job. Right after the scan the API says
  the rest (`/production/terminal/state`, `/production/guards/check`, `/production/checklists/state`), kept beside the card for an
  offline scan. Finish stays one tap with or without a Start (F3): it makes no call when all good. A timing action, a tile and a stack
  answer at once online (a refusal is a screen) and queue the same action when the network is gone; the report, a tick and a note
  always queue; an override and a picture only exist online (held with the reason). `floor/home/` shows the person's open work
  ("Unfinished on this tablet", `/production/terminal/open`; never carried to the next person on the tablet).
- `src/floor/tasks/cutting/` — SCR-094 Cut a hide (W1 B-W1-40; B-W2b-110 on B-W2b-103's API): the hide check in depth on the card (`model.ts cardCheck`: the office's `checks` with the thickness measured at the table counted in; words from facts in `view/check-words.ts`, never the API's English); a warning no lead passed STOPS the card ("Cut anyway" instead of "+ 1 set"; the size buttons pick the first set); `view/AnywayDialog.tsx` = pop:hidecut.override (what differs, reason tile, lead's badge or name + PIN), online only (`api.ts cutAnyway`, the cut's client id as Idempotency-Key, never queued): the signature records ONE set at once, the rest of the hide queues as before; the photo of the hide (DS PhotoCapture via `view/HidePhoto.tsx`, online upload, the next cut names it) and the thickness pad (it goes with every cut of the hide this visit).
- `src/app/(portal)/` + `src/portal/shell/` — the Portal view's frame (B-W2b-173, SCR-027, SCM-101): `/p/<party code>/…`
  (`p/[party]/layout.tsx`: `GET /portal/me` with the PORTAL cookie only (`shell/server.ts`), the person's own language, the
  company's branding; no session or the first visit's terms due → `/p/signin?next=<the whole address>` (B-W2b-164's page);
  another organisation's address → a gate). `PortalShell.tsx` is the container (the one task list = badges and Home, the bell,
  ONE live channel per tab `GET /portal/live`, the idle sign-out + "Still there?", notices, the pop-ups, keys `/` `?` `g`,
  the unsaved guard, `brandPortals` + comfortable density on `<body>`); `view/` the frame and its pop-ups.
  B-W2b-F16: a session that ends sends `signInHref(next, ended)` (`model.ts sessionEndOf`: the idle clock → `ended=idle`; a 401 before it,
  or the 12 hours → `ended=revoked`); a chosen sign-out sends none. A cut ticket's number (`CT…-YYYY-N`) is read before the carton rule
  (`floor/scan/scan-model.ts isCutTicketNumber`: a free code with `cutTicket`): Home opens Fabric cutting with it at a cutting table.
  `nav/portal-nav.ts` is THE merge point of every portal page: an area/page sets its `built`, a record page its line in
  `RECORD_PAGES` (`/open/<type>/<id>`, the API's links, opens it; else the frame's record page with its Messages). Pages read
  `usePortalFrame()` (session, prefix, `api` that moves the idle clock, `access`, `ask`), fill the band with `usePortalBand`,
  guard typed work with `usePortalUnsaved`, listen with `usePortalLive`, and draw a record's conversation with
  `thread/PortalThread`. Home (`p/[party]/page.tsx`, a merge point of the Home steps) is the frame's task list for now.
  Catalogue `portal` (every partner permission, role, task kind, search group and record type has words: a test).
- `src/portal/customer/account/` — the customer's Account (B-W2b-196, SCR-188, `/p/<party>/account`; catalogue
  `portal-account`): `AccountRoute.tsx` (the gate: a customer with portal.colleagues.view), `AccountPage.tsx` (the container:
  each card reads on its own; profile and e-mail drafts with ⌘S and the frame's unsaved guard; the admin's colleague acts
  behind the e-mail step-up, asked first and again on 403 `stepUp`; Deactivate hands the leaver's assigned requests to the
  chosen colleague first, F14), `model.ts` (pure), `view/` (cards, the two list frames, the pop-ups, `AccountCase` for the
  design review). `RECORD_PAGES.PartyAddress` opens `/account?address=<id>#addresses`.
- `src/portal/supplier/deliveries/` — the supplier's Ship notices (B-W2b-186 on B-W2b-182's API, SCR-227; catalogue
  `portal-deliveries`, CSS prefix `fw-psn-`): `/p/<party>/deliveries?state=&q=` (the list frame, Export N, ⋯ Cancel…),
  `/deliveries/new?po=<id>` and `/deliveries/<id>?step=lines|packing|transport|review` (`NoticePage.tsx`: a draft on its
  four steps, a SENT notice as it stands or — with `step` — being changed; each step writes at its version with one
  Idempotency-Key per body; the sheet is read with `apply: false`, kept with `apply: true`). `model.ts` says every check,
  sheet row and refusal from codes, columns and issue paths (the API's English is dropped by the zod schemas).
  `RECORD_PAGES.ShipNotice` opens `/deliveries/<id>`; the PO record's Ship notices tab has "Announce delivery".
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
- B-W2b-165 (SAL-199) proofs signed with the quote: SCR-099's Proofs section (`links/quote-accept/view/ProofsSection.tsx`: tiles, the end state's list; the accept sends `proofFileIds`), the quote record's Documents › Proofs (`areas/sales/quotes/record/proofs/`, SCR-035-proofs, mounted through `QuoteRecordView`'s `proofs` slot), both on `src/lib/proofs/ProofViewer.tsx` (the DS Modal with a picture or the PdfViewer, Previous / Next, ← →; the DS Lightbox speaks English only) and `lib/proofs/address.ts`. Catalogue `quote-proofs`.
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
  B-W2b-18: the phone card list is ON for every list (leave `cards` out for the defaults; `cards={null}` keeps a table on a
  phone); an `endless` list gets "Show more" on its cards.
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
  frame, CheckList = the DS CheckList over the gate in words, step-up hook + DS StepUpModal, live hook, `qualityCan`, the lot schema);
  catalogues `quality`, `lab`, `register`.
- `src/areas/quality/settings/` — Quality › Settings › Quality rules (B-W2b-118; SCR-260 `/quality/settings?scope=all&rule=<id>|new`, catalogue `quality-rules`): whose rules (this company / every company; a company follows every company where it keeps nothing), Separation of duties and four-eyes (radio cards, the conditions, the customers, the hold release; EditModeBar ⌘S; a looser rule = `model.ts dutiesLooseningsOf` → the confirm in words with the reason → the step-up), Result rules, Who signs always (locked and fixed rules with their why, scans per site, the separations every role keeps), Alerts and escalation (the list frame, the rule dialog, Test: send to me). `RECORD_PAGES.QualityAlertRule`. B-W2b-118 also builds the Severity, Causes and Leather grades tabs of `areas/quality/defects/` (`vocabulary.ts`, `view/VocabularyTabs.tsx`, catalogue `defects-vocab`).
- `src/areas/quality/complaints/` — Quality › Problems › Complaints (B-W2a-65; SCR-113-complaints list, SCR-113-complaint the record; catalogue `complaints`): `?view=new|safety|dueSoon|open|answeredMonth|closed|all` (the tiles = named filters), `?category=` `?severity=` `?mine=1` `?q=`, `?new=1` Log complaint (a scanned serial fills customer, garment, order, shipment through `POST /quality/complaints/preview`; photos after logging through the generic files routes), `?open=<id>` the triage DetailModal (J / K over the NEW queue; Safety asks `ComplaintSafetyConfirm`, which names who is told from `/quality/complaints/people`); the danger safety banner (one at a time, never timed out; Acknowledge = the owner's `quality.complaints.acknowledge`); the record `?tab=complaint|linked|activity` (`?do=ncr|register` from the list's verbs; NCR via POST /quality/ncr from Complaint, repair via POST /sales/repairs {complaintId}); held steps are the API's `held/<CODE>` in words (`held.<CODE>`).
- `src/areas/quality/reports/` — Quality › Reports › Quality reports (B-W2b-138; SCR-147 `/quality/reports?from=&to=&compare=0&by=line|operation|supplier|style&line=`, SCR-147-print `/quality/reports/print` (design tab:qr-pdf, the browser saves the PDF); catalogue `quality-reports`; CSS prefix `fw-qr-`): `api.ts` (the four reads), `model.ts` (pure: address, where each number leads — a list's page only once built (OFFICE_PAGES) and in the role, else the tile says why —, words, chart rows, CSV rows), `ReportsPage.tsx` (each panel reads and fails on its own; live re-read debounced), `view/{ReportsView,Panels,ArrangeDialog}.tsx` (Arrange = the DS PreferencesModal over the panels with the widths in its side slot, saved per person on this device). Groups only: a group too small to hide one person shows no figure (`tooFew`), in words; no person anywhere (ANA-075).
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
  step-up asked first, thread dock; parts.tsx the named stand-ins JourneyStrip, Bridge, DialogFrame and the DS CheckList;
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
  `wip/` W2b (B-W2b-66): `use-floor-boards.ts` (hour by hour, the heat map, stuck bundles, tiles, per site of the top bar's scope; scans re-read at most every 10 s), `api.ts`, `model.ts`, `view/HourlyPanel` (PerformanceGraph per line, "Why was 10:00–11:00 short?" = DS DetailPopover), `view/TargetsDialog` (Set targets, one PUT per day), `view/HeatPanel` (DS Heatmap; a cell's bundles in a Modal), `view/StuckPanel` (list frame); `t` / Open line TV opens `display/` = SCR-173-preview `/production/floor/display?line=` (a WINDOW page). The board itself is `src/lib/line-board/` (schema, rules, `use-line-board.ts`, `view/LineBoardView` on the display tier, catalogue `line-board`): the Floor's `floor/display/` (SCR-173, `/floor/display`, GET /production/boards/display with the device cookie; FloorApp's gate sends a device whose `rules.landing` is LINE_BOARD there, no sign-in) and the Office's preview draw the same view, as the views may share only through `src/lib`.
  B-W2b-130 (the cutting room board and yield; catalogue `production-cutboard`): `wip/cutting/` = Floor now's Cutting room (fn-cutting, last section; `use-cutting-room.ts` GET /production/cutboard per site of the scope, production.cutting.view only; live cut_order.* / cut_ticket.* / lay.* / cut_consumption.* / production.cut_logged at most every 5 s; a number opens the cut order's record, a work order its Cutting tab); `reports/yield/` = Production reports' Cutting and yield (prr-yield, `?yield=7|30|90` days ending on the report's day, read once the daily answer names the day); `work-orders/record/leather/` = Materials › Leather (the shade lots and the one shade lot rule, every state); `work-orders/cutting/{api.ts,view/HidePhoto.tsx}` = the cut log read with photoFileId / measuredThicknessMm and the entry's hide photo (GET /files/:id/preview, skipped without files.read). Never a cutter in any of them.
  `dispatch/` (B-W2b-56) Production › Dispatch (SCR-138 `/production/dispatch?site=&line=&date=`; catalogue `dispatch`, plus `board-kit`): ONE read `GET /production/dispatch/board`, a card per line (LoadBar + the design's words, its stations with who works there, Assign, Reassign, Print: the DS lane head holds text only), the DS PlanningBoard `layout="columns"` (stations = lanes, Not assigned = the tray, one bucket; the columns wrap by app CSS). A moved card keeps its board id through `aliases` (model `boardIdsOf`) so the DS's Undo finds it; the API's `undo` bodies are kept in step with the DS history and posted back as they came; a dialog's move has its Undo in the notice. A warned person or move asks the reason on 409 `refusal/OVERRIDE_REASON_NEEDED` and sends again. Words from codes and figures, never the API's `words`. `print/` = SCR-138-print `/production/dispatch/print?line=&line=&station=&date=` (a new tab; no line named: every line of the site, the band's Print). Names only beside a station or a card, as the board brings them; no figure by person.
  `reports/` (B-W2a-38) Production › Reports › Production reports (SCR-240 `/production/reports?site=&date=`: band with ⋯ Email me / Print, Daily production tiles + PerformanceGraph bars per lane + a SummaryTable per lane by style and size; `view/SubscribeDialog` = pop:prr-subscribe; `print/` = SCR-240-print `/production/reports/print` in a new tab; catalogue `production-reports`, also Floor now's `wip/view/LinesPanel` (fn-lines: a card per line sets `?line=`, [ / ] step)). Never a person: per line, work centre, style, size; per station only signed in / machine down (F2).
  `labour/` (B-W2b-57) Production › Floor control › Labour & corrections (SCR-139, SCR-143 as one inbox, `/production/labour?kind=&line=&q=&open=<KIND>:<id>&state=&from=&to=&editKind=&editFrom=&editTo=`; catalogue `production-labour`): the legal band first (`legalRowOf`: the site's recorded basis + the API's own reading of the gate, `GET /people/privacy/what-you-see`; the page never reads a gate itself), the tiles = the API's `kind`, ONE queue (corrections, disputes, off-standard blocks, ready line days; a kind's decision goes to its own route), Line days (close, reopen with a reason), Changes to labour records, the Daily sheet (`POST /production/labour/sheets`; its figures live in the dialog's state alone). No person in a list, filter, group or total: a name only inside one record, where the API served it behind the legal gate; the scans' correction read names people with no gate, so its schema does not read them.
  `bundles/` (B-W2b-59) Production › Cutting room › Bundles (SCR-259 `/production/bundles?stuck=true|place=LINE|status=VOID|view=all&q=&check=&checkLine=&checkOp=`: the views ARE the API's filters, Floor now links `?stuck=true` and `?place=LINE`; tiles, the scan-pattern checks with the bundles behind a count, review, "Show who" = one finding, production.bundles.who, the names held by the dialog alone; the record SCR-259-record `/production/bundles/<id>?tab=progress|scans|quality|ticket`, Void bundle, Reprint; `ticket/` the ticket PDF tab; catalogue `production-bundles`). `work-orders/every-shift/` (B-W2b-59; catalogue `production-every-shift`): Release N = the review over `POST /views/bulk/preview` with listKey `production.work-orders.release` and each row's blockers, the rush flag (`?rush=true`, Edit N, the record's facts), Split work order (`use-split.ts`, a DRAFT), Documents (`?tab=documents`), Minutes on Labour & cost, `traveller/` the traveller's tab (`/production/work-orders/<id>/traveller`, `/production/work-orders/travellers?ids=`: a plain link cannot send the company header, so a page reads the PDF).
- `src/areas/people/shifts/` — People › Main › Shifts (B-W2b-60; SCR-263 `/people/shifts?span=month&from=&to=&line=&team=&open=<request>&overtime=1`, SCR-263-print `/people/shifts/print`; catalogue `shifts`; CSS prefix `fw-rs-`, `fw-sh-` is Shipments'): `api.ts` (every call, zod: the API's English `words` dropped; warnings are said from rule + figures, `warningWords`), `model.ts` (pure: address, range, sheet rows site › line › team › person + a foot row per line, what a key / the fill handle / Set shift writes with the reason a cell is left out, undo only while a cell holds what our edit wrote, overtime verbs held in words), `use-roster.ts` (THE write path: every edit is planned cells, sent in order with each cell's version at its turn, marks, undo stacks; a quiet read after a save brings a neighbour's warning and the foot rows), `use-overtime.ts`, `use-dialogs.ts`, `view/RosterSheet.tsx` (DS GridSheet + NexusGrid in read-only edit: edits arrive through `cellEditRequest`, gathered per tick into one write; keys in the footer's one icon), `view/ShiftCell.tsx` (the area part), `view/ShiftDialogs.tsx`, `print/` (a page per line for the notice board: a shift or the day off, never an absence, overtime or warning). A phone shows one day, a card per person.
- `src/areas/people/piecerates/` — People › Skills & pay › Piece rates (B-W2b-62; SCR-158 `/people/piecerates?tile=&rates=all&q=&open=<version>&period=&resolve=&entry=&ledgerPeriod=&ledgerLine=&ledgerKind=&held=all`; the legal switch first; the sections about people exist only once the site's switch has been on), `sheet/` (SCR-158-rate-sheet, a print tab), `statement/` (SCR-158-statement, the PDF tab: a POST, each opening recorded), `record/` (SCR-085-pay, slot `pay` of the employee record). Catalogue `piecerates`, CSS prefix `fw-pr8-`. A list names nobody (Owner answer W1): a person opens as one record, a statement only on the person's choice.
- `src/areas/people/attendance/` — People › Main › Attendance (B-W2b-61; SCR-157 `/people/attendance?month=&team=&line=&tile=&status=&anomaly=&manual=1&open=<day>&entry=<overtime entry>&new=1&close=1`; new tabs SCR-157-rollcall `/people/attendance/roll-call`, SCR-157-lul `/people/attendance/lul?close=`, SCR-157-timesheet `/people/attendance/timesheets/<id>`; Employee › Attendance `employee/`, SCR-085-attendance, `?tab=attendance&month=&day=`; catalogue `attendance`; CSS prefix `fw-at-`): the site's ATTENDANCE gate is read FIRST (`readSight`) and anything refused with `gate/ATTENDANCE` drops the page to the reason in words (`GateHeld`): nothing of a person is read or kept. `api.ts` (every call, zod: the API's English `words` dropped), `model.ts` (pure: address, tiles → the API's filters, clean days, what a fix or manual entry sends and why it is held, every code and figure in OUR words), `use-attendance.ts` (the lists, the tiles, the close, who is in), `use-day.ts` (ONE hook for a day: Approve, Fix a day, Accept, Reopen, Correct; the page and the employee tab share it and `view/DayDetail.tsx`), `view/` a panel per section. A list carries no name and no minutes (Owner answer W1): those open one record. A lead (no people.attendance.view) reaches the page at its address: who is in, the roll call, their timesheets, days and states only.
- `src/areas/people/skills/training/` — People › Skills & training, the training part (B-W2b-146 on B-W2b-133/139's API; lenses `?view=matrix|courses|needs|instruction`, `status=`, `course=<id>|new`, `need=role:<id>|class:<id>`, `entries=`, `tq=`; catalogue `people-training`, CSS prefix `fw-tr-`): the matrix's Safety column group (DueCells, Held machines, training tiles, a course cell's popover), Course catalogue (Course pop-up with "N due dates would move", Start from the standard list with the hours typed), Who needs what (counts; names inside one role or machine type; a machine type's courses), Instruction register, Record training (given elsewhere, or closing a floor sign-off session), the windows SCR-160-certificate `/people/skills/certificate?record=&person=` and SCR-160-due `/people/skills/due`. A safety reader without people.skills.view opens the page on the catalogue (alsoOpens). `constants.ts` keeps the API's lists: the domain's safety rule files reach `node:crypto`, never import them in a browser module. Employee › Safety is `src/areas/people/employees/record/safety/` (SCR-085-safety: role sheet, PPE, fitness behind ProtectedValue — the values on Show only, recorded by the API, kept in the tab's state —, incidents not served yet); Employee › Skills & training's training sections are `skills/record/training/` (SCR-085-training).
- `src/areas/people/efficiency/` — People › Skills & pay › Efficiency (B-W2b-64; SCR-161 `/people/efficiency?from=&to=&line=&style=&compare=1&day=&open=<routing operation>`, SCR-161-print `/people/efficiency/print`; catalogue `people-efficiency`; CSS prefix `fw-ef-`): `api.ts`, `model.ts` (pure; never a person key), `EfficiencyPage.tsx` (the privacy note is read FIRST, nothing else until it is ready; each section reads and fails on its own), `use-review.ts` (the DetailModal at `?open=`; J / K are the DS's, keep is ⇧K, C change, I investigate; `basedOn` = the last decision read), `use-person.ts` (one person's figures: in this hook's state ONLY, offered only when `individual.available`), `view/ArrangeDialog.tsx` (the DS PreferencesModal over the sections, shared with People reports). `src/areas/people/reports/` — People › Reports (B-W2b-64; SCR-264 `/people/reports?month=&to=&group=&team=&earnings=`, SCR-264-print `/people/reports/print`; catalogue `people-reports`; CSS prefix `fw-prp-`, section parts from `efficiency.css`): attendance per line or team with the match check, earnings per line or month, per worker only with the right (a recorded POST, in the page's state only: no address, file or print), Send report built and held in words (no link carries a report yet; pay never reaches a link).
- `src/areas/people/payroll/` — People › Skills & pay › Payroll export (B-W2b-63; SCR-159 `/people/payroll?year=` Exports, the wizard `?new=1` / `?month=&step=period|checks|mapping|preview|send&layout=`; SCR-159-record `/people/payroll/<id>` Past export, `RECORD_PAGES.PayrollExport`; SCR-159-file `/people/payroll/<id>/file?kind=summary|data` the new tabs; catalogue `people-payroll`, CSS prefix `fw-pay-`). Nexus does not run payroll: it makes a file for the labour consultant. By employee code, never a name. `api.ts` drops the API's English (`words`, `reason`, `toConfirm`): the screens say their own words from codes (`check.<CODE>.*`, `confirm.item.<n>` by the position of `PAYROLL_TO_CONFIRM`, held equal by a test). "Show me", the preview and an export's values are recorded POSTs on the person's click: their names and figures live in the page's state alone and leave with the dialog or the step (no saved view, `listKey={null}`). `model.ts` `placeOf` links a check's fix only to a page in OFFICE_PAGES, so Attendance and Piece rates link by themselves once built. `use-export-dialogs.ts` = Send, Make correction, Cancel draft, used by the list, step 5 and Past export. Code mapping: the list frame with `ProviderEditor`, a cell editor that saves on blur (the frame has no `stopEditingWhenCellsLoseFocus`). A provider layout nobody confirmed is a warning on every screen that shows it (`LayoutWarning`), never a hold.
- The buying office (one catalogue `buying`; shared parts `areas/_shared/buying/`: abilities with the cost grain, words for
  problems and quantities, live hook, sites from `/inventory/locations`, layout CSS, made-up fixtures): `areas/planning/mrp/`
  What to buy & make (SCR-055: `?site=` `?view=` `?q=` `?line=` the Why detail; one-click Draft PO with Undo, Draft POs per
  supplier, Set aside), `areas/purchasing/orders/` (SCR-058 list `?view=`/`?status=`/`?waitingOver48h=true`/`?new=1`; SCR-059
  studio `?tab=lines|answer|receipts|documents|activity`, the shared send dialog through `model.ts sendModelOf` with the PDF from `…/preview` (cost grain), the
  supplier's answer and the buyer's accept/refuse), `areas/warehouse/receipts/` (SCR-063 list `?view=expected|posted|today|
  waiting|reversed|all`, the receiving page `/warehouse/receipts/new?order=&lines=` posting the whole receipt at once with the
  hide entry sheet (SCR-061), the receipt `?tab=lines|lots|activity` with its lots and quality state (SCR-062) and Reverse).
- `src/areas/warehouse/receipts/inbound/` — B-W2b-182 (SCM-110) the inbound board on Warehouse › Receipts (SCR-063-inbound; catalogue `warehouse-inbound`, CSS prefix `fw-ib-`): `InboundBoard.tsx` (GET /inventory/receiving/inbound for the top bar's site, live ship_notice.* / receipts / purchase_order.*, the dock note), `view/InboundBoardView.tsx` (a DS BoardView per site, 7 day columns; `InboundMenu` = the page's ⋯ "Inbound board on / off", kept per device), `model.ts` (cards, lanes, `draftFromNotice`: the receiving page's `?notice=` fills the form from the notice and Post sends `shipNoticeId`).
- `src/areas/planning/leather/` — Planning › Leather & cut plan (B-W2b-132; SCR-252 `/planning/leather?site=&tile=&feas=&q=&open=<need row>`, SCR-252-print `/planning/leather/print` a new tab; catalogue `planning-leather`, CSS prefix `fw-lp-`): three reads, each its own section (need per order with one shade's answer, certified protectors, planned vs actual yield); the tiles are saved filters; the shade drawer (DetailModal, J / K) offers reserve / split by garment (POST /inventory/reservations), Draft PO (What to buy & make's POST /purchasing/from-plan) and a note for Sales on the order's thread; Accept (ActionConfirm) / Dismiss (reason) the cutting loss proposal. Values only with money.cost.
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
  B-W2b-102 (`depth.ts`, `view/{MediaParts,ProgressParts,CloseBody}.tsx`): a photo or voice note with the report (kept in the page,
  sent to the request the queue's receipt names; the voice recorder is composed), "Reported here" and one report's progress
  (`GET /plant/floor/requests[/:id]`; Seen / On my way / It works through `stepOrKeep`: online first, queued as
  `plant.request.progress` under the try's id, its key `<device>.<id>`), the technician's queue, the line lead's confirm, the
  one-screen close (factory-domain plant/jobs/close tiles), files opened through `GET /plant/floor/files/:id/download`;
  `INCIDENT_PAGE` in depth.ts opens Report an incident with the machine passed on (`incident/handoff.ts`, B-W2b-137).
  B-W2b-137: `floor/tasks/incident/` (SCR-230, `/floor/incident`, tile `incident` on every station mode, a line tablet and a phone,
  kept on Home's first page with the Line view and Scan anything; catalogue `floor-incident`; on the API of B-W2b-125): someone
  hurt first (112 is factory-domain's EMERGENCY_NUMBER, so it shows before any read; the site's first aiders from
  `GET /safety/floor/incidents/start`; the call for help in one tap = the station's Safety call, else its team leader's, queued as
  `andon.call.send`), then What → Where ("Here: this station" first) → Send, three taps (the DS ReasonGrid moves on by a tap or
  Enter, never by an arrow). With the name: the queue's `safety.incident.report` FIRST, not an online try (the API hashes the
  report's time, so a try and a queued retry of one id would be refused as a reused id). Without the name (a near miss or a
  hazard naming nobody): online only, one key kept until answered, held in the page with the network gone, never stored.
  "Seen by safety" from live `incident.seen` + a beat; photos (≤ 4, 30 minutes) after the office names the incident.
  B-W2b-145: `floor/tasks/training/` (SCR-231, `/floor/training`, tile `training` on every station mode and a lead's line tablet;
  catalogue `floor-training`; on the APIs of B-W2b-139 and B-W2b-134): two tiles, then one job per screen. Training attendance = the
  site's open sessions (one opens at once) → a badge (its owner named first by `POST /safety/floor/training/instruction/pending`) or
  a name from the tablet's list → the person's own PIN signs (DS PinSignBlock) → the list fills; the trainer answers each person's
  language check, then countersigns with their PIN. Receive PPE = badge or name → the kit's missing items prefilled → item (tile or
  its code) → size (a tap finishes the item) → how many → the person's PIN signs the receipt. ONLINE only (a PIN is never queued);
  a 401 on a signature is the badge or PIN unless `GET /floor/me` says the session ended (`api.ts signedOrWrong`). Closed or
  cancelled in the office: signing stops with the reason (live hints + a 30 s beat).
  B-W2b-105: `floor/tasks/inline/` (SCR-176, `/floor/inline`, tile `inline` at the inspection bench and a lead's line tablet,
  quality.inprocess.record; catalogue `floor-inline`; on B-W2b-99's API): the line and its DHU today on top, Which check? (four tiles,
  the site's first pieces waiting); First piece = scan → which operation waits → the plan's checks (DS FloorChecklist, key
  measurements with DS QuantityPad + LimitMeter, the verdict by the numbers) → Approve or Reject with the PIN (DS PinSignBlock, ONE
  key per signature); Cutting and First piece online only; Roving and an end-of-line Pass online first, queued as
  `quality.inprocess.record` (the try's key = `<device>.<client event id>`); Send back = the check charged to an operation, then the
  rework loop (OTHER, else the reason asked), online only. Operation's first-piece hold: `tasks/scans/first-piece.ts` (the card's
  `firstPiece`), Finish/Start/Resume held, `use-first-piece.ts` lifts it live; the reason picker's `cause` = "Which operation caused
  it?" (`causedAtOperationId` on each scrap / rework line; Not known by default).
  B-W2b-109: the final bench on its plan, `floor/tasks/final-inspection/plan/` (SCR-097's W2b cases `w2b-*`, catalogue `floor-final-plan`; on
  B-W2b-97's and B-W2b-106's API): an inspection whose W1 read has `planVersion` reads its sheet (`GET …/sheet`) and runs the bench — a
  strip of sections (AQL sample = DS AqlCounter, "+ one piece" and the `+` key, a class's + asks which FINAL defect, − and + per defect line;
  Checks = DS FloorChecklist by class, a fail asks a FINAL defect and, where the plan asks, a photo; Measurements one point per step with DS
  QuantityPad + LimitMeter; Serial or batch = DS ScanInput; Photos = DS PhotoCapture in the slots) — every write ONLINE FIRST as one
  `quality.final.record` payload (`plan/api.ts recordOrKeep`: POST /quality/queue/record, the same payload queued under the try's id; a kept
  write moves the sheet at once, `model.ts applyKept`); photos and the PIN signature (DS PinSignBlock, `decide` with no checklist) online
  only, the signature held while the tablet still holds writes of it. Start opens on the plan that applies (`readPlans` with the lot: the
  sample and Ac/Re from the API, never computed here); a lot, batch, bundle, serial or carton label (or a code that is no work order)
  goes to POST /quality/queue/scan (QHS-065; CHOOSE lists the open inspections). My work's inspector queue, `floor/tasks/mywork/inspections/`
  (SCR-089 `w2b-insp*`, catalogue `floor-myinspections`): GET /quality/queue?scope=mine, the list at an inspection bench (a For your work
  tile elsewhere), a row's card opens the final bench or In-line with its code; the offline pack (GET /quality/queue/offline) keeps my
  open final inspections' models for the visit (`keepModel`, by id and by number).
  B-W2b-121: `floor/tasks/fabriccut/` (SCR-182, `/floor/fabriccut`, tile `fabriccut` after Cut a hide at a cutting station, production.cut;
  catalogue `floor-fabriccut`; on the APIs of B-W2b-112, -116 and -117): the ticket (scan or a row of GET /production/cut-tickets/waiting →
  the card: ratio chips, plies big; Start cutting = POST …/start) → Spread (GET /production/lays/:id; a roll scanned = one pad, four figures:
  plies — default what the lay still needs, untouched = left out so the office takes what the roll gives —, splices, end loss and the roll
  end back in metres; a roll the lay has starts at its row; the same roll scanned again = Add; Undo last roll) → Check (both ends start at
  the plies spread; a difference is the hard stop "Left 24, right 23", never sent) → Cut (FloorElapsed since the start; the ticket scanned
  again or Cut done = POST …/finish) → Ply stickers (POST /production/lays/:id/ply-runs, DS LabelPreview with the job's state) → Fabric used
  (estimate, lay report, the pad; `{}` confirms the report's figure, a typed one is sent in metres). Beside it: Recut tickets (GET
  /production/recut-tickets/waiting, a card's Start / Done / Print) and Send to sewing (trolleys: scan the label → bundles → Send N bundles
  to line X; at a line's station the same label → Received with the bundles named missing; a bundle whose secondary process waits gets
  its one tap). Online first, kept as `production.lay.roll|undo|count` and `production.trolley.load|unload|send|receive` (the try's key
  `<device>.<client event id>`; `model.ts applyKept…` moves the lay on screen); the start/end scans, stickers, fabric used, recuts and
  process taps online only. Refusals in its own words (`model.ts KNOWN_REFUSALS`, held against the domain lists by its test).
  B-W2b-115: `floor/tasks/incoming/` (SCR-175, `/floor/incoming`, tile `incoming` at the inspection bench, before Final inspection so it
  stays on Home's first page; quality.incoming.record; catalogue `floor-incoming`; on B-W2b-98's, -111's and -106's API): scan the lot (a lot,
  a hide tag or an inspection number → POST /quality/queue/scan, stage INCOMING) or a row of the site's open ones; one FloorCard with the
  sample and its bar; a strip of sections — Hides (scan → shade → Accept; grade, the area against the tannery's, the composed HideMap in
  `view/HideMap.tsx`), Fabric rolls (4-point counters, width and length, points per 100 sq yd), Armour, zips, hardware, the defect counter,
  the plan's checks (DS FloorChecklist + the shared MeasureStep), Decision (three pads, a workshop's bundles; held with every reason in
  words, `model.ts decisionHeld`; an override is the office's) → the PIN (DS PinSignBlock). A hide and the checks go ONLINE FIRST as
  `quality.incoming.record` (`api.ts recordOrKeep`; a kept write moves the record, `model.ts applyKept`); rolls, components, the counter,
  opening and signing online only. The plan checks' rules and the measure step are shared (`tasks/shared/plan-checks.ts`,
  `tasks/shared/view/MeasureStep.tsx`; In-line re-exports them). floor.kits' receipt says the goods go to that inspection first.
  B-W2b-140 (the office side of requests and jobs in depth; `areas/plant/requests/depth/` = api (the depth reads extend W2a's
  schemas, which drop unknown fields), model (pure: Age tone by escalation, Routed to, the merge's group / target / sources —
  a locking request never into another request —, Lock as unsafe, progress, the trail, the close's tiles, the lead), made-up
  fixtures, depth.css): SCR-148 the locked machines first (`GET /plant/requests/locks`, one banner each), Possible
  duplicates + Merge requests (`POST /plant/requests/merge`, the ONE merge path: D and "Merge into this" open it), Lock as
  unsafe (L), what the reporter sees (On my way, It works again), photos and voice notes (`view/MediaList.tsx`); SCR-149 the
  Hand back dialog (board drop, the record's primary, `h`; `jobs/view/CloseForm.tsx` is the ONE close form, also the tab),
  the record's Unsafe lock panel with Sign safe (`requests/view/SignSafeDialog.tsx`, the ONE sign-safe dialog), the Photos
  tab (plant files routes, before / after), Line lead confirms. The containers sit inside `PlantMessages` (they speak too).
  B-W2b-142 `preventive/` Preventive & statutory checks (SCR-266 `/plant/preventive?view=&month=&day=&due=&ended=&missing=&outcome=&plan=
  &result=&new=1&record=1|<plan>&corrects=&move=&date=`, catalogue `plant-preventive`, CSS prefix `fw-pv-`; on B-W2b-124's API): tiles, the
  calendar (the shared CalendarView with its optional `move` prop: a due check drags onto a day → Move a check) | List, Plans (`plant.preventive`,
  Move N), the check register (`plant.preventive.register`, its export source, Print N / Export N), New plan, Record a check result (the job and
  the lock in ONE call, then the report files), the Plan and result windows, Move a check; new tabs `register/` (SCR-266-register-print) and
  `report/` (SCR-266-report: the PDF, Keep in the register, the DocumentSeal). `RECORD_PAGES.MachineCheckPlan|MachineCheckResult`.
  B-W2b-136 machines in depth (`machines/depth/`, catalogue `plant-machines`, CSS prefix `fw-md-`; `machines/dies/`, catalogue `plant-dies`,
  its own section and API module so it drops in one cut if there is no clicking press): SCR-150 gains the section switch
  `?section=machines|dies|wall`, the tiles Checks overdue / No CE declaration on file as filters (`?need=checks|ce`, `GET
  /plant/machines/attention`), the columns Next check, CE on file, Tag printed (`GET /plant/machines/depth?ids=` for the rows on
  screen), Print QR tags (`depth/use-tags.ts`, the ONE tags hook for the band, the bulk bar, `t` and the Tag tab: a label printer,
  one print job per machine, Retry; Print on paper = the W2a tag sheet) and the StatusWall area part (`depth/view/StatusWall.tsx`,
  also the window page SCR-150-wall `/plant/machines/wall?site=&show=`). SCR-150-record gains Documents & CE (`?tab=docs`),
  Status & downtime (`?tab=status`: a DayStrip per day of the week), Tag (`?tab=tag`) and Change status (⋯; a release from
  do-not-use asks the technician's fresh code through the plant's `useStepUp`, words in `depth/view/ReleaseStepUp.tsx`).
- `src/areas/plant/incidents/` — Plant › Health & safety › Incidents (B-W2b-149 on B-W2b-125's API; catalogue `plant-incidents`,
  CSS prefix `fw-inc-`): SCR-210 `/plant/incidents?rows=INJURY|NEAR_MISS|HAZARD|INAIL_DUE&status=&from=&to=&q=&new=1` (the band's
  live chip = `counts.next`, the critical Banner + Countdown = `counts.deadline`, tiles = filters, the ANONYMISED list frame
  `plant.incidents` — its export source reads the list, no person; "Show people" = one recorded `POST /safety/incidents/people`
  in the container's state only, after a PrivacyNote; Mark seen N; Report an incident `c` with the DS PhotoCapture), the record
  SCR-210-record `/plant/incidents/<id>?tab=report|actions|authority` (marked seen once for a manage holder; People and the
  filings behind the recorded `…/open` reads — ProtectedValue; Make a job / Add to improvement plan in one step; Record INAIL
  filing `f`, Close held while an action is open or a filing waits) and SCR-210-print `/plant/incidents/print` (a window page,
  anonymised). `RECORD_PAGES.Incident`, search type `Incident`. The record frame is the plant's (`_shared/parts` RecordFrame).
  B-W2b-141 (Plant settings' W2b sections, SCR-241 + SCR-241-audit; `areas/plant/settings/` `depth-api.ts`, `depth-model.ts`
  (pure: rule drafts and bodies, the worked example in words, order, H1-held lock choices, check type rules, refusals),
  `use-depth.ts` (the container hook beside the W2a one), `view/{RoutingCard,LockCard,CheckTypesCard,IncidentsCard}.tsx`,
  `_demo/fixtures.ts`): Request routing and escalation (list frame `plant.settings.routing`, the rule dialog with its example,
  Where does a request go?, Move up/down = ONE `…/order`), Unsafe lock (EditModeBar; H1's other choices held; hazard report off →
  StepUpModal), Statutory check types (list frame `plant.settings.checks`, the type dialog; no interval offered), Incidents (read
  only, the API's law numbers), the band (site, SaveStatus, ⋯ History → `/plant/settings/history`). Each card's `c` is its own
  while the focus is in it; on the page `c` stays New symptom. `?rule=` / `?type=` open the dialogs (RECORD_PAGES).
- `src/areas/plant/health/` — Plant › Health & safety › Health surveillance (B-W2b-148 on B-W2b-135's API; catalogue `plant-health`,
  CSS prefix `fw-hv-`): SCR-212 `/plant/health?tile=&status=&type=&jstate=&judge=1|<visit>&planVisits=1&visit=&judgement=&plan=` — the
  protected page reads its note FIRST (`GET /safety/health`: privacy words, live use, tiles as counts) and nothing naming a person
  before it is on screen; the due list (`POST …/visits/list`, every read a recorded LIST: live changes wait behind "N updates · Show"),
  the judgements ANONYMISED until Show (the chosen rows or the page's, said first: one OPEN view per row; values in the container's
  state only), the plans per role (no person; Edit for safety.health.plans). Mark booked, Record a judgement (`j`; medical words held
  with factory-domain `clinicalWordsIn`), Plan visits (`p`; proposals are a recorded read; by hand for HR only: the staff list is
  safety.organisation.manage), a visit's and a judgement's window (each a recorded read), Who looked (DS DetailPopover, HR and the
  DPO). New tabs SCR-212-visits `/plant/health/print?visits=` (the doctor's list, a recorded PRINT) and SCR-212-copy
  `/plant/health/copy?judgement=&file=` (a COPY view, the bytes in the tab's memory; generic title). The safety officer and a
  views-only DPO open the page through `alsoOpens` without its person sections. Names and values never in the address (ids only),
  browser storage, a saved view (`listKey={null}`), an export or a search index. `RECORD_PAGES.HealthVisit|FitnessJudgement|HealthPlan`.
- The stock screens (catalogue `stock` shared + one per page; shared parts `areas/_shared/stock/`: api (every inventory read and
  write, zod), model (abilities with the cost grain, words for API faults, units never added across, leather's two numbers
  and both area units, state tones, `movesHref`), parts (pills, Qty, Dual, NoAccess, ReadFailed), made-up fixtures):
  `areas/warehouse/stock/` (SCR-060; `adjust/` the ONE Adjust stock dialog), `moves/` (SCR-064: the why panel, the ledger
  as ONE long grid = ListFrame `endless`, the move's DetailModal `?open=`, reverse), `hides/` (SCR-200 + record), `lots/`
  (SCR-201 + record: stock, trace both ways, moves; release/block/reject stay in Compliance › Tests & substances, linked),
  `locations/` (SCR-065 + record); `areas/production/settings/` (SCR-074: who floor records name, its legal basis, step-up
  when widening); `areas/admin/privacy/` (SCR-086: duties, notices, DPIA, register; sample texts said on screen);
  `floor/tasks/labels/` (SCR-096, `/floor/labels`: garment labels behind the certificate gate; online only).
  B-W2b-70: `floor/tasks/help/` (SCR-172, `/floor/help`, catalogue `floor-help`; the frame's Help button opens it once someone is
  signed in: one tap queues `andon.call.send`, the open call with who is coming, `andon.call.answer` closes it) and
  `floor/tasks/lineview/` (SCR-168, `/floor/lineview`, catalogue `floor-lineview`; a LINE tablet of a team leader lands on it,
  `store.landing`: line totals, calls, Waiting for you, stations, handover note, scan on behalf; per station only a call, a
  machine down, material and "nobody signed in", Owner answer F2). B-W2b-83: corrections of a report join Waiting for you (old →
  new counts, no name); the row opens its one record (who took the scan where the scan names one, why it is asked), read for that
  decision; a correction asks the API before the PIN pad, so its refusals come first; approve and refuse both sign.
  B-W2a-76: `floor/tasks/returns-in/` (SCR-180, `/floor/returnsin`: scan the RMA → parcel condition + photos → lines by serial/batch
  scan or tap → ONE receipt, photos onto it → grade per garment (suggestion = factory-domain suggestedOutcome; the office
  decides) → the inspection place scanned) and `floor/tasks/kits/` (SCR-181, `/floor/kits`: Send a kit = ticks by scan,
  held while incomplete, the DDT's facts, send + the DDT PDF full screen with Print; Receive back = bundles by scan,
  reject/scrapped with a REWORK reason, material back) on the floor routes `/purchasing/subcontracting/kits…`; both online
  only for the write; each view wraps its catalogues (+ reason-kit, photo-kit, shell for the PDF words) in WithMessages.
  B-W2b-67: `floor/tasks/clock/` (SCR-170, `/floor/clock`, tile `clock`, catalogue `floor-clock`, open with nobody signed in: a kiosk): your time today, Break, a badge scanned here clocks at once (POST /people/clock/scan), Forgot your badge, Clock out? with open work, closed in words while the ATTENDANCE gate is off (`GET /people/clock/tablet` asks it with nobody signed in). Offline the signed-in person's taps queue (`people.clock.record`); a badge at a kiosk waits sealed in `kept.ts` (AES-GCM, a key the browser will not give out; gone once sent; `store.kept`). The API's words are English: the screen composes its own from the fields. `sign-in/`: the crew (`CrewStrip`, in the frame through `frame.crew`; `store.crewStep`; `store.crewLeft` after the active one leaves), the welcome cards after a sign-in (`Welcome.tsx`, `arrival.ts`; `store.arriving`, `store.arrived`: handover note, Continue bundle). `enrol/`: the kiosk step with its honest check, the mode the office chose. `areas/admin/devices`: the enrol wizard picks the mode; a device's record changes it while nobody is signed in. Read aloud on the notice and the reason picker (`speechLang` of the language on screen).

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
  `shell:`-style message keys; each row's `permission` is the one its page's API needs; a page more rights open names them in
  `alsoOpens`, by row id, B-W2b-73: it gives no right). The rail, sub-sidebar, crumbs,
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
  Tailwind. The DS parts that SPEAK (Modal, DetailModal, StepUpModal, ReviewChangesModal, EditModeBar, ConfirmPhraseField,
  DateField, DateTimeField, Textarea, Timeline, AsOf, FileRow … the list in the file) come from `src/lib/i18n/ds-parts`
  (B-W2b-18): the same DS part with its `labels` from `ds-words.json` in the page's language; a screen's own words win.
  The B-W2b-09 parts with their own entry point (CheckList, TraceTree, charts) take `labels={useDsWords().x}`. App CSS is layout only, with semantic `--nds-*` tokens (no raw colours). A server component never imports a
  DS barrel (it holds client components): render a client component.
- `import.meta.glob` (Turbopack and Vitest): a pattern outside the calling folder needs `base` (`{ base: '../../areas' }`
  with `'./*/nav.ts'`); the keys differ between the two, so read only the last path parts.
- `tsconfig.json` has `noUncheckedIndexedAccess: false`: tsc checks the DS source this app compiles, and the DS is not
  written for it. `vitest.config.ts` compiles the DS's JSX (`oxc`), as the Commerce web's does.
- Environment only as `process.env.FACTORY_…` (`scripts/factory/check-env-loader.mjs`).

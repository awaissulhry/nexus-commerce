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
- `src/links/<task>/` — a one-off link's task page, in the Links view (`links/quote-accept`, SCR-099: the link landing
  opens it for a QUOTE_ACCEPT link with the same client; the token stays in its header; `links/deposit-pay`, SCR-199:
  a DEPOSIT_INFO link's deposit to pay by bank transfer, each field with Copy). `src/areas/_shared/` — Office
  parts several areas share (`document-send`, SCR-037: the send dialog any document uses; the host passes its words).
- `src/list-frame/` — the ONE list frame of every Office list with actions over many rows (Owner rule 2026-10-29):
  `<ListFrame rows rowId columns count search tools right selection updates more keys onHelp onOpen state />` — the DS
  grid (NexusGrid in GridCard), toolbar count/search ⇄ bulk actions while rows are selected, the header select-all box
  (mixed when some), shift-click range, keys `/` j k x Enter Space ?, a footer with Show more and ONE keys icon
  (`ListKeysInfo`; never key hints above a table). Its words are `messages/<locale>/lists.json`; lab: `/design/list-frame`.
- `src/record-panels/` — SCR-006, the panels every record page mounts: `<RecordPanels record={{ type, id, companyId,
  siteId }} title party />` (thread, files, history; live refresh from `/live`). A screen with its own catalogue wraps its
  view in `WithMessages` (record-panels/i18n.tsx): the layouts load `shell` only.
- `src/areas/quality/` (Inspections SCR-075, the record SCR-076 with its release, reversal and quality-rules dialogs, the
  evidence trail `/compliance/evidence/<batch|serial>/<subject>`) and `src/areas/compliance/` (Tests & substances SCR-054:
  lots, Cr VI results, the lot release; PPE register SCR-113): their shared parts are `areas/quality/_shared/` (record
  frame, check list = the gate in words, step-up hook + DS StepUpModal, live hook, `qualityCan`, the lot schema);
  catalogues `quality`, `lab`, `register`.
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
- `src/areas/finance/` — Finance (area order 11, Italian "Contabilità"; SCR-080 … SCR-083): `_shared/` (api.ts every call + zod,
  model.ts the pure rules — saved views ⇄ address = the API's own `?status=` `?docType=`, journey, next step held with its
  reason, the checks in words with where to fix, payment state, placement oldest first, CSV, problems —, hooks.ts live,
  step-up asked first, thread dock; parts.tsx the named stand-ins JourneyStrip, CheckList, Bridge, DialogFrame;
  placement.tsx = MatchPanel), `invoices/list` (Shipped, not invoiced + All invoices: two list frames), `invoices/record`
  (`?tab=lines|money|sdi|documents|activity`; issue = P1 confirm then send; fix and resend; credit note), `payments/list`
  (Record a payment: two steps; `?new=1&invoice=<id>`), `payments/record` (`?tab=allocation|bank`), `settings`,
  `_demo/fixtures.ts` (made-up data). `RECORD_PAGES.Invoice|Payment` and `LIST_PAGES['/invoicing/invoices'|'/payments']`.
- `src/areas/production/` — Production (SCR-069 … SCR-073): `work-orders/` the list (list frame; Export N, Release N) and
  New work order (`?new=1`), `work-orders/record/` the work order studio (`?tab=overview|materials|cutting|bundles|
  operations|quality|activity`, `?at=<seq>`; tabs in `cutting/`, `bundles/`, `progress/`), `wip/` Floor now
  (`/production/floor`); `_shared/` api, rules (`model.ts`), hooks, made-up fixtures. Totals per work order, operation
  and line only: no person's output and no station anywhere (Statuto art. 4, Owner F2); worker names only inside one record.

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
  factory-domain must be in `PENDING_PERMISSIONS` (shell/nav/office-nav.ts) until its step declares it.
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

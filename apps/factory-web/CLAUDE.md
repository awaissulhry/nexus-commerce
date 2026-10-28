# apps/factory-web — the factory web app

Next.js 16 (App Router), the same Next and React versions as `apps/web`, built from the design system `@nexus/ui`
(packages/ui, compiled here: `transpilePackages`). Four views as route groups: Office `(office)` (built), Links
`(links)` (built), Floor `(floor)` and Portal `(portal)` (later steps); sign-in `(auth)` (B-W0-26; today a placeholder).

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
http://localhost:3200/design (every screen by SCR id) → a screen (every case in light and dark, desktop 1440 or phone
390, Italian or English) → "Open alone" for the keyboard. It needs no API.

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
- `src/app/(links)/` — no chrome: `/l#token=…` (a one-off link; the token is read from the fragment, removed from the
  address bar, sent only in `x-factory-link`), `/privacy/<company id>` (the privacy-notice slot, GAP-005).
- `src/app/design/` — the LOCAL design index. Route files are `*.design.tsx`: `next.config.ts` reads that extension
  only under `next dev` (`src/lib/design/route.ts`), so `/design` does not exist in a build.
- `src/shell/` — the frames: `office/` (SCR-003), `switcher/` (SCR-002), `palette/` (SCR-004), `links/` (SCR-028),
  `nav/office-nav.ts` (assembles the area manifests). `src/areas/<area>/nav.ts` — one navigation declaration per area.
- `src/lib/` — shared by every view: `api/` (the client), `session/`, `i18n/`, `theme/`, `pdf/`, `links/`, `design/`.
- `src/record-panels/` — SCR-006, the panels every record page mounts: `<RecordPanels record={{ type, id, companyId,
  siteId }} title party />` (thread, files, history; live refresh from `/live`). A screen with its own catalogue wraps its
  view in `WithMessages` (record-panels/i18n.tsx): the layouts load `shell` only.

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
- Design system only: `@nexus/ui` primitives, components, patterns (the narrower `@nexus/ui/patterns/shell/index` for
  the rail); BottomBar, PdfViewer and QrCode from their own entry points (`@nexus/ui/components/<Name>/index`). No
  Tailwind. App CSS is layout only, with semantic `--nds-*` tokens (no raw colours). A server component never imports a
  DS barrel (it holds client components): render a client component.
- `import.meta.glob` (Turbopack and Vitest): a pattern outside the calling folder needs `base` (`{ base: '../../areas' }`
  with `'./*/nav.ts'`); the keys differ between the two, so read only the last path parts.
- `tsconfig.json` has `noUncheckedIndexedAccess: false`: tsc checks the DS source this app compiles, and the DS is not
  written for it. `vitest.config.ts` compiles the DS's JSX (`oxc`), as the Commerce web's does.
- Environment only as `process.env.FACTORY_…` (`scripts/factory/check-env-loader.mjs`).

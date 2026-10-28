# patterns/

Organisms — larger composed structures and layout frames that whole pages adopt.

Planned (Phase 5): `AppShell` (sidebar + page frame), `PageHeader`,
`DetailHeader`, the `Builder` framework (full-screen wizard + scroll-spy nav,
spine of the rule/goal builders), `FilterPanel`, `BulkActionBar`,
`ColumnCustomizer`, `EditModeBar`.

The actively-changing ads builders (`_rank/`, the B-series budget builder) are
folded in only after that WIP is committed.

> **Phase 5 COMPLETE — all 8 patterns shipped:** `AppShell`, `PageHeader`,
> `DetailHeader`, `FilterPanel` (+ `FilterField`), `BulkActionBar`, `EditModeBar`,
> `Builder` (full-screen wizard + scroll-spy), `ColumnCustomizer`
> (+ `../styles/patterns.css`). The live-WIP ads builders (`_rank`, budget) fold
> in during the migration once committed. `AppShell` ships the full H10 rail —
> flat items **and** collapsible nav groups (sub-items, auto-open on active).

## WorkspaceSubheader

Compose a page header and optional tabs into `WorkspaceSubheader`. Render main content as its next sibling; the 48px toggle cell belongs only to the subheader. Do not add a matching column or left gutter to content.

Pass `chrome.header` and `chrome.primaryNavigation` as the actual shell elements. ResizeObserver tracks their visible edges as the primary rail changes width. Without these elements the pattern uses the subheader's top/left edges. The panel portals to the viewport, uses a 224px desktop width, and fills the remaining workspace below 720px. It never changes the content's dimensions.

`groups` accepts labelled groups of real links, optional collapsible groups and `Tag` badges. The feature supplies actual destinations, permissions and active state; the pattern does not infer authorization. Use `onNavigate` to adapt client routing, intercepting only unmodified primary clicks.

A row may hold rows under it (`children`, 2026-10-27, board "Sidebar · channel rows with markets"). Use it when a row has its own page AND a short list of pages that belong to it — a channel and its markets (Reviews), later Settings channels or Orders and Listings by channel. The row keeps its link; a chevron button at its end shows or hides the rows (`aria-expanded`, `aria-controls`, named "Show <label> <childrenLabel>"; pass `childrenLabel`, e.g. `'markets'`, default `'items'`). The rows sit in a `role="group"` list indented under the row's icon with a guide line; give each a short `label` ("Italy") and a full `ariaLabel` ("Amazon Italy") when the short word repeats under another row. A parent whose child is the current page opens when the person arrives there; the person's own open/closed choice is remembered per navigation in localStorage (`nds-secondary-nav:<navigationLabel>:<id>`; the page works without it). Closed while one of its rows is the current page, the parent is bold with a dot and says "(the current page is in <label>)" to a screen reader. One level only; an empty `children` draws a plain row. Do not use it for a group of peer pages — that is a collapsible group (`collapsible`), whose label keeps its own chevron. Same in the pinned column, the drawer and the plain subheader; the state model is `secondaryNavTree.ts`.

For related views, pass `views` and render the supplied menu through `header={titleMenu => <DetailHeader title={title} titleMenu={titleMenu} />}`. One state owns the panel and view menu, so only one is open. `Drawer` provides Escape, focus containment/restoration and an outside-click barrier; the desktop barrier is transparent. Collapsed navigation is unmounted. Navigation groups retain disclosure state across openings.

Use `/design-system#workspace-subheader-example` in web for the interactive specimen, including 32 long sample collection labels, selection, keyboard use and internal scrolling. Product Studio is the first production consumer.

WorkspaceSubheader secondary navigation uses `--nds-text` for readable group labels and links in both themes. Keep channel library links separate from the page scope controls; expanding navigation must not resize workspace content.

## StepUpModal

The one question before a person raises something (what Claude may do, a limit, the ads strategy, a request that
raises): a sentence naming what rises, the 6-digit code from their authenticator app, and the API's answer. Lowering
never opens it. The caller sends the code and passes back the API's refusal (`error`); the field then takes the focus
again with the wrong code selected. Pass `confirmLabel` to say what happens ("Approve", "Save"), and a light-pinned
surface's portal class in `className` (the fleet's `fleet-portal`). Specimen: `/design-system#step-up-modal-example`.

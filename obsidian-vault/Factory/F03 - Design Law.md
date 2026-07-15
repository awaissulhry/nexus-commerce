# F03 - Design Law

> Canonical: `docs/factory/F0-DESIGN-BRIDGE.md` + PLAYBOOK §6. Binding on every pixel of every page.

Hub: [[F00 - Factory OS MOC]] · program law: [[F06 - Enterprise Program (EP)]]

## The rules

1. **Build ONLY from the DS copy** — `apps/factory/src/design-system/` is a **byte-identical verbatim copy** of the commerce H10 system ([[09 - Design System]]): 19 primitives + 24 components + 11 patterns. NEVER edit the copy (`ds-parity-check` must stay 97/97); factory-specific CSS goes in `globals.css` under `.factory-frame`; DS gaps = compose locally on tokens. New scale components (VirtualDataGrid…) are factory-local in `src/components/` ([[F22 - Substrate FS Series]] FS3).
2. **Tokens:** primary `#1f6fde` (`--h10-primary`) · canvas `--h10-bg` · card `--h10-surface` · text 13px base / 12.5 secondary / 11.5 meta · radii 8/10/12 · money ONLY via `lib/format.ts::eur(cents)`.
3. **The rail is sacred** (the Owner's favorite): 66→344px hover-expand overlay (content never shifts), 46px rows, 50px icon zone, 20px lucide glyphs, blue-fill active with white text, badge left:29/top:6.
4. **Quality bar on every page:** skeletons never spinners · zero layout shift · every money value formatted + grain-gated · freshness lines on integration panels · destructive/money actions state consequences · empty states carry a next action · no dead links · keyboard access for the core loop · English UI (Italian only for customer-facing content).
5. **Escalation ladder for risky actions:** cheap → confirm with consequence bullets; bulk/irreversible → **dry-run diff → apply-valid-rows** (the CSV import in Settings is the reference implementation).
6. **Page archetypes:** list/board/workspace pages FILL (`.factory-page` + `factory-grid-grow-N`); editor/detail pages CENTER at 1180 (`.factory-page--centered`); verify headlessly at 1512/1728/1920.
7. **Standing expectations for heavy surfaces** (EP era): resizable panes (`PaneHandle`/`useResizablePanes`) + windowed lists + URL state + saved views.

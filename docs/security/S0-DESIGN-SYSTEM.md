# S0 — Design System Inventory (for Settings › Team & Access console)

Discovery date: 2026-07-03. Read-only. Root: `/Users/awais/nexus-commerce/apps/web/src/design-system` (the "H10" / Nexus DS).
Authoritative internal map: `design-system/docs/AUDIT.md` (snapshot 2026-06-27; barrels have since grown — deltas noted below).
Living catalog route: `/design-system` → `apps/web/src/app/design-system/page.tsx` → `design-system/catalog/TokenCatalog.tsx`.

---

## 1. Directory + export map

```
design-system/
├── tokens/        colors.ts typography.ts spacing.ts radius.ts shadow.ts motion.ts
│                  zindex.ts breakpoints.ts css-vars.ts index.ts   ← TS source of truth
├── styles/        tokens.css (GENERATED) primitives.css components.css patterns.css a11y.css
├── primitives/    19 atoms + tone.ts (Tone/TONES) + size.ts (Size)      → barrel index.ts
├── components/    23 molecules + useClickAway hook                       → barrel index.ts
├── patterns/      11 organisms                                           → barrel index.ts
├── catalog/       TokenCatalog.tsx (living style guide) + verify.mjs
├── lib/           format.ts (formatters)
├── docs/          AUDIT.md GOVERNANCE.md CONTRIBUTING.md NAMING.md TOKENS.md
│                  TOKEN-RECONCILIATION.md ACCESSIBILITY.md CONTENT.md MIGRATION.md
├── studies/       per-feature research dossiers
└── tools/         generate-tokens-css.ts (npm run tokens:gen) token-guard.mjs api-guard.mjs
```

Imports (no top-level barrel; import per layer):
```ts
import { Button, Toggle, ... } from '@/design-system/primitives'
import { DataGrid, Modal, ... } from '@/design-system/components'
import { PageHeader, FilterBar, ... } from '@/design-system/patterns'
import { tokens } from '@/design-system/tokens'
```
**CSS must be imported explicitly per page** (not global):
`'@/design-system/styles/tokens.css'` + `primitives.css` + `components.css` + `patterns.css` (+ `a11y.css` on the catalog). See `products/next/ProductsNextClient.tsx:4-7`, `marketing/ads/portfolios/PortfoliosClient.tsx:20-22`.

Canonical shared vocab: `type Tone = 'neutral'|'info'|'success'|'warning'|'danger'` (`primitives/tone.ts`), `type Size = 'sm'|'md'|'lg'|'xl'` (`primitives/size.ts`).

## 2. Component inventory (53 exports incl. types/hook)

### Primitives (19) — `design-system/primitives/`
| Component | Renders | Key props |
|---|---|---|
| Button | native button, 3 emphases | variant(primary\|secondary\|ghost), size(md\|sm), +ButtonHTMLAttributes |
| Pill | status chip | tone (Tone), children |
| Badge | **ad-program** chip (SP/SD/SB/auto/manual — NOT general purpose) | tone/program (AdProgram) |
| Tag | tinted label chip | tone (Tone), children |
| Input | text input w/ wrapper, hover/focus ring | leadingIcon, prefix, suffix, fieldClassName, +InputHTMLAttributes |
| Textarea | native textarea | TextareaHTMLAttributes |
| Select | native select + chevron | +SelectHTMLAttributes, children(options) |
| Checkbox | native checkbox in label | label, +InputHTMLAttributes |
| Toggle | switch (role="switch") | checked, onChange, disabled, +ButtonHTMLAttributes |
| Radio | native radio in label | label, +InputHTMLAttributes |
| RadioCard | card-style radio | title, description, selected, +InputHTMLAttributes |
| Tooltip | hover/focus bubble | label, children |
| Spinner | loading spinner (role=status) | size(px number), className |
| Skeleton | shimmer placeholder | width, height, radius, className |
| Kbd | keyboard key cap | children |
| Divider | hr | orientation, className |
| TagInput | chips + typeahead input | value(string[]), onChange, suggestions, maxTags, placeholder, disabled |
| SegmentedControl | radiogroup segments, arrow-key nav | options, value, onChange, size(sm\|md), disabled |
| ToolbarButton (+ToolbarDivider) | icon toolbar button w/ tooltip+badge | icon, label, description, shortcut, onClick, active, badge, tooltipContent |

### Components (23) — `design-system/components/`
| Component | Renders | Key props |
|---|---|---|
| Card | surface container | padded, elevated, header, headerAction, className |
| EmptyState | icon+title+desc+CTA block | icon, title, description, action |
| Tabs | tablist row | tabs(TabItem[]), active, onChange, className |
| Pagination | prev/pages/next | page, pageCount, onPage |
| ProgressBar | progress (role=progressbar) | value, indeterminate, height |
| Modal | centered dialog, portal, Esc/backdrop | open, onClose, title, subtitle, footer, size(sm\|md\|lg\|xl) |
| Drawer | right slide-over dialog | open, onClose, title, footer |
| Menu | dropdown menu (kebab/row actions) | label, items(MenuItemDef[]), align, triggerProps |
| ToastProvider/useToast | bottom-center toasts | toast(message, tone); ToastApi exported |
| MultiSelect | checkbox-list dropdown w/ select-all | options, value(string[]), onChange, placeholder |
| Combobox | filter-as-you-type single select | options, value, onChange, placeholder |
| MetricStrip | KPI tile row | metrics(Metric[]) |
| HoverCard | rich hover panel | card, children |
| DateRangePicker | 2-month calendar popover | value(DateRange), onChange |
| PerformanceGraph | dual-axis recharts line | data, xKey, left/right(ChartSeries), height |
| Heatmap | numeric intensity matrix | data(number[][]), rowLabels, colLabels, format |
| DataGrid<T> | **the universal table** — sortable headers, select-all + row checkboxes, sticky header/pinned cols, totals row, empty state | columns(Column<T>[]: key,label,render,align,sortable,sortValue,sticky,stickyRight,width,total), rows, rowKey, selectable, selected(Set), onSelectedChange, showTotals, emptyState, initialSort, maxHeight, className |
| ImageUpload | validated image drop/pick | value, onChange, onUpload, criteria, accept, maxBytes… |
| Banner | inline alert (role=alert/status) | variant/tone(info\|warning\|error\|success), title, icon, action, onDismiss |
| Stepper | numbered step progress (ol) | steps(StepperStep[]), current |
| FileDropzone | drag-drop file zone | onFiles, accept, maxBytes, multiple, hint |
| ColumnGroupModal | dnd-kit sortable color-coded column groups | open, onClose, groups(ColumnGroupProps[]), onGroupsChange |
| useClickAway | outside-click hook | (ref, onAway, active?) |

### Patterns (11) — `design-system/patterns/`
| Pattern | Renders | Key props |
|---|---|---|
| AppShell | rail+header+main app frame | brand, nav(ShellNavEntry[]), footer, children |
| PageHeader | h1 page header | eyebrow, title, subtitle, actions |
| DetailHeader | back + badge + h1 + actions | backLabel, onBack, badge, title, actions |
| FilterPanel + FilterField | collapsible labelled filter grid | title, presets, onReset, onApply, footerExtra, defaultOpen; FilterField: label, wide |
| FilterBar | **declarative** ads-manager filter panel (6-col grid) | dimensions(FilterDimension[]: kind multiselect\|select\|range\|toggle), presets, onClear, activeCount, defaultOpen |
| GridToolbar | count-left / actions / right-actions toolbar row | count, children(left), right — pair with `.h10-ds-gridcard` |
| PreferencesModal | two-panel "Customise" (columns/sticky/pageSize/sort) | open, onClose, value/onConfirm(PreferencesValue), allColumns, defaultVisible, sortFieldOptions, pageSizeChoices, showSticky, workspaceSlot |
| BulkActionBar | selected-N action bar (hides at 0) | count, children, onClear, noun |
| EditModeBar | dirty-state Apply/Discard bar | message, count, onDiscard, onApply, applyLabel, busy |
| Builder | full-screen scroll-spy create/edit dialog | open, onClose, title, sections(BuilderSection[]), primaryLabel, onPrimary, busy |
| ColumnCustomizer | modal checkbox+reorder column list (locked rows, draft→Apply) | open, onClose, columns(CustomizableColumn[]), onApply |

AUDIT.md deltas: FilterBar, GridToolbar, PreferencesModal (patterns), ColumnGroupModal (components), ToolbarButton/ToolbarDivider + tone.ts/size.ts (primitives) were added post-audit (FF-SR + /products/next parity work). Tone remap (Pill→tone, Toast 'danger') has landed — `toast(msg, 'danger')` is live usage.

## 3. Tokens / theming

- **TS-first, generated CSS**: `tokens/*.ts` (palette/typography/spacing/radius/shadow/motion/zindex/breakpoints) → ordered `tokens/css-vars.ts` → `tools/generate-tokens-css.ts` emits `styles/tokens.css` (`npm run tokens:gen`; `npm run tokens:check` = CI staleness guard). Header of tokens.css says "GENERATED — do not edit".
- **116 `--h10-*` vars, 3 tiers**: Tier 1 primitive ramps (blue/grey/green/red/amber/purple/cyan stops), Tier 2 semantic roles, Tier 3 component tokens (pill/badge/radius/shadow/focus/rail/type).
- **Platform-semantic alias layer is live**: components consume `--text-{primary,secondary,tertiary,disabled,link}`, `--surface-{canvas,card,sunken}`, `--border-{default,subtle,strong}`, `--color-primary(-soft)`, `--status-{success,warning,danger,info}-{soft,line,strong}` (mapping table in AUDIT.md §2).
- **Dark theme**: `.dark` class block in tokens.css:192-220 re-declares text/surface/border/rail roles (Tailwind `darkMode:'class'`). `.h10-shell` pins standalone shells (ads cockpit, /products/next) light deliberately.
- **JS access**: `import { tokens } from '@/design-system/tokens'` → `tokens.color.*`, `tokens.space`, `tokens.radius`, `tokens.shadow`, `tokens.zIndex`…
- Components style via `.h10-ds-*` classes in `styles/{primitives,components,patterns}.css`; raw hex/Tailwind palette in DS components is a lint defect (`tools/token-guard.mjs`). The app's `tailwind.config.ts` also bridges `surface`/`status` colors onto CSS vars for the legacy pages.

## 4. Team & Access needs vs exists

| Need | Verdict | What / where |
|---|---|---|
| Data table (user list, audit log) | **EXISTS** | `DataGrid<T>` — `components/DataGrid.tsx` (sortable, selectable, sticky cols, totals, emptyState, maxHeight). Client-side sort; server paging via separate `Pagination`. NOT TanStack — TanStack lives only in bespoke grids (AdsDataGrid `app/marketing/ads/_grid/`, command-matrix) |
| Modal/dialog | **EXISTS** | `Modal` (sizes sm–xl, footer slot) |
| Confirmation dialog | **EXISTS as composition, GAP as component** | No DS ConfirmDialog. Convention = small `Modal` + secondary Cancel + primary action + consequence text (`PortfoliosClient.tsx:285-302` archive modal). Legacy `components/ui/ConfirmDialog.tsx`+`ConfirmProvider.tsx` exist but are the old kit — off-limits for new UI |
| Drawer (user detail / audit entry detail) | **EXISTS** | `Drawer` (no focus trap — known C6 gap) |
| Tabs | **EXISTS** | `Tabs` (also SegmentedControl for view toggles) |
| Switch/toggle | **EXISTS** | `Toggle` (role=switch) |
| Checkbox / Radio | **EXISTS** | `Checkbox`, `Radio`, `RadioCard` (role picker cards) |
| Select / Combobox / MultiSelect | **EXISTS** | `Select` (native), `Combobox` (single, ARIA incomplete), `MultiSelect` (w/ select-all) |
| Badge/chip (role, status) | **EXISTS** | `Tag` (Tone) + `Pill` (Tone). NB `Badge` is ads-program-specific — don't use for roles |
| Toast | **EXISTS** | `ToastProvider`/`useToast` — **page must mount its own ToastProvider** (root provider is the old kit) |
| Form field + label + error | **PARTIAL GAP** | No FormField/Label/FieldError component. Convention: page-CSS `<label class="pf-fld"><span>Label</span><Input/></label>` (portfolios) or `FilterField` (filters only). Inline error text is hand-rolled per page — a thin FormField wrapper would be the only genuinely new UI needed |
| Button variants | **EXISTS + thin GAP** | primary/secondary/ghost, md/sm. **No danger variant** — portfolios overrides with page CSS class `pf-btn-danger` (`PortfoliosClient.tsx:291`). Destructive "Remove user" wants this |
| Empty state | **EXISTS** | `EmptyState` (icon/title/description/action) |
| Skeleton / loading | **EXISTS** | `Skeleton`, `Spinner`; page-level skeletons composed per page (e.g. `ProductsSkeleton.tsx`), passed via DataGrid `emptyState` when data==null |
| Tooltip | **EXISTS** | `Tooltip` (text), `HoverCard` (rich, e.g. permission description) |
| Avatar | **GAP** | Nothing in DS or old kit. Only `settings/profile/ProfileClient.tsx` touches avatars. Compose initials-circle via tokens or add primitive |
| Date-range picker (audit log filter) | **EXISTS** | `DateRangePicker` — or as FilterBar `range` dimension |
| Search input | **EXISTS** | `Input` with `leadingIcon` (pattern in products/next GridToolbar left slot) |
| Pagination | **EXISTS** | `Pagination` (page/pageCount/onPage) |
| Invite flow (multi-step) | **EXISTS** | `Stepper` + `Modal`/`Builder`; `TagInput` for multi-email entry; `Banner` for pending-invite notices |
| Row actions menu | **EXISTS** | `Menu` (MenuItemDef[], danger via item styling; keyboard nav incomplete) |
| Bulk role actions | **EXISTS** | `BulkActionBar` + DataGrid selection |
| Dirty-state save bar (role editor) | **EXISTS** | `EditModeBar` (DS) or settings shell `useSettingsForm` save-bar (see §5) |
| Permission matrix | **GAP (component); precedents exist** | No toggle/checkbox-grid component. Best build: `DataGrid<PermissionRow>` with one column per role rendering `Checkbox`/`Toggle` per cell — 100% DS. See §6 |

**True GAPs: Avatar, FormField(label+error), Button danger variant, dedicated ConfirmDialog wrapper, permission-matrix component.** All are thin compositions over existing DS pieces except Avatar.

## 5. Page composition conventions

**A. DS-first page recipe** (the pattern to follow — `app/products/next/ProductsNextClient.tsx`, flagship; `app/marketing/ads/portfolios/PortfoliosClient.tsx`, newest 2026-07-01):
1. `'use client'` client component; export wrapper = `<ToastProvider><Inner/></ToastProvider>` (ProductsNextClient.tsx:1597, PortfoliosClient.tsx:336).
2. Explicit DS CSS imports at top: tokens/primitives/components/patterns.css + one page-local CSS file (`portfolios.css`, `styles.module.css`) for page-specific glue only.
3. Vertical order: `PageHeader` (title/subtitle/actions=sm Buttons w/ lucide icons at 13-14px) → optional Banner/mode strip → KPI tiles (page CSS, click-to-filter) → `FilterBar` → **`.h10-ds-gridcard`** div containing `GridToolbar` (count `Viewing <b>N</b> of <b>M</b>`, left slot swaps search⇄selection actions, right slot: density/Customise/Export) + `DataGrid` → `PreferencesModal` + feature `Modal`s at the end (ProductsNextClient.tsx:1390-1590).
4. Server `page.tsx` is thin (7 lines in portfolios); data fetched client-side with `getBackendUrl()`, or server-fetched + passed as `initial*` props (settings pattern).
5. Confirmations = dedicated small Modals with Cancel(secondary)+Action(primary) footer and explicit consequence copy per mode (PortfoliosClient.tsx:285-331).

**B. Settings shell** (`app/settings/layout.tsx` + `app/settings/_shell/`): every /settings/* route renders inside `SettingsPaletteProvider > SettingsSaveBarProvider > [SettingsRail | SettingsShellHeader + main(px-4 sm:px-6 py-6)]`. Nav entries registered in `_shell/settings-nav.ts` (groups: Account, Workspace, Catalog, Integrations, Developer) — a Team & Access page adds a rail entry there. Forms register with `useSettingsForm()` (`_shell/SettingsSaveBar.tsx:239`) for shared Save/Discard/⌘S. Server `page.tsx` does `force-dynamic` fetch → passes `initial*` to `*Client.tsx` (`settings/audit/page.tsx`). **Caveat:** existing settings clients (SecurityClient 747L, NotificationsClient 717L, AuditClient 462L) are the *old* Tailwind/slate + `components/ui` kit, pre-DS — new Team & Access should sit in this shell but render DS components inside (mirroring how /products/next is DS-first).
- Audit-log viewer precedents: `app/settings/audit/AuditClient.tsx` (filter chips by key, inline field deltas, per-row revert w/ confirm, "Salesforce/Airtable not Linear" density note) and `app/audit-log/AuditLogClient.tsx` (710L, app-wide).

## 6. Matrix-UI precedents (for the permission matrix)

1. **`app/settings/notifications/NotificationsClient.tsx:457-590`** — the closest analog: `<table>` of event-type rows × channel columns (In-app/Email/SMS) each cell a Toggle (+ per-row cadence Select + marketplace multi-select chips; row dims via opacity when off; local Toggle at :592, pre-DS Tailwind). Exactly the row×capability toggle-grid shape a permission matrix needs — rebuild shape with DS `DataGrid` or table + DS `Toggle`/`Checkbox`.
2. **`patterns/PreferencesModal.tsx` / `patterns/ColumnCustomizer.tsx` / `components/ColumnGroupModal.tsx`** — checkbox-list visibility editors with **locked rows** (≈ non-removable Owner role), draft-then-Apply semantics, and dnd-kit reorder (ColumnGroupModal) — the right interaction model for a role editor (draft + explicit Apply).
3. **`components/Heatmap.tsx`** — data[][] matrix rendering (numeric, not interactive).
4. **`app/command-matrix/CommandMatrixClient.tsx`** — misleading name (catalog bulk-edit grid), but demonstrates TanStack table + virtualizer for very large grids if the matrix ever exceeds DataGrid comfort.
5. **FilterBar `toggle` dimension** (`patterns/FilterBar.tsx:56-62`) — declarative labelled-toggle rows.

## Systemic caveats for the builder
- C4 (AUDIT §3): almost no DS component forwards `ref`; ~30 lack `className` passthrough — plan wrappers accordingly.
- Overlays (Modal/Drawer/Builder) have **no focus trap/restore**; Menu/Combobox/MultiSelect keyboard nav incomplete — relevant for an access-control console's a11y bar.
- Toast needs a page-local ToastProvider; DS CSS must be imported per page.
- No /settings/team or invite/role UI exists anywhere today (greenfield).

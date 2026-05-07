# Nexus Design System

Reference for the tokens, primitives, and patterns shipped during the U.1–U.20 UX/UI overhaul. Source-of-truth lives in `apps/web/tailwind.config.ts` and `apps/web/src/components/ui/`.

## Tokens (U.1)

All tokens are defined in `apps/web/tailwind.config.ts` and JS constants live in `apps/web/src/lib/theme/index.ts`.

### Typography (`fontSize`)

Operator UIs are dense; the scale is tuned for 10–18px hot zones with hero sizes reserved for dashboards.

| Token | Size / line-height | Use |
|-------|---------------------|-----|
| `text-xs` | 10 / 14 | Tag chips, footnotes, dense metadata |
| `text-sm` | 11 / 15 | Secondary labels, kbd shortcuts |
| `text-base` | 12 / 16 | Body text, table cells |
| `text-md` | 13 / 18 | Primary labels, button text |
| `text-lg` | 14 / 20 | Section headings, modal titles |
| `text-xl` | 16 / 22 | Page-level error / status headings |
| `text-2xl` | 18 / 24 | PageHeader title |
| `text-3xl` | 24 / 30 | Hero (deprecated; use 2xl) |
| `text-4xl` | 32 / 38 | Dashboard counters |

### Color — semantic

- **Success** → `emerald` (50/100/200 backgrounds, 600/700 text)
- **Warning** → `amber`
- **Danger** → `rose` / `red`
- **Info** → `blue`
- **Neutral** → `slate`

JS-side constants in `lib/theme/index.ts`:
- `STATUS_VARIANT` — Badge variant per product status (ACTIVE / DRAFT / INACTIVE)
- `STATUS_PALETTE` — Tailwind class triples for computed status pills
- `CHANNEL_TONE` — Per-marketplace chip styling (AMAZON orange, EBAY blue, SHOPIFY emerald, WOOCOMMERCE violet, ETSY rose)

### Color — dark mode (U.14)

Tailwind `darkMode: 'class'` is enabled. Surfaces switch via the `dark` class on `<html>`, managed by `useTheme()` (`lib/theme/use-theme.ts`).

Common pairings:
- `bg-white` → `dark:bg-slate-900`
- `bg-slate-50` → `dark:bg-slate-950`
- `border-slate-200` → `dark:border-slate-800`
- `text-slate-900` → `dark:text-slate-100`
- `text-slate-500` → `dark:text-slate-400`

Phase 1 (U.14) shipped dark variants on Card, Modal, layout body, AppSidebar (always-dark). Phase 2 sweep (U.14.2 follow-up) needs to extend these to every page-level surface.

### Spacing & Sizing

Tailwind defaults retained; no overrides. Density-sensitive primitives expose `size: 'sm' | 'md' | 'lg'` props instead.

### `borderRadius`

| Token | Use |
|-------|-----|
| `rounded` (default 4px) | Cells, dense controls |
| `rounded-md` | Most UI controls (buttons, inputs, chips) |
| `rounded-lg` | Cards, modals |
| `rounded-xl` | Featured surfaces |
| `rounded-2xl` | Hero panels |

### `boxShadow`

| Token | Use |
|-------|-----|
| `shadow-subtle` | Card hover lift |
| `shadow-default` | Card resting |
| `shadow-elevated` | Hovered cards, popovers |
| `shadow-modal` | Modal panel |
| `shadow-drawer` | Side drawer |

### `transitionDuration`

| Token | Use |
|-------|-----|
| `duration-fast` (150ms) | Hover, press |
| `duration-base` (200ms) | Cell / menu transitions |
| `duration-slow` (300ms) | Drawer / modal slide-ins |

Pair with `ease-out` (`cubic-bezier(0.16, 1, 0.3, 1)`) for entry, default ease for exits.

### Animation (U.16)

Named keyframes for overlay entrances:

| Animation | Duration | Use |
|-----------|----------|-----|
| `animate-fade-in` | 200ms | Backdrops, generic overlays |
| `animate-scale-in` | 180ms | Centered modals (subtle pop) |
| `animate-slide-from-right` | 240ms | Drawers, toasts |
| `animate-slide-up` | 200ms | Bottom sheets (reserved) |

All honor `motion-reduce:animate-none`.

### `zIndex`

Semantic tokens — never use magic numbers.

| Token | Stack |
|-------|-------|
| `z-dropdown` | 10 |
| `z-sticky` | 20 |
| `z-drawer` | 30 |
| `z-modal` | 40 |
| `z-toast` | 50 |
| `z-popover` | 60 |

## Primitives (U.2 + later)

All in `apps/web/src/components/ui/`.

### Button (`Button.tsx`)

```tsx
<Button variant="primary" size="md" loading={busy} icon={<Save />}>
  Save changes
</Button>
```

- **Variants:** `primary` (blue), `secondary` (white/border), `ghost` (transparent), `danger` (red)
- **Sizes:** `sm` (h-7), `md` (h-8), `lg` (h-10)
- **`loading={true}`** swaps the icon for `Loader2` and disables the button
- **U.13:** uses `focus-visible:ring` (keyboard only), not `focus:ring`

### IconButton (`IconButton.tsx`)

For icon-only buttons. **`aria-label` is required.**

```tsx
<IconButton variant="ghost" size="sm" aria-label="Edit name" onClick={…}>
  <Pencil />
</IconButton>
```

- Variants: `ghost`, `solid`, `outline`
- Sizes: `xs` (h-5), `sm` (h-6), `md` (h-7), `lg` (h-8)
- Color tones: `neutral`, `info`, `danger`, `warning`

### Modal (`Modal.tsx`)

Replaces `fixed inset-0` overlays. See **U.17 audit** for migration recipe.

```tsx
<Modal open={open} onClose={close} title="Confirm delete" size="md">
  <ModalBody>Are you sure?</ModalBody>
  <ModalFooter>
    <Button onClick={close}>Cancel</Button>
    <Button variant="danger" onClick={confirm}>Delete</Button>
  </ModalFooter>
</Modal>
```

- **Sizes:** `sm` (384px) → `3xl` (1024px)
- **Placements:** `centered` (default), `top` (cmd-palette style), `drawer-right`
- **Built-in:** focus trap, escape, click-outside, body scroll lock, prev-focus restore
- **Mobile (U.12):** drawer-right becomes a full-width sheet below `sm`; centered max-h uses `dvh` for iOS Safari URL-bar resize
- **Animation (U.16):** `animate-fade-in` on backdrop, `animate-scale-in` on centered panel, `animate-slide-from-right` on drawer

### ConfirmDialog (`ConfirmDialog.tsx`) + ConfirmProvider (`ConfirmProvider.tsx`)

Imperative confirm — replaces `if (!confirm('Delete?')) return`.

```tsx
const askConfirm = useConfirm()
if (!(await askConfirm({ title: 'Delete?', tone: 'danger' }))) return
```

- Tones: `danger`, `warning`, `info`
- Default focus is on Cancel (footgun protection)
- 89 sites migrated in U.3; new code MUST use this, never `window.confirm`

### Input (`Input.tsx`)

```tsx
<Input value={v} onChange={…} placeholder="…" leftIcon={<Search />} />
```

- Sizes: `sm`, `md`, `lg`
- `leftIcon` and `rightAddon` slots
- `error` prop adds rose border + visible message

### Card (`Card.tsx`)

```tsx
<Card title="Channel coverage" action={<Button>Edit</Button>}>
  body
</Card>
```

- Optional `title` / `description` / `action` slots
- `noPadding` for tables/grids that own their own gutter
- Dark-mode aware (U.14)

### Badge (`Badge.tsx`)

```tsx
<Badge variant="success" size="sm">ACTIVE</Badge>
```

- Variants map onto `STATUS_PALETTE`

### StatusBadge (`StatusBadge.tsx`)

Wrapper over Badge using `STATUS_VARIANT`. For ACTIVE/DRAFT/INACTIVE slugs.

### ProgressBar (`ProgressBar.tsx`)

Determinate (`value` + `max`) or indeterminate (no `value`). Uses an inline `progress-indeterminate` keyframe.

### Tooltip (`Tooltip.tsx`)

Hand-rolled, portal-mounted, smart auto-flip placement. Wraps a single child; child must accept a ref.

### KeyboardShortcut (`KeyboardShortcut.tsx`)

Translates `cmd / ctrl` per OS. Renders `<kbd>` styling.

### TableCell (`TableCell.tsx`)

`CurrencyCell`, `DateCell`, `ImageCell`, `LinkCell`, `StatusCell`. EUR / `it-IT` defaults match Xavia's primary market.

### InlineEditTrigger (`InlineEditTrigger.tsx`) — U.5

Drop-in for `<button onClick={startEdit}>display</button>`. Adds discoverable hover affordance + fade-in pencil + dashed border for empty states. Adopted across /products grid + /products drawer (12 cells); see U.5 for the strategy.

### Toast (`Toast.tsx`) + ToastProvider

Mounted in `app/layout.tsx`. Use the `useToast()` hook:

```tsx
const { toast } = useToast()
toast.success('Saved')
toast.error('Save failed')
toast.warning('Action required')
toast.info('Heads up')
```

89 alert() / confirm() calls migrated in U.3.

### ThemeToggle (`ThemeToggle.tsx`) — U.14

Three-state: light → dark → system. Cycles on click. Mounted in AppSidebar header.

### LocaleToggle (`LocaleToggle.tsx`) — U.15

Two-state: 🇬🇧 EN ↔ 🇮🇹 IT. Persists to localStorage. **Not yet mounted** — pending t() adoption per U.15 follow-up.

## Hooks

- `useTheme()` (`lib/theme/use-theme.ts`) — tri-state theme management with system-preference tracking.
- `useTranslations()` (`lib/i18n/use-translations.ts`) — minimal i18n shim returning `{ locale, setLocale, t }`.
- `useToast()` (`components/ui/Toast.tsx`) — global toast service.
- `useConfirm()` (`components/ui/ConfirmProvider.tsx`) — imperative async confirm.

## Patterns

### PageHeader

Every page uses the shared `PageHeader` from `components/layout/PageHeader.tsx`:

```tsx
<PageHeader
  title="Products"
  description="Catalog overview"
  breadcrumbs={[{ label: 'Catalog', href: '/catalog' }, { label: 'Products' }]}
  actions={<Button>New product</Button>}
/>
```

- **U.12 mobile:** title + actions stack on narrow screens; actions wrap.
- **Title styling:** `text-2xl font-semibold` (18px from the U.1 scale).
- **Don't** use raw `<h1 text-[24px]>` — the audits in U.7/U.8/U.10 fixed several offenders.

### Sticky toolbar

For long-scroll pages, give the count/density/columns row `sticky top-0 z-10` with `bg-white/85 backdrop-blur` and a slate bottom border. See `apps/web/src/app/products/ProductsWorkspace.tsx` (U.6).

### Validation surface

For forms with cross-field validation (e.g. listing wizard Step 4), render a sticky `<ValidationSummary>` at the top of the scroll container with progress bar + per-channel chips + "Jump to next" + filter. See `apps/web/src/app/products/[id]/list-wizard/components/ValidationSummary.tsx` (U.4).

### Empty states

- Use `<EmptyState>` from `components/ui/EmptyState.tsx` — icon, title, description, optional action.
- For grid empty states (BulkOperationsClient): centered card overlay inside the grid container with two cases (filter mismatch → Clear filters; truly empty → CTA to create).

## Audit history

| Phase | Doc | Coverage |
|-------|-----|----------|
| U.1 | (in tailwind.config.ts comments) | Tokens |
| U.4 | `apps/web/src/app/products/[id]/list-wizard/components/ValidationSummary.tsx` | Wizard validation surface |
| U.17 | `docs/audits/U.17-component-adoption.md` | Adoption baseline + migration plan |
| U.18 | `docs/audits/U.18-cross-browser.md` | Cross-browser quirks punch list |
| U.19 | `docs/audits/U.19-perf-hotspots.md` | Performance hotspots |

## Migration cheatsheet

When touching a file, opportunistically:

1. **Replace `alert()` / `confirm()`** with `toast` / `useConfirm()` (U.3).
2. **Replace inline `<button onClick={startEdit}>display</button>`** with `<InlineEditTrigger label="…">display</InlineEditTrigger>` (U.5).
3. **Replace inline `fixed inset-0` overlay** with `<Modal>` (U.17).
4. **Replace raw `<button>`** with `<Button>` for toolbar/CTA buttons (U.17 — but skip cell-density buttons).
5. **Replace `text-[Npx]` arbitrary** with the U.1 scale token.
6. **Add `dark:` variants** when touching color classes (U.14).
7. **Use `focus-visible:`** instead of `focus:` for visible rings (U.13).
8. **Use `100dvh`** instead of `100vh` for full-viewport shells (U.12).

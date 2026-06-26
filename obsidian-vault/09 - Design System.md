# Design System

→ [[00 - Nexus Commerce MOC]] | [[08 - Web App (Next.js)]]

## Location

`apps/web/src/design-system/`

## Rule

> All new UI **must** be built from design system primitives, components, and patterns. No hand-rolled components. This is a hard constraint — not a preference.

---

## Philosophy

**Best-in-class = Salesforce / Airtable density**, NOT Linear minimalism.
- Default to inline buttons over More dropdowns
- Visibility over minimalism
- Mirror leading/trailing affordances (balanced symmetric spacing)

---

## Primitives (23 components)

| Component | Purpose |
|-----------|---------|
| `Badge` | Status and category labels |
| `Button` | Primary, secondary, ghost, destructive variants |
| `Checkbox` | Single and indeterminate states |
| `Divider` | Horizontal/vertical separators |
| `Input` | Text input with prefix/suffix slots |
| `Kbd` | Keyboard shortcut display |
| `Pill` | Compact label chips |
| `Radio` | Single selection |
| `RadioCard` | Card-style radio selection |
| `SegmentedControl` | Tab-like toggle group |
| `Select` | Native/custom select dropdown |
| `Skeleton` | Loading placeholder |
| `Spinner` | Loading indicator |
| `Tag` | Dismissible tag (NEW — added in S-series) |
| `TagInput` | Multi-tag input field |
| `Textarea` | Multi-line text input |
| `Toggle` | Boolean switch |
| `Tooltip` | Hover tooltip |
| Icon library | Full icon set |

---

## Components (26+)

| Component | Purpose |
|-----------|---------|
| `Banner` | Alert/info/warning/error banners |
| `Card` | Content container |
| `Combobox` | Searchable dropdown (pick-or-type) |
| `DataGrid` | Full-featured data table (groupBy, onRowClick, keyboardNav) |
| `DateRangePicker` | Calendar date range selector |
| `Drawer` | Side panel overlay |
| `EmptyState` | Zero-state placeholder with CTA |
| `FileDropzone` | Drag-and-drop file upload zone |
| `Heatmap` | Calendar heatmap for analytics |
| `HoverCard` | Rich hover preview card |
| `ImageUpload` | Image upload with preview |
| `Menu` | Dropdown menu with keyboard nav |
| `MetricStrip` | Horizontal KPI metrics row |
| `Modal` | Dialog overlay |
| `MultiSelect` | Multi-option select |
| `Pagination` | Page navigation controls |
| `PerformanceGraph` | Time-series chart component |
| `ProgressBar` | Progress indicator |
| `Stepper` | Multi-step wizard navigation |
| `Tabs` | Tab navigation |
| `Toast` | Transient notification messages |

---

## Patterns

| Pattern | Purpose |
|---------|---------|
| `grid-lens` | Unified grid across `/products`, `/listings`, `/stock`, `/replenishment`, `/pricing` |
| Table utilities | Column resize, sort, sticky headers |
| Form patterns | Dirty-state tracking, navigation guards, auto-save |

### Grid Lens (`_shared/grid-lens`)

Hoisted shared grid system used across:
- `/products` — master product grid
- `/listings` (Amazon / eBay / Shopify subpages)
- `/fulfillment/stock`
- `/fulfillment/replenishment`
- `/pricing`

Features: `PreferencesModal`, `ActionCluster`, column freeze, `Cmd+.` global shortcut.

---

## Tokens

| Category | Implementation |
|----------|---------------|
| Colors | CSS custom properties (`--color-*`) + Tailwind extensions |
| Spacing | `--spacing-*` tokens + Tailwind scale |
| Typography | Inter / Space Grotesk / JetBrains Mono font stack |
| Shadows | `--shadow-*` tokens |
| Border radius | `--radius-*` tokens |
| Transitions | `--transition-*` tokens |

---

## Styling Rules

1. **Balanced symmetric spacing** — mirror leading/trailing affordances; verify edge spacing numerically, not by eye
2. **No orphaned trailing margins** — insets equal on both edges
3. **UI self-verify** — screenshot-diff renders vs reference; measure alignment/borders/spacing numerically before presenting
4. **Sample colors from PNG** — not from video frames

---

## DataGrid Props (Extended in S-series)

```tsx
<DataGrid
  groupBy="campaignId"
  onRowClick={(row) => navigate(`/ads/${row.id}`)}
  keyboardNav={true}
/>
```

New props added for Ads Console: `groupBy`, `onRowClick`, `keyboardNav`.

---

## ToastProvider

> **Gotcha:** Ads routes need a local `ToastProvider` wrapping their route — it is NOT provided by the app shell on those pages.

---

## Related Notes

- [[08 - Web App (Next.js)]] — where the design system is consumed
- [[10 - Pages & Routes]] — pages built with these components

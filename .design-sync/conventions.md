## How to build with the Nexus Design System

Nexus is the operator console for a multi-marketplace commerce + advertising
platform (Amazon, eBay, Shopify). The look is **dense and legible** — Airtable
information density with a Stripe finish. Base type is 13px. Not minimalism:
visibility.

### Setup — there is no provider to wrap

Every component renders standalone. Load `styles.css` (it pulls in the tokens,
Inter and the component CSS) and use the components directly.

Two exceptions:
- **`ToastProvider`** — only needed if you call `useToast()`. Wrap the subtree.
- **Dark mode** — put `class="dark"` on an ancestor. Tokens re-point; no other change.

### The styling idiom — no utility classes

**This DS has no utility-class system.** Do not write `flex gap-2 text-sm
bg-white` — those class names resolve to nothing here. Components carry their
own internal `.h10-ds-*` classes; you never write one. Style a component
through its **props**, and style your own layout glue with **inline styles
using the CSS variables below**.

```jsx
<div style={{ display: 'flex', gap: 10, padding: 16,
              background: 'var(--surface-card)',
              border: '1px solid var(--border-default)', borderRadius: 10 }}>
```

### The token vocabulary — these are complete colours, use them bare

Never wrap these in `rgb()`; `var(--surface-card)` is already `#ffffff`.

| Family | Tokens |
|---|---|
| text | `--text-primary` `--text-secondary` `--text-tertiary` `--text-disabled` `--text-link` |
| surface | `--surface-canvas` `--surface-card` `--surface-sunken` |
| border | `--border-subtle` `--border-default` `--border-strong` |
| brand | `--color-primary` `--color-primary-soft` |
| status | `--status-{success,warning,danger,info}-{soft,line,strong}` |

There are **no** `--space-*`, `--radius-*` or `--font-size-*` CSS variables.
Spacing, radius and type scales are JavaScript exports on the same global:
`space.px12`, `radius`, `fontSize`, `shadow`, `zIndex`, `duration`, `color`.
Use plain numbers for layout; reach for `space` only when matching a component.

### One `tone` vocabulary, and two traps

Tones are `neutral · info · success · warning · danger`. Sizes are `sm md lg xl`.

- **`Pill tone="success"` is BLUE. `Tag tone="success"` is GREEN.** Different
  families on purpose. `Pill` is a status chip; `Tag` is a label.
- **`Badge` is not a generic badge** — it takes `program="sp"|"sb"|"sd"|"auto"|"manual"`
  and renders an Amazon ad-program chip. For a generic label use `Tag` or `Pill`.

### Composition notes worth knowing

- **`DataGrid`** is the workhorse. Columns are objects with `render(row)`, and
  support `sticky`, `align`, `sortable`, `total`. Pass `showTotals` for a totals row.
- **Fields have no `error` prop.** Compose validation: label above, message below
  in `var(--status-danger-strong)`, `aria-invalid` on the control.
- **`Button` has no `loading` prop.** The house pattern is a disabled `Button`
  with a `Spinner` in its children.
- Money and metrics: use the shipped formatters — `eur`, `eur0`, `num`, `pct`, `x2`.

### A real example

```jsx
const { PageHeader, Card, DataGrid, Pill, Badge, Button, eur } = window.NexusDS

<div style={{ background: 'var(--surface-canvas)', minHeight: '100vh' }}>
  <PageHeader title="Campaigns" subtitle="4 active · €2,340 spend today"
              actions={<Button variant="primary">Create campaign</Button>} />
  <div style={{ padding: '0 24px 24px' }}>
    <Card>
      <DataGrid
        rows={rows} rowKey={(r) => r.id} showTotals
        columns={[
          { key: 'name', label: 'Campaign', sticky: true, width: 220, sortable: true,
            render: (r) => <><Badge program={r.program}>{r.program.toUpperCase()}</Badge> {r.name}</> },
          { key: 'status', label: 'Status', render: (r) => <Pill tone={r.tone}>{r.status}</Pill> },
          { key: 'spend', label: 'Spend', align: 'right', render: (r) => eur(r.spend) },
        ]}
      />
    </Card>
  </div>
</div>
```

Read a component's `.prompt.md` and `.d.ts` before using it — they carry the real
props and the DS authors' own notes.

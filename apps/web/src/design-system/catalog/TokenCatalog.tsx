'use client'

/**
 * The living catalog — one screen that renders every design token, driven by the
 * actual token objects (`@/design-system/tokens`) so it can never drift from the
 * source of truth. Components are added here as Phases 3–5 land.
 *
 * Chrome uses `var(--h10-*)` (so the dark toggle exercises the CSS layer +
 * dark-readiness); swatches show the literal primitive/semantic values. This is
 * both the documentation surface and the screenshot-diff harness target
 * (.analysis/ds-catalog-verify.mjs captures it @2x).
 */

import { useState, type ReactNode } from 'react'
import { Search, Inbox, Home, Megaphone, BarChart3, Settings } from 'lucide-react'
import {
  palette,
  color,
  fontSize,
  fontWeight,
  letterSpacing,
  space,
  size,
  radius,
  shadow,
  focusRing,
  duration,
  zIndex,
  breakpoint,
} from '@/design-system/tokens'
import {
  Button,
  Pill,
  Badge,
  Input,
  Select,
  Checkbox,
  Toggle,
  Radio,
  RadioCard,
  Tooltip,
  Spinner,
  Skeleton,
  Kbd,
  Divider,
  type BadgeTone,
  type PillStatus,
} from '@/design-system/primitives'
import {
  Card as DSCard,
  EmptyState,
  Tabs,
  Pagination,
  ProgressBar,
  Modal,
  Drawer,
  Menu,
  MultiSelect,
  Combobox,
  MetricStrip,
  HoverCard,
  DateRangePicker,
  PerformanceGraph,
  Heatmap,
  DataGrid,
  type Column,
  ToastProvider,
  useToast,
} from '@/design-system/components'
import { AppShell, PageHeader, DetailHeader } from '@/design-system/patterns'

const ramps: Array<[string, Record<string, string>]> = [
  ['Blue', palette.blue],
  ['Grey', palette.grey],
  ['Green', palette.green],
  ['Red', palette.red],
  ['Amber', palette.amber],
  ['Purple', palette.purple],
  ['Cyan', palette.cyan],
]

const mono = "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, monospace"

function Section({ title, desc, children }: { title: string; desc?: string; children: ReactNode }) {
  return (
    <section style={{ marginBottom: 40 }}>
      <h2 style={{ fontSize: 18, fontWeight: 700, margin: '0 0 2px', letterSpacing: '-0.01em' }}>{title}</h2>
      {desc && <p style={{ fontSize: 13, color: 'var(--h10-text-3)', margin: '0 0 14px' }}>{desc}</p>}
      <div style={{ marginTop: desc ? 0 : 12 }}>{children}</div>
    </section>
  )
}

function Card({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        background: 'var(--h10-surface)',
        border: '1px solid var(--h10-border-subtle)',
        borderRadius: 12,
        padding: 18,
        boxShadow: 'var(--h10-shadow-card)',
      }}
    >
      {children}
    </div>
  )
}

function Swatch({ name, value }: { name: string; value: string }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div
        style={{
          height: 52,
          borderRadius: 8,
          background: value,
          border: '1px solid var(--h10-border-subtle)',
        }}
      />
      <div style={{ fontSize: 12, fontWeight: 600, marginTop: 6, overflow: 'hidden', textOverflow: 'ellipsis' }}>{name}</div>
      <div style={{ fontSize: 11, fontFamily: mono, color: 'var(--h10-text-3)' }}>{value}</div>
    </div>
  )
}

function SwatchGrid({ children }: { children: ReactNode }) {
  return <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(108px, 1fr))', gap: 12 }}>{children}</div>
}

function ToastButton() {
  const { toast } = useToast()
  return <Button onClick={() => toast('Changes saved', 'success')}>Show toast</Button>
}

// Self-contained demo: a local provider so the catalog needn't wrap its root.
function ToastDemo() {
  return (
    <ToastProvider>
      <ToastButton />
    </ToastProvider>
  )
}

// Deterministic sample data (Math.sin, no random) so SSR + client match.
const CHART_DATA = Array.from({ length: 14 }, (_, i) => ({
  day: `Jun ${i + 1}`,
  spend: 60 + Math.round(40 * Math.sin(i / 2) + i * 3),
  sales: 320 + Math.round(180 * Math.sin(i / 2 + 1) + i * 14),
}))
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const HOURS = Array.from({ length: 24 }, (_, h) => (h % 6 === 0 ? `${h}` : ''))
const HEAT_DATA = DAYS.map((_, d) =>
  Array.from({ length: 24 }, (_, h) => {
    const peak = Math.max(0, Math.sin(((h - 6) / 24) * Math.PI))
    return Math.round(peak * 100 * (0.55 + d * 0.07))
  }),
)

interface GridRow {
  id: string
  name: string
  status: PillStatus
  program: BadgeTone
  spend: number
  sales: number
  acos: number
}
const GRID_ROWS: GridRow[] = [
  { id: '1', name: 'Helmets · Auto', status: 'ok', program: 'sp', spend: 1284, sales: 8640, acos: 14.9 },
  { id: '2', name: 'Brand Defense', status: 'ok', program: 'sb', spend: 642, sales: 3120, acos: 20.6 },
  { id: '3', name: 'Retargeting', status: 'warn', program: 'sd', spend: 318, sales: 1090, acos: 29.2 },
  { id: '4', name: 'Gloves · Manual', status: 'arch', program: 'sp', spend: 96, sales: 410, acos: 23.4 },
]
const gridSum = (k: 'spend' | 'sales') => GRID_ROWS.reduce((s, r) => s + r[k], 0)
const STATUS_LABEL: Record<PillStatus, string> = { ok: 'Active', warn: 'Paused', arch: 'Archived' }
const GRID_COLS: Column<GridRow>[] = [
  {
    key: 'name',
    label: 'Campaign',
    sticky: true,
    width: 220,
    sortable: true,
    sortValue: (r) => r.name,
    render: (r) => (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
        <Badge tone={r.program}>{r.program.toUpperCase()}</Badge>
        <span style={{ fontWeight: 600 }}>{r.name}</span>
      </span>
    ),
  },
  { key: 'status', label: 'Status', render: (r) => <Pill status={r.status}>{STATUS_LABEL[r.status]}</Pill> },
  { key: 'spend', label: 'Spend', align: 'right', sortable: true, sortValue: (r) => r.spend, render: (r) => `€${r.spend.toLocaleString('en-IE')}`, total: `€${gridSum('spend').toLocaleString('en-IE')}` },
  { key: 'sales', label: 'Sales', align: 'right', sortable: true, sortValue: (r) => r.sales, render: (r) => `€${r.sales.toLocaleString('en-IE')}`, total: `€${gridSum('sales').toLocaleString('en-IE')}` },
  { key: 'acos', label: 'ACOS', align: 'right', sortable: true, sortValue: (r) => r.acos, render: (r) => `${r.acos}%` },
]

export function TokenCatalog() {
  const [dark, setDark] = useState(false)
  const [tab, setTab] = useState('overview')
  const [pg, setPg] = useState(2)
  const [modalOpen, setModalOpen] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [msVal, setMsVal] = useState<string[]>(['sp', 'sd'])
  const [comboVal, setComboVal] = useState('it')
  const [dateRange, setDateRange] = useState(() => ({ start: new Date(2026, 5, 1), end: new Date(2026, 5, 22) }))
  const [gridSel, setGridSel] = useState<Set<string>>(() => new Set(['1']))
  return (
    <div
      className={dark ? 'dark' : undefined}
      style={{
        background: 'var(--h10-bg)',
        color: 'var(--h10-text)',
        minHeight: '100vh',
        fontFamily: 'var(--h10-font-sans)',
        WebkitFontSmoothing: 'auto',
        padding: '32px 36px 64px',
      }}
    >
      <header style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 28 }}>
        <div>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--h10-text-3)' }}>Nexus Design System · H10</div>
          <h1 style={{ fontSize: 27, fontWeight: 800, letterSpacing: '-0.02em', margin: '2px 0 0' }}>Token Catalog</h1>
          <p style={{ fontSize: 13, color: 'var(--h10-text-2)', margin: '4px 0 0' }}>
            Phase 2 — the living style guide + verify harness target. Every value below is driven by{' '}
            <code style={{ fontFamily: mono }}>@/design-system/tokens</code>.
          </p>
        </div>
        <button
          onClick={() => setDark((d) => !d)}
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: 'var(--h10-text)',
            background: 'var(--h10-surface)',
            border: '1px solid var(--h10-border)',
            borderRadius: 8,
            padding: '8px 13px',
            cursor: 'pointer',
          }}
        >
          {dark ? '☀ Light' : '☾ Dark'}
        </button>
      </header>

      <Section title="Color — primitive ramps" desc="The raw scale. Components never consume these directly.">
        <Card>
          {ramps.map(([label, ramp]) => (
            <div key={label} style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--h10-text-3)', marginBottom: 8 }}>
                {label}
              </div>
              <SwatchGrid>
                {Object.entries(ramp).map(([k, v]) => (
                  <Swatch key={k} name={k} value={v} />
                ))}
              </SwatchGrid>
            </div>
          ))}
          <SwatchGrid>
            <Swatch name="white" value={palette.white} />
            <Swatch name="railBg" value={palette.railBg} />
            <Swatch name="railBorder" value={palette.railBorder} />
            <Swatch name="amazon" value={palette.amazon} />
          </SwatchGrid>
        </Card>
      </Section>

      <Section title="Color — semantic roles" desc="What components consume (text / surface / border / primary / status).">
        <Card>
          <SwatchGrid>
            {Object.entries(color).map(([k, v]) => (
              <Swatch key={k} name={k} value={v} />
            ))}
          </SwatchGrid>
        </Card>
      </Section>

      <section data-cat="primitives" style={{ marginBottom: 40 }}>
        <h2 style={{ fontSize: 18, fontWeight: 700, margin: '0 0 2px', letterSpacing: '-0.01em' }}>
          Primitives <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--h10-text-3)' }}>· Phase 3 · Wave 1</span>
        </h2>
        <p style={{ fontSize: 13, color: 'var(--h10-text-3)', margin: '0 0 14px' }}>
          Real components from <code style={{ fontFamily: mono }}>@/design-system/primitives</code>, tokenized to the H10 spec.
        </p>
        <Card>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--h10-text-3)', marginBottom: 10 }}>Button</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
            <Button variant="primary">Primary</Button>
            <Button variant="secondary">Secondary</Button>
            <Button variant="ghost">Ghost</Button>
            <Button variant="primary" size="sm">Small</Button>
            <Button variant="secondary" size="sm">Small</Button>
            <Button variant="primary" disabled>Disabled</Button>
            <Button variant="secondary" disabled>Disabled</Button>
          </div>

          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--h10-text-3)', margin: '18px 0 10px' }}>Status pill</div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <Pill status="ok">Active</Pill>
            <Pill status="warn">Paused</Pill>
            <Pill status="arch">Archived</Pill>
          </div>

          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--h10-text-3)', margin: '18px 0 10px' }}>Program / targeting badge</div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <Badge tone="sp">SP</Badge>
            <Badge tone="sd">SD</Badge>
            <Badge tone="sb">SB</Badge>
            <Badge tone="auto">A</Badge>
            <Badge tone="manual">M</Badge>
          </div>
        </Card>

        <Card>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--h10-text-3)', marginBottom: 10 }}>Input</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
            <Input placeholder="Plain input" />
            <Input leadingIcon={<Search size={15} />} placeholder="Search campaigns" />
            <Input prefix="€" placeholder="0.00" size={6} />
            <Input suffix="%" placeholder="0" size={4} />
          </div>

          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--h10-text-3)', margin: '18px 0 10px' }}>Select</div>
          <Select defaultValue="all">
            <option value="all">All campaigns</option>
            <option value="sp">Sponsored Products</option>
            <option value="sb">Sponsored Brands</option>
          </Select>

          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--h10-text-3)', margin: '18px 0 10px' }}>Checkbox</div>
          <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
            <Checkbox defaultChecked label="Checked" />
            <Checkbox label="Unchecked" />
            <Checkbox disabled label="Disabled" />
          </div>

          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--h10-text-3)', margin: '18px 0 10px' }}>Toggle</div>
          <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
            <Toggle checked />
            <Toggle checked={false} />
            <Toggle checked={false} disabled />
          </div>
        </Card>

        <Card>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--h10-text-3)', marginBottom: 10 }}>Radio</div>
          <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
            <Radio name="opt" defaultChecked label="Option A" />
            <Radio name="opt" label="Option B" />
            <Radio name="opt" disabled label="Disabled" />
          </div>

          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--h10-text-3)', margin: '18px 0 10px' }}>Radio card</div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <RadioCard name="tgt" defaultChecked selected title="Automatic" description="Amazon targets relevant searches" />
            <RadioCard name="tgt" title="Manual" description="You choose keywords & products" />
          </div>

          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--h10-text-3)', margin: '18px 0 10px' }}>Tooltip</div>
          <Tooltip label="Helpful hint shown on hover">
            <Button size="sm">Hover me</Button>
          </Tooltip>

          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--h10-text-3)', margin: '18px 0 10px' }}>Spinner</div>
          <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
            <Spinner />
            <Spinner size={22} />
          </div>

          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--h10-text-3)', margin: '18px 0 10px' }}>Skeleton</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxWidth: 240 }}>
            <Skeleton width={200} height={12} />
            <Skeleton width={140} height={12} />
          </div>

          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--h10-text-3)', margin: '18px 0 10px' }}>Kbd</div>
          <div style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
            <Kbd>⌘</Kbd>
            <Kbd>K</Kbd>
          </div>

          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--h10-text-3)', margin: '18px 0 10px' }}>Divider</div>
          <Divider />
        </Card>
      </section>

      <section data-cat="components" style={{ marginBottom: 40 }}>
        <h2 style={{ fontSize: 18, fontWeight: 700, margin: '0 0 2px', letterSpacing: '-0.01em' }}>
          Components <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--h10-text-3)' }}>· Phase 4 · Wave 1</span>
        </h2>
        <p style={{ fontSize: 13, color: 'var(--h10-text-3)', margin: '0 0 14px' }}>
          Composite components from <code style={{ fontFamily: mono }}>@/design-system/components</code>.
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 14, marginBottom: 14 }}>
          <DSCard header="Card with header" headerAction={<Button size="sm">Action</Button>}>
            <div style={{ fontSize: 13, color: 'var(--h10-text-2)' }}>Bordered surface with a header row and a padded body.</div>
          </DSCard>
          <DSCard padded elevated>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Padded + elevated</div>
            <div style={{ fontSize: 13, color: 'var(--h10-text-2)' }}>A plain padded card with the resting shadow.</div>
          </DSCard>
          <DSCard>
            <EmptyState
              icon={<Inbox size={20} />}
              title="No campaigns yet"
              description="Create your first campaign to start advertising."
              action={
                <Button variant="primary" size="sm">
                  New campaign
                </Button>
              }
            />
          </DSCard>
        </div>
        <DSCard padded elevated>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--h10-text-3)', marginBottom: 10 }}>Tabs</div>
          <Tabs
            tabs={[
              { id: 'overview', label: 'Overview' },
              { id: 'targeting', label: 'Targeting' },
              { id: 'history', label: 'History' },
            ]}
            active={tab}
            onChange={setTab}
          />

          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--h10-text-3)', margin: '18px 0 10px' }}>Pagination</div>
          <Pagination page={pg} pageCount={12} onPage={setPg} />

          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--h10-text-3)', margin: '18px 0 10px' }}>Progress</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 320 }}>
            <ProgressBar value={64} />
            <ProgressBar indeterminate />
          </div>
        </DSCard>

        <DSCard padded elevated>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--h10-text-3)', marginBottom: 10 }}>Overlays</div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <Button variant="primary" onClick={() => setModalOpen(true)}>
              Open modal
            </Button>
            <Button onClick={() => setDrawerOpen(true)}>Open drawer</Button>
            <Menu
              label="Actions ▾"
              items={[
                { id: 'edit', label: 'Edit' },
                { id: 'dup', label: 'Duplicate' },
                { id: 'arch', label: 'Archive', disabled: true },
              ]}
            />
          </div>
        </DSCard>

        <DSCard padded elevated>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--h10-text-3)', marginBottom: 10 }}>Multi-select</div>
          <MultiSelect
            options={[
              { value: 'sp', label: 'Sponsored Products' },
              { value: 'sb', label: 'Sponsored Brands' },
              { value: 'sd', label: 'Sponsored Display' },
            ]}
            value={msVal}
            onChange={setMsVal}
          />

          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--h10-text-3)', margin: '18px 0 10px' }}>Combobox</div>
          <Combobox
            options={[
              { value: 'it', label: 'Amazon Italy' },
              { value: 'de', label: 'Amazon Germany' },
              { value: 'fr', label: 'Amazon France' },
              { value: 'es', label: 'Amazon Spain' },
            ]}
            value={comboVal}
            onChange={setComboVal}
            placeholder="Search marketplace…"
          />

          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--h10-text-3)', margin: '18px 0 10px' }}>Toast</div>
          <ToastDemo />
        </DSCard>

        <DSCard padded elevated>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--h10-text-3)', marginBottom: 10 }}>Metric strip</div>
          <MetricStrip
            metrics={[
              { label: 'Spend', value: '€1,284', delta: { value: '▲ 12%', positive: true } },
              { label: 'Sales', value: '€8,640', delta: { value: '▲ 9%', positive: true } },
              { label: 'ACOS', value: '14.9%', delta: { value: '▼ 1.3pt', positive: true } },
              { label: 'Orders', value: '212', delta: { value: '▼ 3%', positive: false } },
            ]}
          />

          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--h10-text-3)', margin: '18px 0 10px' }}>Date range</div>
          <DateRangePicker value={dateRange} onChange={setDateRange} />

          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--h10-text-3)', margin: '18px 0 10px' }}>Hover card</div>
          <HoverCard
            card={
              <div>
                <div style={{ fontWeight: 700, marginBottom: 4 }}>Sponsored Products · Auto</div>
                <div style={{ fontSize: 12, color: 'var(--h10-text-3)' }}>Created 12 Mar 2026 · 3 ad groups · €1,284 spend</div>
              </div>
            }
          >
            <span style={{ color: 'var(--h10-primary)', fontWeight: 600, borderBottom: '1px dashed var(--h10-primary-ghost-border)' }}>Hover for details</span>
          </HoverCard>
        </DSCard>

        <Modal
          open={modalOpen}
          onClose={() => setModalOpen(false)}
          title="Create ad group"
          subtitle="Name it and set a default bid."
          footer={
            <>
              <Button onClick={() => setModalOpen(false)}>Cancel</Button>
              <Button variant="primary" onClick={() => setModalOpen(false)}>
                Create
              </Button>
            </>
          }
        >
          Modal body — forms, settings, confirmations. Esc or the backdrop closes it.
        </Modal>

        <Drawer
          open={drawerOpen}
          onClose={() => setDrawerOpen(false)}
          title="Campaign details"
          footer={
            <Button variant="primary" onClick={() => setDrawerOpen(false)}>
              Done
            </Button>
          }
        >
          Drawer body — a right-side slide-over for details, filters, or editing.
        </Drawer>
      </section>

      <section data-cat="charts" style={{ marginBottom: 40 }}>
        <h2 style={{ fontSize: 18, fontWeight: 700, margin: '0 0 2px', letterSpacing: '-0.01em' }}>
          Charts <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--h10-text-3)' }}>· Phase 4 · Wave 5</span>
        </h2>
        <p style={{ fontSize: 13, color: 'var(--h10-text-3)', margin: '0 0 14px' }}>
          Recharts dual-axis graph + intensity heatmap, tokenized.
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <DSCard padded elevated>
            <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--h10-text-3)', marginBottom: 10 }}>Performance · dual-axis</div>
            <PerformanceGraph
              data={CHART_DATA}
              xKey="day"
              left={{ key: 'spend', label: 'Spend', color: palette.blue[900], axis: 'left', format: (v) => `€${v}` }}
              right={{ key: 'sales', label: 'Sales', color: palette.blue[600], axis: 'right', format: (v) => `€${v}` }}
            />
          </DSCard>
          <DSCard padded elevated>
            <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--h10-text-3)', marginBottom: 10 }}>Heatmap · dayparting</div>
            <Heatmap data={HEAT_DATA} rowLabels={DAYS} colLabels={HOURS} format={(v) => `${v}`} />
          </DSCard>
        </div>
      </section>

      <section data-cat="datagrid" style={{ marginBottom: 40 }}>
        <h2 style={{ fontSize: 18, fontWeight: 700, margin: '0 0 2px', letterSpacing: '-0.01em' }}>
          DataGrid <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--h10-text-3)' }}>· Phase 4 · finale</span>
        </h2>
        <p style={{ fontSize: 13, color: 'var(--h10-text-3)', margin: '0 0 14px' }}>
          The universal grid — sortable headers, row selection, a pinned Campaign column, and a sticky totals row.
        </p>
        <DataGrid
          columns={GRID_COLS}
          rows={GRID_ROWS}
          rowKey={(r) => r.id}
          selectable
          selected={gridSel}
          onSelectedChange={setGridSel}
          showTotals
          initialSort={{ key: 'spend', dir: 'desc' }}
        />
      </section>

      <section data-cat="patterns" style={{ marginBottom: 40 }}>
        <h2 style={{ fontSize: 18, fontWeight: 700, margin: '0 0 2px', letterSpacing: '-0.01em' }}>
          Patterns <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--h10-text-3)' }}>· Phase 5 · Wave 1</span>
        </h2>
        <p style={{ fontSize: 13, color: 'var(--h10-text-3)', margin: '0 0 14px' }}>
          Page-level organisms — the app shell + headers that every section adopts.
        </p>

        <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--h10-text-3)', marginBottom: 10 }}>PageHeader</div>
        <DSCard padded elevated>
          <PageHeader
            eyebrow="Campaigns"
            title="Ad Manager"
            subtitle="212 active campaigns across 4 marketplaces"
            actions={
              <>
                <Button>Export</Button>
                <Button variant="primary">New campaign</Button>
              </>
            }
          />
        </DSCard>

        <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--h10-text-3)', margin: '18px 0 10px' }}>DetailHeader</div>
        <DSCard padded elevated>
          <DetailHeader
            backLabel="Back to Ad Manager"
            onBack={() => {}}
            badge={<Badge tone="auto">A</Badge>}
            title="Helmets · Auto"
            actions={<Button variant="primary">Edit</Button>}
          />
        </DSCard>

        <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--h10-text-3)', margin: '18px 0 10px' }}>
          AppShell <span style={{ textTransform: 'none', fontWeight: 500 }}>· hover the rail to expand</span>
        </div>
        <div style={{ height: 360, border: '1px solid var(--h10-border)', borderRadius: 12, overflow: 'hidden', position: 'relative' }}>
          <AppShell
            brand={{ mark: 'N', name: 'Nexus Ads' }}
            nav={[
              { id: 'home', label: 'Dashboard', icon: <Home size={20} />, active: true },
              { id: 'camp', label: 'Campaigns', icon: <Megaphone size={20} />, badge: 3 },
              { id: 'rep', label: 'Reporting', icon: <BarChart3 size={20} /> },
              { id: 'set', label: 'Settings', icon: <Settings size={20} /> },
            ]}
            footer="v2.0 · Nexus DS"
          >
            <PageHeader
              eyebrow="Campaigns"
              title="Ad Manager"
              subtitle="The rail collapses to icons; hover to expand it."
              actions={<Button variant="primary" size="sm">New</Button>}
            />
            <div style={{ fontSize: 13, color: 'var(--h10-text-2)' }}>Main content scrolls independently of the rail.</div>
          </AppShell>
        </div>
      </section>

      <Section title="Typography" desc="Inter via --font-sans, rendered with H10's heavier (auto) smoothing.">
        <Card>
          {Object.entries(fontSize).map(([k, v]) => (
            <div key={k} style={{ display: 'flex', alignItems: 'baseline', gap: 16, padding: '5px 0', borderBottom: '1px solid var(--h10-border-subtle)' }}>
              <code style={{ fontFamily: mono, fontSize: 12, color: 'var(--h10-text-3)', width: 120, flexShrink: 0 }}>
                {k} · {v}
              </code>
              <span style={{ fontSize: v, fontWeight: fontWeight.semibold }}>The quick brown fox</span>
            </div>
          ))}
          <div style={{ display: 'flex', gap: 18, marginTop: 12, flexWrap: 'wrap' }}>
            {Object.entries(fontWeight).map(([k, v]) => (
              <span key={k} style={{ fontSize: 15, fontWeight: v }}>
                {k} {v}
              </span>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 18, marginTop: 10, flexWrap: 'wrap', fontSize: 12, color: 'var(--h10-text-3)', fontFamily: mono }}>
            {Object.entries(letterSpacing).map(([k, v]) => (
              <span key={k}>
                {k}: {v}
              </span>
            ))}
          </div>
        </Card>
      </Section>

      <Section title="Spacing">
        <Card>
          {Object.entries(space).map(([k, v]) => (
            <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '3px 0' }}>
              <code style={{ fontFamily: mono, fontSize: 12, color: 'var(--h10-text-3)', width: 90, flexShrink: 0 }}>
                {k} · {v}
              </code>
              <div style={{ height: 12, width: v, background: 'var(--h10-primary)', borderRadius: 3 }} />
            </div>
          ))}
          <div style={{ fontSize: 12, color: 'var(--h10-text-3)', fontFamily: mono, marginTop: 10 }}>
            structural: rail {size.railCollapsed}→{size.railExpanded} · nav row {size.rowNav} · icon zone {size.iconZone}
          </div>
        </Card>
      </Section>

      <Section title="Radius">
        <Card>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 18 }}>
            {Object.entries(radius).map(([k, v]) => (
              <div key={k} style={{ textAlign: 'center' }}>
                <div style={{ width: 64, height: 64, background: 'var(--h10-wash-primary)', border: '1px solid var(--h10-primary-ghost-border)', borderRadius: v === '999px' ? '999px' : v }} />
                <div style={{ fontSize: 11, fontFamily: mono, color: 'var(--h10-text-3)', marginTop: 6 }}>
                  {k}·{v}
                </div>
              </div>
            ))}
          </div>
        </Card>
      </Section>

      <Section title="Elevation & focus">
        <Card>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 26 }}>
            {Object.entries(shadow).map(([k, v]) => (
              <div key={k} style={{ textAlign: 'center' }}>
                <div style={{ width: 132, height: 64, background: 'var(--h10-surface)', borderRadius: 10, boxShadow: v }} />
                <div style={{ fontSize: 11, fontFamily: mono, color: 'var(--h10-text-3)', marginTop: 10 }}>{k}</div>
              </div>
            ))}
            <div style={{ textAlign: 'center' }}>
              <div style={{ width: 132, height: 64, background: 'var(--h10-surface)', borderRadius: 8, boxShadow: focusRing, border: '1px solid var(--h10-primary)' }} />
              <div style={{ fontSize: 11, fontFamily: mono, color: 'var(--h10-text-3)', marginTop: 10 }}>focus ring</div>
            </div>
          </div>
        </Card>
      </Section>

      <Section title="Motion · z-index · breakpoints">
        <Card>
          <div style={{ fontFamily: mono, fontSize: 12, color: 'var(--h10-text-2)', lineHeight: 1.9 }}>
            <div>motion: {Object.entries(duration).map(([k, v]) => `${k} ${v}`).join(' · ')}</div>
            <div>z-index: {Object.entries(zIndex).map(([k, v]) => `${k} ${v}`).join(' · ')}</div>
            <div>breakpoints: {Object.entries(breakpoint).map(([k, v]) => `${k} ${v}`).join(' · ')}</div>
          </div>
        </Card>
      </Section>
    </div>
  )
}

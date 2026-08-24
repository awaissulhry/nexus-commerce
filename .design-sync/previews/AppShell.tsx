import {
  AppShell,
  Badge,
  Banner,
  Button,
  DataGrid,
  DetailHeader,
  GridToolbar,
  PageHeader,
  Pill,
  type Column,
} from '@nexus/design-system'
import { BarChart3, LayoutDashboard, Megaphone, Package, Settings, ShoppingCart, Tags } from 'lucide-react'

const BRAND = { mark: 'N', name: 'Nexus Commerce' }

/** The product's real information architecture — one flat item per workspace, groups for the deep sections. */
const nav = (activeId: string) => [
  { id: 'dash', label: 'Dashboard', icon: <LayoutDashboard size={20} />, active: activeId === 'dash' },
  { id: 'products', label: 'Products', icon: <Package size={20} />, active: activeId === 'products', badge: 12 },
  { id: 'listings', label: 'Listings', icon: <Tags size={20} />, active: activeId === 'listings' },
  { id: 'orders', label: 'Orders', icon: <ShoppingCart size={20} />, active: activeId === 'orders', badge: 4 },
  { id: 'ads', label: 'Advertising', icon: <Megaphone size={20} />, active: activeId === 'ads' },
  {
    id: 'reports',
    label: 'Reports',
    icon: <BarChart3 size={20} />,
    defaultOpen: true,
    items: [
      { id: 'rp-overview', label: 'Overview' },
      { id: 'rp-brand', label: 'Brand metrics' },
      { id: 'rp-sov', label: 'Share of Voice' },
    ],
  },
  { id: 'settings', label: 'Settings', icon: <Settings size={20} />, active: activeId === 'settings' },
]

const Frame = ({ children }: { children: React.ReactNode }) => (
  <div
    style={{
      height: 420,
      border: '1px solid var(--border-default)',
      borderRadius: 12,
      overflow: 'hidden',
      position: 'relative',
    }}
  >
    {children}
  </div>
)

type Row = { id: string; campaign: string; program: 'sp' | 'sb' | 'sd'; state: 'success' | 'warning'; spend: number; acos: number }

const ROWS: Row[] = [
  { id: '1', campaign: 'Helmets · Auto', program: 'sp', state: 'success', spend: 1284, acos: 14.9 },
  { id: '2', campaign: 'Brand Defense', program: 'sb', state: 'success', spend: 642, acos: 20.6 },
  { id: '3', campaign: 'Retargeting · IT', program: 'sd', state: 'warning', spend: 318, acos: 29.2 },
]

const COLS: Column<Row>[] = [
  {
    key: 'campaign',
    label: 'Campaign',
    width: 240,
    render: (r) => (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
        <Badge program={r.program}>{r.program.toUpperCase()}</Badge>
        <span style={{ fontWeight: 600 }}>{r.campaign}</span>
      </span>
    ),
  },
  { key: 'state', label: 'Status', render: (r) => <Pill tone={r.state}>{r.state === 'success' ? 'Active' : 'Paused'}</Pill> },
  { key: 'spend', label: 'Spend', align: 'right', render: (r) => `€${r.spend.toLocaleString('en-IE')}` },
  { key: 'acos', label: 'ACOS', align: 'right', render: (r) => `${r.acos}%` },
]

/**
 * The app frame doing its job: a 66px icon rail (it hover-expands to 248px and reveals
 * the labels + sub-items) beside a scrolling workspace — header, toolbar and grid.
 */
export const Workspace = () => (
  <Frame>
    <AppShell brand={BRAND} nav={nav('ads')} footer="Nexus 2.0 · Amazon IT">
      <PageHeader
        eyebrow="Advertising"
        title="Ad Manager"
        subtitle="212 active campaigns · €4,812 spend in the last 7 days"
        actions={
          <>
            <Button size="sm">Export</Button>
            <Button size="sm" variant="primary">New campaign</Button>
          </>
        }
      />
      <div className="h10-ds-gridcard">
        <GridToolbar
          count={<>Viewing <b>1–3</b> of 212 campaigns</>}
          right={<Button size="sm">Customise</Button>}
        />
        <DataGrid<Row> columns={COLS} rows={ROWS} rowKey={(r) => r.id} />
      </div>
    </AppShell>
  </Frame>
)

/** A drill-in route: same rail, a DetailHeader and a page-level banner in the content slot. */
export const DetailRoute = () => (
  <Frame>
    <AppShell brand={BRAND} nav={nav('products')} footer="Nexus 2.0 · Amazon IT">
      <DetailHeader
        backLabel="Back to Products"
        onBack={() => {}}
        badge={<Pill tone="success">Live</Pill>}
        title="Casco Integrale AGV K6 · NX-4471"
        actions={
          <>
            <Button size="sm">Duplicate</Button>
            <Button size="sm" variant="primary">Publish changes</Button>
          </>
        }
      />
      <Banner variant="warning" title="2 marketplaces missing a main image">
        Amazon DE and Amazon FR won&apos;t go live until a primary image is attached.
      </Banner>
      <div style={{ marginTop: 16, display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
        {[
          ['Available', '412 units'],
          ['Buy Box', '91% · 7 days'],
          ['Price', '€289.00'],
        ].map(([k, v]) => (
          <div
            key={k}
            style={{
              border: '1px solid var(--border-default)',
              borderRadius: 10,
              padding: '12px 14px',
              background: 'var(--surface-card)',
            }}
          >
            <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', fontWeight: 600 }}>{k}</div>
            <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--text-primary)', marginTop: 2 }}>{v}</div>
          </div>
        ))}
      </div>
    </AppShell>
  </Frame>
)

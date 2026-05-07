'use client'

// CR.5 — Carrier marketplace.
//
// Replaces the B.9 three-card grid with a discoverable view of every
// carrier the operator can reach: connected ones first, then directly-
// connectable ones, then the long tail reachable via Sendcloud's
// aggregator. Search + region filter narrow the list. Per-card status
// pill, capability badges, and a connect/update/disconnect action.
// Foundation primitives (<Card>, <Badge>, <Button>, <EmptyState>),
// Italian i18n via t(), dark-mode classes, mobile-responsive grid.

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Truck, ExternalLink, Lock, Package, MapPin, Search, Globe2, Tag,
  CheckCircle2, AlertCircle, Building2,
} from 'lucide-react'
import PageHeader from '@/components/layout/PageHeader'
import { Card } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { useToast } from '@/components/ui/Toast'
import { useConfirm } from '@/components/ui/ConfirmProvider'
import { useTranslations } from '@/lib/i18n/use-translations'
import { getBackendUrl } from '@/lib/backend-url'

// ── Types ───────────────────────────────────────────────────────────
type CarrierRow = {
  id: string
  code: string
  name: string
  isActive: boolean
  hasCredentials: boolean
  defaultServiceMap: any
  updatedAt: string
  // CR.3 columns. Optional because a freshly-deployed instance may
  // not have these populated yet on legacy rows.
  lastUsedAt?: string | null
  lastVerifiedAt?: string | null
  lastErrorAt?: string | null
  lastError?: string | null
  mode?: 'sandbox' | 'production'
  accountLabel?: string | null
}

type Region = 'IT' | 'EU' | 'INTL'
type Capability = 'label' | 'rates' | 'tracking' | 'pickup' | 'intl' | 'cod' | 'servicePoints'
type Connect = 'direct' | 'via-sendcloud' | 'manual'

interface CarrierDef {
  code: string
  label: string
  description: string
  docsUrl: string | null
  connect: Connect
  regions: Region[]
  capabilities: Capability[]
  // Direct-connect carriers expose credential fields; via-Sendcloud
  // carriers don't (you connect them by connecting Sendcloud).
  fields: Array<{
    key: string
    labelKey: string
    password?: boolean
    type?: 'number'
  }>
}

// ── Catalog ────────────────────────────────────────────────────────
// Direct-connect carriers map to CarrierCode enum values today
// (SENDCLOUD, AMAZON_BUY_SHIPPING, MANUAL). The via-Sendcloud rows
// are informational — connecting Sendcloud unlocks their labels via
// shipping_method aggregation. Future CR.18+ may promote some to
// direct-connect when a native client lands.
const CATALOG: CarrierDef[] = [
  {
    code: 'SENDCLOUD',
    label: 'Sendcloud',
    description: 'European multi-carrier hub. One integration covers BRT, GLS, Poste, DHL, UPS, FedEx, DPD and more. Recommended.',
    docsUrl: 'https://api.sendcloud.dev/docs/sendcloud-public-api/',
    connect: 'direct',
    regions: ['IT', 'EU', 'INTL'],
    capabilities: ['label', 'rates', 'tracking', 'pickup', 'intl', 'servicePoints'],
    fields: [
      { key: 'publicKey', labelKey: 'carriers.field.publicKey' },
      { key: 'privateKey', labelKey: 'carriers.field.privateKey', password: true },
      { key: 'integrationId', labelKey: 'carriers.field.integrationId', type: 'number' },
    ],
  },
  {
    code: 'AMAZON_BUY_SHIPPING',
    label: 'Amazon Buy Shipping',
    description: 'For FBM orders fulfilled directly through Amazon. Uses Seller Central credentials — no extra setup. Often 30-50% cheaper than retail.',
    docsUrl: 'https://developer-docs.amazon.com/sp-api/docs/shipping-api-v1-reference',
    connect: 'direct',
    regions: ['IT', 'EU', 'INTL'],
    capabilities: ['label', 'rates', 'tracking'],
    fields: [],
  },
  {
    code: 'MANUAL',
    label: 'Manual labels',
    description: 'Skip carrier integration — print labels elsewhere and paste tracking numbers manually. No setup.',
    docsUrl: null,
    connect: 'manual',
    regions: ['IT', 'EU', 'INTL'],
    capabilities: ['tracking'],
    fields: [],
  },
  // ── Via Sendcloud ───────────────────────────────────────────────
  { code: 'BRT', label: 'BRT (Bartolini)', description: 'Italy domestic — accessed via your Sendcloud connection.', docsUrl: 'https://www.brt.it/', connect: 'via-sendcloud', regions: ['IT'], capabilities: ['label', 'rates', 'tracking', 'pickup', 'cod'], fields: [] },
  { code: 'POSTE', label: 'Poste Italiane', description: 'Italy domestic — Posta1, Crono, COD-supported services via Sendcloud.', docsUrl: 'https://www.poste.it/', connect: 'via-sendcloud', regions: ['IT'], capabilities: ['label', 'tracking', 'cod'], fields: [] },
  { code: 'GLS', label: 'GLS Italy', description: 'Italy domestic — Business Parcel via Sendcloud aggregation.', docsUrl: 'https://www.gls-italy.com/', connect: 'via-sendcloud', regions: ['IT'], capabilities: ['label', 'rates', 'tracking', 'pickup'], fields: [] },
  { code: 'SDA', label: 'SDA', description: 'Italy domestic — Poste Italiane group, B2B-friendly.', docsUrl: 'https://www.sda.it/', connect: 'via-sendcloud', regions: ['IT'], capabilities: ['label', 'tracking'], fields: [] },
  { code: 'TNT', label: 'TNT (FedEx)', description: 'EU + international — express services via Sendcloud.', docsUrl: 'https://www.tnt.com/', connect: 'via-sendcloud', regions: ['IT', 'EU', 'INTL'], capabilities: ['label', 'tracking', 'intl'], fields: [] },
  { code: 'DHL', label: 'DHL Express', description: 'International express — high-value declarations + customs.', docsUrl: 'https://www.dhl.com/', connect: 'via-sendcloud', regions: ['EU', 'INTL'], capabilities: ['label', 'tracking', 'intl', 'pickup'], fields: [] },
  { code: 'UPS', label: 'UPS', description: 'International — broad coverage via Sendcloud.', docsUrl: 'https://www.ups.com/', connect: 'via-sendcloud', regions: ['EU', 'INTL'], capabilities: ['label', 'tracking', 'intl'], fields: [] },
  { code: 'FEDEX', label: 'FedEx', description: 'International — priority + economy services.', docsUrl: 'https://www.fedex.com/', connect: 'via-sendcloud', regions: ['EU', 'INTL'], capabilities: ['label', 'tracking', 'intl'], fields: [] },
  { code: 'DPD', label: 'DPD', description: 'EU — last-mile-strong network via Sendcloud.', docsUrl: 'https://www.dpd.com/', connect: 'via-sendcloud', regions: ['EU'], capabilities: ['label', 'tracking', 'pickup'], fields: [] },
  { code: 'CHRONOPOST', label: 'Chronopost', description: 'France domestic + EU — La Poste group.', docsUrl: 'https://www.chronopost.fr/', connect: 'via-sendcloud', regions: ['EU'], capabilities: ['label', 'tracking'], fields: [] },
  { code: 'DSV', label: 'DSV', description: 'EU + intl freight forwarder — heavy goods.', docsUrl: 'https://www.dsv.com/', connect: 'via-sendcloud', regions: ['EU', 'INTL'], capabilities: ['label', 'tracking'], fields: [] },
]

const REGION_FILTER: Array<{ region: Region | 'ALL'; key: string }> = [
  { region: 'ALL', key: 'carriers.filter.region.all' },
  { region: 'IT', key: 'carriers.filter.region.it' },
  { region: 'EU', key: 'carriers.filter.region.eu' },
  { region: 'INTL', key: 'carriers.filter.region.intl' },
]

// ── Workspace ──────────────────────────────────────────────────────
export default function CarriersWorkspace() {
  const { t } = useTranslations()
  const [carriers, setCarriers] = useState<CarrierRow[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [region, setRegion] = useState<Region | 'ALL'>('ALL')

  const fetchCarriers = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`${getBackendUrl()}/api/fulfillment/carriers`, { cache: 'no-store' })
      if (res.ok) {
        const data = await res.json()
        setCarriers(data.items ?? [])
      }
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchCarriers()
  }, [fetchCarriers])

  // Sendcloud is the cornerstone of the via-Sendcloud rows. When it's
  // not connected, those rows show as "via Sendcloud — connect Sendcloud
  // first" rather than "ready". We surface the state so the UI can
  // hint correctly without a second fetch per card.
  const sendcloudConnected = useMemo(
    () => carriers.some((c) => c.code === 'SENDCLOUD' && c.isActive),
    [carriers],
  )

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return CATALOG.filter((d) => {
      if (region !== 'ALL' && !d.regions.includes(region)) return false
      if (q) {
        const hay = `${d.label} ${d.code} ${d.description}`.toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
  }, [search, region])

  const connectedCarriers = filtered.filter((d) =>
    carriers.some((c) => c.code === d.code && c.isActive),
  )
  const directCarriers = filtered.filter(
    (d) => d.connect !== 'via-sendcloud' && !carriers.some((c) => c.code === d.code && c.isActive),
  )
  const viaSendcloudCarriers = filtered.filter((d) => d.connect === 'via-sendcloud')

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('carriers.title')}
        description={t('carriers.description')}
        breadcrumbs={[
          { label: t('nav.fulfillment'), href: '/fulfillment' },
          { label: t('carriers.title') },
        ]}
      />

      {/* Search + region filter */}
      <div className="flex flex-col sm:flex-row gap-2 sm:items-center">
        <div className="relative flex-1">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 dark:text-slate-500" aria-hidden />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('carriers.search.placeholder')}
            className="h-9 w-full pl-8 pr-3 text-base border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 dark:text-slate-100"
            aria-label={t('common.search')}
          />
        </div>
        <div className="inline-flex rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 overflow-hidden">
          {REGION_FILTER.map((r) => (
            <button
              key={r.region}
              onClick={() => setRegion(r.region)}
              className={`px-3 h-9 text-base border-r last:border-r-0 border-slate-200 dark:border-slate-700 transition-colors ${
                region === r.region
                  ? 'bg-blue-50 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300 font-semibold'
                  : 'text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800'
              }`}
              aria-pressed={region === r.region}
            >
              {t(r.key)}
            </button>
          ))}
        </div>
      </div>

      {loading && carriers.length === 0 ? (
        <Card>
          <div className="text-md text-slate-500 dark:text-slate-400 py-8 text-center">
            {t('common.loading')}
          </div>
        </Card>
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={Truck}
          title={t('carriers.empty.title')}
          description={t('carriers.empty.description')}
        />
      ) : (
        <div className="space-y-6">
          {/* ── Connected ────────────────────────────────────────── */}
          <Section
            title={t('carriers.section.connected')}
            count={connectedCarriers.length}
            empty={connectedCarriers.length === 0 ? t('carriers.section.connectedNone') : null}
          >
            {connectedCarriers.map((def) => {
              const carrier = carriers.find((c) => c.code === def.code) ?? null
              return (
                <CarrierCard
                  key={def.code}
                  def={def}
                  carrier={carrier}
                  sendcloudConnected={sendcloudConnected}
                  onChanged={fetchCarriers}
                />
              )
            })}
          </Section>

          {/* ── Direct connect ───────────────────────────────────── */}
          {directCarriers.length > 0 && (
            <Section title={t('carriers.section.directConnect')} count={directCarriers.length}>
              {directCarriers.map((def) => (
                <CarrierCard
                  key={def.code}
                  def={def}
                  carrier={null}
                  sendcloudConnected={sendcloudConnected}
                  onChanged={fetchCarriers}
                />
              ))}
            </Section>
          )}

          {/* ── Via Sendcloud ────────────────────────────────────── */}
          {viaSendcloudCarriers.length > 0 && (
            <Section
              title={t('carriers.section.viaSendcloud')}
              count={viaSendcloudCarriers.length}
              hint={t('carriers.section.viaSendcloudHint')}
            >
              {viaSendcloudCarriers.map((def) => (
                <CarrierCard
                  key={def.code}
                  def={def}
                  carrier={null}
                  sendcloudConnected={sendcloudConnected}
                  onChanged={fetchCarriers}
                />
              ))}
            </Section>
          )}
        </div>
      )}

      {/* How it works */}
      <Card>
        <div className="text-base text-slate-600 dark:text-slate-300 space-y-1">
          <div className="font-semibold text-slate-900 dark:text-slate-100">
            {t('carriers.howItWorks.title')}
          </div>
          <ul className="list-disc list-inside space-y-0.5 text-base">
            <li>{t('carriers.howItWorks.b1')}</li>
            <li>{t('carriers.howItWorks.b2')}</li>
            <li>{t('carriers.howItWorks.b3')}</li>
            <li>{t('carriers.howItWorks.b4')}</li>
          </ul>
        </div>
      </Card>
    </div>
  )
}

// ── Section header + grid ──────────────────────────────────────────
function Section({
  title, count, hint, empty, children,
}: {
  title: string
  count: number
  hint?: string
  empty?: string | null
  children: React.ReactNode
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-baseline gap-2">
        <h2 className="text-md font-semibold text-slate-900 dark:text-slate-100">{title}</h2>
        <Badge variant="default" size="sm">{count}</Badge>
      </div>
      {hint && <div className="text-sm text-slate-500 dark:text-slate-400">{hint}</div>}
      {empty ? (
        <Card>
          <div className="text-base text-slate-500 dark:text-slate-400 py-3 text-center">{empty}</div>
        </Card>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">{children}</div>
      )}
    </div>
  )
}

// ── Carrier card ───────────────────────────────────────────────────
function CarrierCard({
  def, carrier, sendcloudConnected, onChanged,
}: {
  def: CarrierDef
  carrier: CarrierRow | null
  sendcloudConnected: boolean
  onChanged: () => void
}) {
  const { t } = useTranslations()
  const { toast } = useToast()
  const askConfirm = useConfirm()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [fields, setFields] = useState<Record<string, string>>({})

  const isConnected = !!carrier?.isActive
  const hasError = !!(carrier?.lastError && carrier?.lastErrorAt)

  const connect = async () => {
    setBusy(true)
    try {
      const body: any = {}
      for (const f of def.fields) {
        const v = fields[f.key]
        if (f.type === 'number') body[f.key] = v ? Number(v) : undefined
        else body[f.key] = v
      }
      const res = await fetch(
        `${getBackendUrl()}/api/fulfillment/carriers/${def.code}/connect`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      )
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error ?? 'Connect failed')
      }
      setOpen(false)
      setFields({})
      onChanged()
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setBusy(false)
    }
  }

  const disconnect = async () => {
    const ok = await askConfirm({
      title: t('carriers.disconnect.title', { name: def.label }),
      description: t('carriers.disconnect.description'),
      confirmLabel: t('carriers.action.disconnect'),
      tone: 'danger',
    })
    if (!ok) return
    const res = await fetch(
      `${getBackendUrl()}/api/fulfillment/carriers/${def.code}/disconnect`,
      { method: 'POST' },
    )
    if (res.ok) onChanged()
    else toast.error('Disconnect failed')
  }

  const testConnection = async () => {
    const res = await fetch(
      `${getBackendUrl()}/api/fulfillment/carriers/${def.code}/test`,
      { method: 'POST' },
    )
    const body = await res.json().catch(() => ({}))
    if (body.dryRun) {
      toast.success(t('carriers.test.dryRun'))
      return
    }
    if (body.ok) {
      toast.success(t('carriers.test.success', { username: body.username ?? '?' }))
    } else {
      toast.error(t('carriers.test.failed', { reason: body.error ?? body.reason ?? 'unknown' }))
    }
  }

  // Status pill resolution
  const statusPill = isConnected
    ? hasError
      ? <Badge variant="warning" size="sm">{t('carriers.status.error')}</Badge>
      : <Badge variant="success" size="sm">{t('carriers.status.connected')}</Badge>
    : def.connect === 'via-sendcloud'
    ? sendcloudConnected
      ? <Badge variant="success" size="sm">{t('carriers.status.viaSendcloud')}</Badge>
      : <Badge variant="default" size="sm">{t('carriers.status.viaSendcloud')}</Badge>
    : <Badge variant="default" size="sm">{t('carriers.status.notConnected')}</Badge>

  return (
    <Card>
      <div className="space-y-3">
        {/* Header row */}
        <div className="flex items-start gap-3">
          <div
            className={`w-10 h-10 rounded-md inline-flex items-center justify-center flex-shrink-0 ${
              isConnected
                ? 'bg-emerald-50 text-emerald-600 dark:bg-emerald-900/30 dark:text-emerald-400'
                : 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400'
            }`}
            aria-hidden
          >
            <Truck size={18} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-lg font-semibold text-slate-900 dark:text-slate-100 truncate">
                {def.label}
              </span>
              {statusPill}
              {isConnected && carrier?.mode === 'sandbox' && (
                <Badge variant="default" size="sm">sandbox</Badge>
              )}
            </div>
            <div className="text-sm text-slate-500 dark:text-slate-400 mt-1">{def.description}</div>
          </div>
        </div>

        {/* Region + capability badges */}
        <div className="flex items-center gap-1.5 flex-wrap">
          {def.regions.map((r) => (
            <span
              key={r}
              className="inline-flex items-center gap-0.5 px-1.5 h-5 rounded text-xs bg-slate-50 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700"
            >
              {r === 'IT' ? <Building2 size={9} /> : <Globe2 size={9} />}
              {t(`carriers.region.${r.toLowerCase()}`)}
            </span>
          ))}
          {def.capabilities.map((cap) => (
            <span
              key={cap}
              className="inline-flex items-center gap-0.5 px-1.5 h-5 rounded text-xs text-slate-500 dark:text-slate-400"
              title={t(`carriers.cap.${cap}`)}
            >
              <CapIcon cap={cap} />
              {t(`carriers.cap.${cap}`)}
            </span>
          ))}
        </div>

        {/* Last verified / last used (when connected) */}
        {isConnected && (carrier?.lastVerifiedAt || carrier?.lastUsedAt) && (
          <div className="flex items-center gap-3 text-xs text-slate-500 dark:text-slate-400 flex-wrap">
            {carrier?.lastVerifiedAt && (
              <span className="inline-flex items-center gap-1">
                <CheckCircle2 size={11} className="text-emerald-500" />
                {t('carriers.status.verified', { when: relTime(carrier.lastVerifiedAt) })}
              </span>
            )}
            {carrier?.lastUsedAt && (
              <span className="inline-flex items-center gap-1">
                <Tag size={11} />
                {t('carriers.status.lastUsed', { when: relTime(carrier.lastUsedAt) })}
              </span>
            )}
          </div>
        )}

        {/* Last error */}
        {isConnected && hasError && (
          <div className="flex items-start gap-1.5 text-sm text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded p-2">
            <AlertCircle size={12} className="flex-shrink-0 mt-0.5" />
            <span className="break-words">{carrier?.lastError}</span>
          </div>
        )}

        {/* Docs link */}
        {def.docsUrl && (
          <a
            href={def.docsUrl}
            target="_blank"
            rel="noreferrer"
            className="text-sm text-blue-600 dark:text-blue-400 hover:underline inline-flex items-center gap-1"
          >
            {t('carriers.action.docs')} <ExternalLink size={10} />
          </a>
        )}

        {/* Actions */}
        {def.connect === 'via-sendcloud' ? (
          <div className="text-sm text-slate-500 dark:text-slate-400">
            {sendcloudConnected
              ? t('carriers.section.viaSendcloudHint')
              : (
                <a
                  href="#"
                  onClick={(e) => { e.preventDefault(); document.getElementById('connect-SENDCLOUD')?.scrollIntoView({ behavior: 'smooth' }) }}
                  className="text-blue-600 dark:text-blue-400 hover:underline"
                >
                  {t('carriers.action.connect')} Sendcloud →
                </a>
              )}
          </div>
        ) : def.connect === 'manual' ? (
          isConnected ? (
            <div className="flex gap-2">
              <Button variant="danger" size="sm" onClick={disconnect}>
                {t('carriers.action.disconnect')}
              </Button>
            </div>
          ) : (
            <Button variant="primary" size="sm" icon={<Lock size={11} />} onClick={() => connect()} loading={busy}>
              {t('carriers.action.connect')}
            </Button>
          )
        ) : open ? (
          <div id={`connect-${def.code}`} className="space-y-2 pt-2 border-t border-slate-100 dark:border-slate-800">
            {def.fields.map((f) => (
              <div key={f.key}>
                <label className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold mb-0.5 block">
                  {t(f.labelKey)}
                </label>
                <input
                  type={f.password ? 'password' : f.type === 'number' ? 'number' : 'text'}
                  value={fields[f.key] ?? ''}
                  onChange={(e) => setFields({ ...fields, [f.key]: e.target.value })}
                  className="h-8 w-full px-2 text-base font-mono border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 dark:text-slate-100 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                  autoComplete="off"
                  aria-label={t(f.labelKey)}
                />
              </div>
            ))}
            <div className="flex items-center gap-2 pt-1">
              <Button variant="primary" size="sm" onClick={connect} loading={busy}>
                {t('common.save')}
              </Button>
              <Button variant="secondary" size="sm" onClick={() => { setOpen(false); setFields({}) }}>
                {t('common.cancel')}
              </Button>
            </div>
          </div>
        ) : isConnected ? (
          <div className="flex items-center gap-2 flex-wrap">
            <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
              {t('carriers.action.update')}
            </Button>
            <Button variant="secondary" size="sm" onClick={testConnection}>
              {t('carriers.action.test')}
            </Button>
            <Button variant="danger" size="sm" onClick={disconnect}>
              {t('carriers.action.disconnect')}
            </Button>
          </div>
        ) : (
          <Button
            variant="primary"
            size="sm"
            icon={<Lock size={11} />}
            onClick={() => setOpen(true)}
            id={`connect-${def.code}`}
          >
            {t('carriers.action.connect')}
          </Button>
        )}
      </div>
    </Card>
  )
}

// ── Helpers ────────────────────────────────────────────────────────
function CapIcon({ cap }: { cap: Capability }) {
  const map: Record<Capability, React.ReactNode> = {
    label: <Package size={9} />,
    rates: <Tag size={9} />,
    tracking: <Truck size={9} />,
    pickup: <MapPin size={9} />,
    intl: <Globe2 size={9} />,
    cod: <Tag size={9} />,
    servicePoints: <MapPin size={9} />,
  }
  return <>{map[cap]}</>
}

/** Compact relative-time formatter ("2h ago", "3d ago") for status chips. */
function relTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 0) return ''
  const sec = Math.floor(ms / 1000)
  if (sec < 60) return `${sec}s ago`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const d = Math.floor(hr / 24)
  if (d < 30) return `${d}d ago`
  const mo = Math.floor(d / 30)
  return `${mo}mo ago`
}

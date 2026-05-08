'use client'

// E.1 — Promotion calendar surface.
//
// Reads /api/pricing/promotions (GET) which buckets RetailEvent rows into
// active / upcoming / ended. Each event carries its RetailEventPriceAction
// children so the operator sees "what's running, what's queued, what just
// finished" at a glance. The "Run scheduler now" button fires the same
// G.5.2 promotion-scheduler tick the hourly cron runs — useful when the
// operator just created an event whose window has already started and
// they don't want to wait for the next :00.

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import {
  AlertCircle,
  CalendarRange,
  CheckCircle2,
  Clock3,
  Loader2,
  PlayCircle,
  Plus,
  Tag,
  Trash2,
} from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { Button } from '@/components/ui/Button'
import { Modal, ModalBody, ModalFooter } from '@/components/ui/Modal'
import { IconButton } from '@/components/ui/IconButton'
import { Tabs, type Tab } from '@/components/ui/Tabs'
import { useToast } from '@/components/ui/Toast'
import { useConfirm } from '@/components/ui/ConfirmProvider'
import { useTranslations } from '@/lib/i18n/use-translations'
import { getBackendUrl } from '@/lib/backend-url'
import { cn } from '@/lib/utils'

interface PriceAction {
  id: string
  channel: string | null
  marketplace: string | null
  productType: string | null
  action: 'PERCENT_OFF' | 'FIXED_PRICE'
  value: string
  isActive: boolean
  setSalePriceFrom: string | null
  setSalePriceUntil: string | null
}

interface RetailEvent {
  id: string
  name: string
  startDate: string
  endDate: string
  channel: string | null
  marketplace: string | null
  productType: string | null
  expectedLift: string
  prepLeadTimeDays: number
  description: string | null
  source: string | null
  isActive: boolean
  priceActions: PriceAction[]
}

interface PromotionsResponse {
  counts: { active: number; upcoming: number; ended: number; total: number }
  active: RetailEvent[]
  upcoming: RetailEvent[]
  ended: RetailEvent[]
}

type PromoTab = 'all' | 'active' | 'upcoming' | 'ended'

export default function PromotionsClient() {
  const { t } = useTranslations()
  const [data, setData] = useState<PromotionsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [activeTab, setActiveTab] = useState<PromoTab>('all')
  const { toast } = useToast()
  const confirm = useConfirm()

  const fetchData = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`${getBackendUrl()}/api/pricing/promotions`, {
        cache: 'no-store',
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setData(await res.json())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  const runScheduler = async () => {
    setRunning(true)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/pricing/run-promotions`,
        { method: 'POST' },
      )
      const json = await res.json()
      if (json.ok) {
        toast.success(
          t('pricing.promotions.schedulerSuccess', {
            entered: json.enteredEvents,
            exited: json.exitedEvents,
            listings: json.listingsUpdated,
            snapshots: json.snapshotsRefreshed,
          }),
        )
        await fetchData()
      } else {
        toast.error(
          t('pricing.promotions.schedulerFailed', {
            error: json.error ?? 'unknown error',
          }),
        )
      }
    } catch (e) {
      toast.error(
        t('pricing.promotions.schedulerFailed', {
          error: e instanceof Error ? e.message : String(e),
        }),
      )
    } finally {
      setRunning(false)
    }
  }

  if (loading && !data) {
    return (
      <Card>
        <div className="text-md text-slate-500 dark:text-slate-400 py-8 text-center inline-flex items-center justify-center gap-2 w-full">
          <Loader2 className="w-4 h-4 animate-spin" /> {t('pricing.promotions.loading')}
        </div>
      </Card>
    )
  }

  if (error) {
    return (
      <div className="border border-rose-200 dark:border-rose-900 bg-rose-50 dark:bg-rose-950 rounded px-3 py-2 text-base text-rose-700 dark:text-rose-300 inline-flex items-start gap-1.5">
        <AlertCircle size={14} className="mt-0.5 flex-shrink-0" />
        <span>{error}</span>
      </div>
    )
  }

  const deleteEvent = async (eventId: string, name: string) => {
    const ok = await confirm({
      title: t('pricing.promotions.deleteTitle'),
      description: t('pricing.promotions.deleteConfirm', { name }),
      confirmLabel: t('common.delete'),
      tone: 'danger',
    })
    if (!ok) return
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/pricing/promotions/${eventId}`,
        { method: 'DELETE' },
      )
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        throw new Error(j.error ?? `HTTP ${res.status}`)
      }
      toast.success(t('pricing.promotions.deleted', { name }))
      await fetchData()
    } catch (e) {
      toast.error(
        t('pricing.promotions.deleteFailed', {
          error: e instanceof Error ? e.message : String(e),
        }),
      )
    }
  }

  if (!data || data.counts.total === 0) {
    return (
      <>
        <div className="flex items-center justify-end mb-3">
          <Button
            variant="primary"
            size="md"
            onClick={() => setCreateOpen(true)}
            icon={<Plus size={14} />}
          >
            {t('pricing.promotions.create')}
          </Button>
        </div>
        <EmptyState
          icon={CalendarRange}
          title={t('pricing.promotions.empty')}
          description={t('pricing.promotions.emptyHint')}
        />
        {createOpen && (
          <CreatePromotionModal
            onClose={() => setCreateOpen(false)}
            onCreated={async () => {
              setCreateOpen(false)
              await fetchData()
            }}
          />
        )}
      </>
    )
  }

  return (
    <div className="space-y-4">
      {/* Action row */}
      <div className="flex items-center justify-end">
        <Button
          variant="primary"
          size="md"
          onClick={() => setCreateOpen(true)}
          icon={<Plus size={14} />}
        >
          {t('pricing.promotions.create')}
        </Button>
      </div>

      {/* Counts banner + manual scheduler trigger */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 items-stretch">
        <CountTile
          icon={PlayCircle}
          label={t('pricing.promotions.bucket.active')}
          value={data.counts.active}
          tone={data.counts.active > 0 ? 'emerald' : 'slate'}
          hint={t('pricing.promotions.bucket.activeHint')}
        />
        <CountTile
          icon={Clock3}
          label={t('pricing.promotions.bucket.upcoming')}
          value={data.counts.upcoming}
          tone={data.counts.upcoming > 0 ? 'blue' : 'slate'}
          hint={t('pricing.promotions.bucket.upcomingHint')}
        />
        <CountTile
          icon={CheckCircle2}
          label={t('pricing.promotions.bucket.ended')}
          value={data.counts.ended}
          tone="slate"
          hint={t('pricing.promotions.bucket.endedHint')}
        />
        <Card>
          <div className="space-y-2">
            <div className="text-sm uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold">
              {t('pricing.promotions.scheduler')}
            </div>
            <Button
              variant="primary"
              size="md"
              onClick={runScheduler}
              loading={running}
              disabled={running}
              icon={running ? null : <PlayCircle size={14} />}
            >
              {running
                ? t('pricing.promotions.runningScheduler')
                : t('pricing.promotions.runScheduler')}
            </Button>
            <div className="text-sm text-slate-500 dark:text-slate-400">
              {t('pricing.promotions.schedulerHint')}
            </div>
          </div>
        </Card>
      </div>

      {/* UI.9 — Sub-tabs for the three lifecycle buckets */}
      <Tabs
        tabs={[
          {
            id: 'all',
            label: t('pricing.promotions.tab.all'),
            count:
              data.active.length + data.upcoming.length + data.ended.length,
          },
          {
            id: 'active',
            label: t('pricing.promotions.tab.active'),
            count: data.active.length,
          },
          {
            id: 'upcoming',
            label: t('pricing.promotions.tab.upcoming'),
            count: data.upcoming.length,
          },
          {
            id: 'ended',
            label: t('pricing.promotions.tab.ended'),
            count: data.ended.length,
          },
        ] as Tab[]}
        activeTab={activeTab}
        onChange={(id) => setActiveTab(id as PromoTab)}
      />

      {/* Active events */}
      {(activeTab === 'all' || activeTab === 'active') && data.active.length > 0 && (
        <EventSection
          label={t('pricing.promotions.section.active', { n: data.active.length })}
          tone="emerald"
          events={data.active}
          onDelete={deleteEvent}
        />
      )}

      {/* Upcoming */}
      {(activeTab === 'all' || activeTab === 'upcoming') && data.upcoming.length > 0 && (
        <EventSection
          label={t('pricing.promotions.section.upcoming', { n: data.upcoming.length })}
          tone="blue"
          events={data.upcoming}
          onDelete={deleteEvent}
        />
      )}

      {/* Ended */}
      {(activeTab === 'all' || activeTab === 'ended') && data.ended.length > 0 && (
        <EventSection
          label={t('pricing.promotions.section.ended', { n: data.ended.length })}
          tone="slate"
          events={data.ended}
          onDelete={deleteEvent}
        />
      )}

      {createOpen && (
        <CreatePromotionModal
          onClose={() => setCreateOpen(false)}
          onCreated={async () => {
            setCreateOpen(false)
            await fetchData()
          }}
        />
      )}
    </div>
  )
}

function CountTile({
  icon: Icon,
  label,
  value,
  tone,
  hint,
}: {
  icon: typeof PlayCircle
  label: string
  value: number
  tone: 'emerald' | 'blue' | 'slate'
  hint: string
}) {
  const toneClasses = {
    emerald: 'border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-300',
    blue: 'border-blue-200 dark:border-blue-900 bg-blue-50 dark:bg-blue-950 text-blue-700 dark:text-blue-300',
    slate: 'border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-500 dark:text-slate-400',
  }[tone]
  return (
    <Card noPadding className={toneClasses}>
      <div className="flex items-start gap-2 px-4 py-3">
        <Icon size={14} className="mt-0.5 flex-shrink-0" />
        <div>
          <div className="text-[20px] leading-tight font-semibold tabular-nums">
            {value}
          </div>
          <div className="text-base font-medium text-slate-700 dark:text-slate-300 leading-tight">
            {label}
          </div>
          <div className="text-sm text-slate-500 dark:text-slate-400 leading-tight mt-0.5">
            {hint}
          </div>
        </div>
      </div>
    </Card>
  )
}

function EventSection({
  label,
  tone,
  events,
  onDelete,
}: {
  label: string
  tone: 'emerald' | 'blue' | 'slate'
  events: RetailEvent[]
  onDelete: (eventId: string, name: string) => void
}) {
  const { t } = useTranslations()
  const headerToneCls = {
    emerald: 'bg-emerald-50 dark:bg-emerald-950 text-emerald-800 dark:text-emerald-200',
    blue: 'bg-blue-50 dark:bg-blue-950 text-blue-800 dark:text-blue-200',
    slate: 'bg-slate-50 dark:bg-slate-800 text-slate-700 dark:text-slate-300',
  }[tone]
  return (
    <div className="space-y-2">
      <div className="text-sm uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold">
        {label}
      </div>
      <Card noPadding>
        <div className="overflow-x-auto">
          <table className="w-full text-md">
            <thead className={cn('border-b border-slate-200 dark:border-slate-800', headerToneCls)}>
              <tr>
                <th className="px-3 py-2 text-left text-sm font-semibold uppercase tracking-wider">
                  {t('pricing.promotions.table.event')}
                </th>
                <th className="px-3 py-2 text-left text-sm font-semibold uppercase tracking-wider">
                  {t('pricing.promotions.table.window')}
                </th>
                <th className="px-3 py-2 text-left text-sm font-semibold uppercase tracking-wider">
                  {t('pricing.promotions.table.scope')}
                </th>
                <th className="px-3 py-2 text-left text-sm font-semibold uppercase tracking-wider">
                  {t('pricing.promotions.table.action')}
                </th>
                <th className="px-3 py-2 text-right text-sm font-semibold uppercase tracking-wider">
                  {t('pricing.promotions.table.lift')}
                </th>
                <th className="px-3 py-2 w-10"></th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => {
                const start = new Date(e.startDate)
                const end = new Date(e.endDate)
                const days = Math.max(
                  1,
                  Math.round((end.getTime() - start.getTime()) / (24 * 3600 * 1000)) + 1,
                )
                return (
                  <tr
                    key={e.id}
                    className="border-b border-slate-100 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800"
                  >
                    <td className="px-3 py-2">
                      <div className="font-medium text-slate-800 dark:text-slate-200">{e.name}</div>
                      {e.description && (
                        <div className="text-sm text-slate-500 dark:text-slate-400 truncate max-w-md">
                          {e.description}
                        </div>
                      )}
                      {e.source && (
                        <span className="inline-block text-xs font-semibold uppercase tracking-wider px-1.5 py-0.5 mt-0.5 border rounded bg-slate-50 dark:bg-slate-800 text-slate-600 dark:text-slate-400 border-slate-200 dark:border-slate-800">
                          {e.source}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-base text-slate-700 dark:text-slate-300">
                      <div>
                        {start.toLocaleDateString()} →{' '}
                        {end.toLocaleDateString()}
                      </div>
                      <div className="text-sm text-slate-500 dark:text-slate-400">
                        {t('pricing.promotions.windowDays', {
                          n: days,
                          s: days === 1 ? '' : 's',
                        })}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-base text-slate-700 dark:text-slate-300">
                      <ScopeChip
                        channel={e.channel}
                        marketplace={e.marketplace}
                        productType={e.productType}
                      />
                    </td>
                    <td className="px-3 py-2">
                      {e.priceActions.length === 0 ? (
                        <span className="text-sm text-slate-400 dark:text-slate-500">
                          {t('pricing.promotions.action.none')}
                        </span>
                      ) : (
                        <ul className="space-y-0.5">
                          {e.priceActions.map((a) => (
                            <li
                              key={a.id}
                              className="text-base text-slate-700 dark:text-slate-300 inline-flex items-center gap-1.5"
                            >
                              <Tag
                                size={11}
                                className="text-pink-600 flex-shrink-0"
                              />
                              <span className="font-mono text-sm">
                                {a.action === 'PERCENT_OFF'
                                  ? `-${a.value}%`
                                  : `${a.value} fixed`}
                              </span>
                              {a.channel && (
                                <span className="text-xs text-slate-500 dark:text-slate-400">
                                  {a.channel}
                                  {a.marketplace ? `:${a.marketplace}` : ''}
                                </span>
                              )}
                            </li>
                          ))}
                        </ul>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-700 dark:text-slate-300">
                      ×{Number(e.expectedLift).toFixed(1)}
                    </td>
                    <td className="px-3 py-2 inline-flex items-center gap-1">
                      <Link
                        href={`/pricing?source=SCHEDULED_SALE`}
                        className="text-sm text-blue-600 hover:underline"
                      >
                        →
                      </Link>
                      <IconButton
                        aria-label={t('pricing.promotions.deleteTitle')}
                        onClick={() => onDelete(e.id, e.name)}
                        variant="ghost"
                        size="sm"
                        tone="danger"
                      >
                        <Trash2 size={12} />
                      </IconButton>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  )
}

function ScopeChip({
  channel,
  marketplace,
  productType,
}: {
  channel: string | null
  marketplace: string | null
  productType: string | null
}) {
  const { t } = useTranslations()
  const parts: string[] = []
  if (channel) parts.push(channel)
  if (marketplace) parts.push(marketplace)
  if (productType) parts.push(productType)
  if (parts.length === 0) {
    return (
      <span className="text-sm text-slate-500 dark:text-slate-400">
        {t('pricing.promotions.scope.all')}
      </span>
    )
  }
  return (
    <span className="font-mono text-sm text-slate-700 dark:text-slate-300">{parts.join(' · ')}</span>
  )
}

function CreatePromotionModal({
  onClose,
  onCreated,
}: {
  onClose: () => void
  onCreated: () => void
}) {
  const { t } = useTranslations()
  const today = new Date().toISOString().slice(0, 10)
  const [form, setForm] = useState({
    name: '',
    startDate: today,
    endDate: today,
    channel: '',
    marketplace: '',
    productType: '',
    description: '',
    expectedLift: '1',
    actionType: 'PERCENT_OFF' as 'PERCENT_OFF' | 'FIXED_PRICE',
    actionValue: '',
    includeAction: true,
  })
  const [submitting, setSubmitting] = useState(false)
  const { toast } = useToast()

  const update = (k: keyof typeof form, v: string | boolean) =>
    setForm((prev) => ({ ...prev, [k]: v as never }))

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSubmitting(true)
    try {
      const body: Record<string, unknown> = {
        name: form.name,
        startDate: form.startDate,
        endDate: form.endDate,
        channel: form.channel || null,
        marketplace: form.marketplace || null,
        productType: form.productType || null,
        description: form.description || null,
        expectedLift: Number(form.expectedLift) || 1,
      }
      if (form.includeAction && form.actionValue) {
        body.action = {
          type: form.actionType,
          value: Number(form.actionValue),
        }
      }
      const res = await fetch(
        `${getBackendUrl()}/api/pricing/promotions`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      )
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        throw new Error(j.error ?? `HTTP ${res.status}`)
      }
      toast.success(t('pricing.promotions.created', { name: form.name }))
      onCreated()
    } catch (err) {
      toast.error(
        t('pricing.promotions.createFailed', {
          error: err instanceof Error ? err.message : String(err),
        }),
      )
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal open onClose={onClose} title={t('pricing.promotions.create')} size="xl">
      <form onSubmit={submit}>
        <ModalBody className="space-y-3">
          <div>
            <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
              {t('pricing.promotions.form.name')}
            </label>
            <input
              required
              value={form.name}
              onChange={(e) => update('name', e.target.value)}
              placeholder={t('pricing.promotions.form.namePlaceholder')}
              className="w-full h-9 px-3 border border-slate-300 dark:border-slate-700 rounded-md text-base"
            />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
                {t('pricing.promotions.form.start')}
              </label>
              <input
                type="date"
                required
                value={form.startDate}
                onChange={(e) => update('startDate', e.target.value)}
                className="w-full h-9 px-3 border border-slate-300 dark:border-slate-700 rounded-md text-base"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
                {t('pricing.promotions.form.end')}
              </label>
              <input
                type="date"
                required
                value={form.endDate}
                onChange={(e) => update('endDate', e.target.value)}
                className="w-full h-9 px-3 border border-slate-300 dark:border-slate-700 rounded-md text-base"
              />
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
                {t('pricing.promotions.form.channel')}
              </label>
              <select
                value={form.channel}
                onChange={(e) => update('channel', e.target.value)}
                className="w-full h-9 px-2 border border-slate-300 dark:border-slate-700 rounded-md text-base bg-white dark:bg-slate-900"
              >
                <option value="">{t('pricing.filter.allChannels')}</option>
                <option value="AMAZON">Amazon</option>
                <option value="EBAY">eBay</option>
                <option value="SHOPIFY">Shopify</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
                {t('pricing.promotions.form.marketplace')}
              </label>
              <select
                value={form.marketplace}
                onChange={(e) => update('marketplace', e.target.value)}
                className="w-full h-9 px-2 border border-slate-300 dark:border-slate-700 rounded-md text-base bg-white dark:bg-slate-900"
              >
                <option value="">{t('pricing.filter.allMarketplaces')}</option>
                <option value="IT">IT</option>
                <option value="DE">DE</option>
                <option value="FR">FR</option>
                <option value="ES">ES</option>
                <option value="UK">UK</option>
                <option value="NL">NL</option>
                <option value="PL">PL</option>
                <option value="SE">SE</option>
                <option value="US">US</option>
                <option value="GLOBAL">GLOBAL</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
                {t('pricing.promotions.form.expectedLift')}
              </label>
              <input
                type="number"
                step="0.1"
                min="1"
                value={form.expectedLift}
                onChange={(e) => update('expectedLift', e.target.value)}
                className="w-full h-9 px-3 border border-slate-300 dark:border-slate-700 rounded-md text-base tabular-nums"
              />
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
              {t('pricing.promotions.form.description')}
            </label>
            <textarea
              rows={2}
              value={form.description}
              onChange={(e) => update('description', e.target.value)}
              className="w-full px-3 py-2 border border-slate-300 dark:border-slate-700 rounded-md text-base"
            />
          </div>
          <div className="border border-pink-200 dark:border-pink-900 bg-pink-50/40 rounded-md p-3 space-y-2">
            <label className="inline-flex items-center gap-2 text-base font-medium text-pink-900">
              <input
                type="checkbox"
                checked={form.includeAction}
                onChange={(e) => update('includeAction', e.target.checked)}
              />
              {t('pricing.promotions.form.applyAction')}
            </label>
            {form.includeAction && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
                    {t('pricing.promotions.form.actionType')}
                  </label>
                  <select
                    value={form.actionType}
                    onChange={(e) =>
                      update('actionType', e.target.value as typeof form.actionType)
                    }
                    className="w-full h-9 px-2 border border-slate-300 dark:border-slate-700 rounded-md text-base bg-white dark:bg-slate-900"
                  >
                    <option value="PERCENT_OFF">
                      {t('pricing.promotions.form.percentOffOption')}
                    </option>
                    <option value="FIXED_PRICE">
                      {t('pricing.promotions.form.fixedPriceOption')}
                    </option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
                    {form.actionType === 'PERCENT_OFF'
                      ? t('pricing.promotions.form.percentOffLabel')
                      : t('pricing.promotions.form.fixedPriceLabel')}
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    min="0.01"
                    max={form.actionType === 'PERCENT_OFF' ? '99.99' : undefined}
                    value={form.actionValue}
                    onChange={(e) => update('actionValue', e.target.value)}
                    placeholder={form.actionType === 'PERCENT_OFF' ? '20' : '49.99'}
                    className="w-full h-9 px-3 border border-slate-300 dark:border-slate-700 rounded-md text-base tabular-nums"
                  />
                </div>
              </div>
            )}
          </div>
        </ModalBody>
        <ModalFooter>
          <Button type="button" variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" variant="primary" loading={submitting} disabled={submitting}>
            {submitting
              ? t('pricing.promotions.creating')
              : t('pricing.promotions.create')}
          </Button>
        </ModalFooter>
      </form>
    </Modal>
  )
}

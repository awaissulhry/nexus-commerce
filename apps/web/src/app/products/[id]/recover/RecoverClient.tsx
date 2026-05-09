'use client'

/**
 * W5.49 — recovery picker.
 *
 * Layout (single column, no tabs — the flow is linear):
 *   1. Header strip: product name + SKU + back link
 *   2. Channel × marketplace picker (one row per existing listing,
 *      pre-filtered to channels with a publishable listing)
 *   3. Five action cards (REPUBLISH_IN_PLACE, DELETE_RELIST_SAME,
 *      SAME_ASIN_NEW_SKU, NEW_ASIN_SAME_SKU, FULL_RESET) — clicking
 *      one fetches /preview and renders the consequence panel
 *   4. Consequence panel: reviews/asin/sku preserved badges, blockers,
 *      warnings, before/after identifiers, ETA
 *   5. Confirm → POST /recover → redirect to wizardUrl
 *   6. History strip: last 20 events for this product
 *
 * Strings flow through useTranslations() so the page mirrors the
 * en/it catalog parity gate.
 */

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ArrowLeft, AlertTriangle, CheckCircle2, History, Loader2, ShieldAlert } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { useTranslations } from '@/lib/i18n/use-translations'

export type RecoveryAction =
  | 'REPUBLISH_IN_PLACE'
  | 'DELETE_RELIST_SAME'
  | 'SAME_ASIN_NEW_SKU'
  | 'NEW_ASIN_SAME_SKU'
  | 'FULL_RESET'

export interface RecoverProduct {
  id: string
  sku: string
  name: string
  brand?: string | null
}

export interface RecoverChannelListing {
  id: string
  channel: string
  marketplace: string
  externalListingId: string | null
  listingStatus: string | null
}

export interface RecoveryEvent {
  id: string
  channel: string
  marketplace: string
  action: RecoveryAction
  oldAsin: string | null
  newAsin: string | null
  oldSku: string | null
  newSku: string | null
  status: string
  startedAt: string
  completedAt: string | null
  durationMs: number | null
  error: string | null
}

interface PreviewResponse {
  preview: {
    action: RecoveryAction
    channel: string
    marketplace: string
    consequences: {
      reviewsPreserved: boolean
      asinPreserved: boolean
      skuPreserved: boolean
      skuCooldownRisk: boolean
      blockers: string[]
      warnings: string[]
    }
    before: { asin: string | null; sku: string }
    after: { asin: string | null; sku: string }
    estimatedDurationSeconds: number
  }
  error?: string
}

const ACTIONS: RecoveryAction[] = [
  'REPUBLISH_IN_PLACE',
  'DELETE_RELIST_SAME',
  'SAME_ASIN_NEW_SKU',
  'NEW_ASIN_SAME_SKU',
  'FULL_RESET',
]

interface Props {
  productId: string
  product: RecoverProduct
  listings: RecoverChannelListing[]
  events: RecoveryEvent[]
}

export default function RecoverClient({
  productId,
  product,
  listings,
  events,
}: Props) {
  const { t } = useTranslations()
  const router = useRouter()

  // Default to first listing with an external ID (= the most likely
  // candidate for a recovery flow). Fall back to first listing.
  const defaultIdx = useMemo(() => {
    const i = listings.findIndex((l) => l.externalListingId)
    return i >= 0 ? i : 0
  }, [listings])

  const [selectedListingIdx, setSelectedListingIdx] = useState(defaultIdx)
  const [selectedAction, setSelectedAction] =
    useState<RecoveryAction | null>(null)
  const [newSku, setNewSku] = useState('')
  const [preview, setPreview] = useState<PreviewResponse['preview'] | null>(
    null,
  )
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [executing, setExecuting] = useState(false)
  const [executeError, setExecuteError] = useState<string | null>(null)

  const selectedListing = listings[selectedListingIdx] ?? null
  const requiresNewSku =
    selectedAction === 'SAME_ASIN_NEW_SKU' ||
    selectedAction === 'FULL_RESET'

  // Re-fetch preview whenever the (listing, action, newSku) tuple
  // changes. Debounced via a 200ms timeout for newSku changes.
  useEffect(() => {
    if (!selectedListing || !selectedAction) {
      setPreview(null)
      return
    }
    if (requiresNewSku && !newSku.trim()) {
      setPreview(null)
      return
    }
    let cancelled = false
    const handle = setTimeout(async () => {
      setPreviewLoading(true)
      setPreviewError(null)
      try {
        const res = await fetch(
          `/api/products/${productId}/recover/preview`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              channel: selectedListing.channel,
              marketplace: selectedListing.marketplace,
              action: selectedAction,
              newSku: requiresNewSku ? newSku.trim() : undefined,
            }),
          },
        )
        const json = (await res.json()) as PreviewResponse
        if (cancelled) return
        if (!res.ok || !json.preview) {
          setPreviewError(json.error ?? `HTTP ${res.status}`)
          setPreview(null)
        } else {
          setPreview(json.preview)
        }
      } catch (e) {
        if (cancelled) return
        setPreviewError(e instanceof Error ? e.message : String(e))
        setPreview(null)
      } finally {
        if (!cancelled) setPreviewLoading(false)
      }
    }, 200)
    return () => {
      cancelled = true
      clearTimeout(handle)
    }
  }, [
    productId,
    selectedListing,
    selectedAction,
    newSku,
    requiresNewSku,
  ])

  const onExecute = async () => {
    if (!selectedListing || !selectedAction || !preview) return
    if (preview.consequences.blockers.length > 0) return
    setExecuting(true)
    setExecuteError(null)
    try {
      const res = await fetch(`/api/products/${productId}/recover`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channel: selectedListing.channel,
          marketplace: selectedListing.marketplace,
          action: selectedAction,
          newSku: requiresNewSku ? newSku.trim() : undefined,
        }),
      })
      const json = (await res.json()) as {
        recovery?: {
          eventId: string
          status: 'SUCCEEDED' | 'FAILED'
          wizardUrl?: string
          error?: string
        }
        error?: string
      }
      if (!res.ok || !json.recovery) {
        setExecuteError(json.error ?? `HTTP ${res.status}`)
        return
      }
      if (json.recovery.status === 'FAILED') {
        setExecuteError(json.recovery.error ?? 'Recovery failed')
        return
      }
      // Hand off to the wizard for the recreate step. If the action
      // was REPUBLISH_IN_PLACE, the wizard URL also points back to
      // the wizard — the recoveryEventId query param is what links
      // both halves in the audit row.
      if (json.recovery.wizardUrl) {
        router.push(json.recovery.wizardUrl)
      } else {
        router.push(`/products/${productId}/edit`)
      }
    } catch (e) {
      setExecuteError(e instanceof Error ? e.message : String(e))
    } finally {
      setExecuting(false)
    }
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="max-w-4xl mx-auto p-6">
        <header className="mb-6">
          <Link
            href={`/products/${productId}/edit`}
            className="inline-flex items-center gap-1 text-base text-blue-700 hover:text-blue-900 hover:underline mb-3"
          >
            <ArrowLeft className="w-4 h-4" />
            {t('recover.back')}
          </Link>
          <h1 className="text-2xl font-semibold text-slate-900">
            {t('recover.title')}
          </h1>
          <p className="text-md text-slate-600 mt-1">
            {product.name}{' '}
            <span className="text-slate-400">·</span>{' '}
            <span className="font-mono">{product.sku}</span>
          </p>
        </header>

        {listings.length === 0 ? (
          <div className="bg-white border border-slate-200 rounded-lg p-6 text-center">
            <p className="text-md text-slate-600">
              {t('recover.empty.noListings')}
            </p>
          </div>
        ) : (
          <>
            <Section title={t('recover.section.targetListing')}>
              <div className="grid gap-2">
                {listings.map((l, i) => {
                  const isSelected = i === selectedListingIdx
                  return (
                    <button
                      key={l.id}
                      type="button"
                      onClick={() => {
                        setSelectedListingIdx(i)
                        setSelectedAction(null)
                        setPreview(null)
                      }}
                      className={`w-full flex items-center justify-between text-left rounded-md border px-4 py-3 transition-colors ${
                        isSelected
                          ? 'border-blue-500 bg-blue-50'
                          : 'border-slate-200 bg-white hover:bg-slate-50'
                      }`}
                    >
                      <div>
                        <div className="text-md font-medium text-slate-900">
                          {l.channel}{' '}
                          <span className="text-slate-400">·</span>{' '}
                          {l.marketplace}
                        </div>
                        <div className="text-base text-slate-600 font-mono mt-0.5">
                          {l.externalListingId ?? t('recover.noExternalId')}
                        </div>
                      </div>
                      <div className="text-base text-slate-500">
                        {l.listingStatus ?? '—'}
                      </div>
                    </button>
                  )
                })}
              </div>
            </Section>

            <Section title={t('recover.section.action')}>
              <div className="grid gap-2 sm:grid-cols-2">
                {ACTIONS.map((a) => {
                  const isSelected = selectedAction === a
                  return (
                    <button
                      key={a}
                      type="button"
                      onClick={() => setSelectedAction(a)}
                      className={`text-left rounded-md border px-4 py-3 transition-colors ${
                        isSelected
                          ? 'border-blue-500 bg-blue-50'
                          : 'border-slate-200 bg-white hover:bg-slate-50'
                      }`}
                    >
                      <div className="text-md font-medium text-slate-900">
                        {t(`recover.action.${a}.title`)}
                      </div>
                      <div className="text-base text-slate-600 mt-0.5">
                        {t(`recover.action.${a}.summary`)}
                      </div>
                    </button>
                  )
                })}
              </div>
            </Section>

            {requiresNewSku && (
              <Section title={t('recover.section.newSku')}>
                <input
                  type="text"
                  value={newSku}
                  onChange={(e) => setNewSku(e.target.value)}
                  placeholder={t('recover.newSku.placeholder')}
                  className="w-full h-9 px-3 rounded-md border border-slate-200 font-mono text-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <p className="text-base text-slate-500 mt-1">
                  {t('recover.newSku.help')}
                </p>
              </Section>
            )}

            {selectedListing && selectedAction && (
              <Section title={t('recover.section.consequences')}>
                {previewLoading ? (
                  <div className="bg-white border border-slate-200 rounded-md p-4 flex items-center gap-2 text-md text-slate-600">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    {t('common.loading')}
                  </div>
                ) : previewError ? (
                  <div className="bg-red-50 border border-red-200 rounded-md p-4 text-md text-red-800">
                    {previewError}
                  </div>
                ) : preview ? (
                  <PreviewPanel preview={preview} />
                ) : null}
              </Section>
            )}

            {executeError && (
              <div className="bg-red-50 border border-red-200 rounded-md p-4 text-md text-red-800 mt-4">
                {executeError}
              </div>
            )}

            <div className="flex justify-end gap-2 mt-6">
              <Link
                href={`/products/${productId}/edit`}
                className="inline-flex items-center justify-center h-8 px-3 text-md font-medium text-slate-700 hover:bg-slate-100 rounded-md transition-colors"
              >
                {t('common.cancel')}
              </Link>
              <Button
                variant="primary"
                onClick={onExecute}
                disabled={
                  !preview ||
                  preview.consequences.blockers.length > 0 ||
                  executing ||
                  previewLoading ||
                  (requiresNewSku && !newSku.trim())
                }
                loading={executing}
              >
                {selectedAction === 'REPUBLISH_IN_PLACE'
                  ? t('recover.cta.republish')
                  : t('recover.cta.proceed')}
              </Button>
            </div>
          </>
        )}

        {events.length > 0 && (
          <Section title={t('recover.section.history')}>
            <div className="bg-white border border-slate-200 rounded-md divide-y divide-slate-100">
              {events.map((ev) => (
                <div
                  key={ev.id}
                  className="flex items-center justify-between px-4 py-2.5 text-base"
                >
                  <div className="flex items-center gap-2">
                    <History className="w-3.5 h-3.5 text-slate-400" />
                    <span className="font-medium text-slate-900">
                      {t(`recover.action.${ev.action}.title`)}
                    </span>
                    <span className="text-slate-400">·</span>
                    <span className="text-slate-600">
                      {ev.channel} {ev.marketplace}
                    </span>
                  </div>
                  <div className="flex items-center gap-3 text-slate-500">
                    <span
                      className={
                        ev.status === 'SUCCEEDED'
                          ? 'text-green-700'
                          : ev.status === 'FAILED'
                            ? 'text-red-700'
                            : 'text-amber-700'
                      }
                    >
                      {ev.status}
                    </span>
                    <span className="font-mono">
                      {new Date(ev.startedAt).toLocaleString()}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </Section>
        )}
      </div>
    </div>
  )
}

function Section({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <section className="mt-6">
      <h2 className="text-lg font-semibold text-slate-800 mb-2">{title}</h2>
      {children}
    </section>
  )
}

function PreviewPanel({
  preview,
}: {
  preview: PreviewResponse['preview']
}) {
  const { t } = useTranslations()
  const c = preview.consequences
  return (
    <div className="bg-white border border-slate-200 rounded-md overflow-hidden">
      <div className="grid grid-cols-2 sm:grid-cols-4 divide-x divide-slate-100">
        <Pill
          ok={c.reviewsPreserved}
          label={t('recover.pill.reviews')}
        />
        <Pill ok={c.asinPreserved} label={t('recover.pill.asin')} />
        <Pill ok={c.skuPreserved} label={t('recover.pill.sku')} />
        <Pill
          ok={!c.skuCooldownRisk}
          label={t('recover.pill.noCooldown')}
        />
      </div>

      <div className="grid grid-cols-2 divide-x divide-slate-100 border-t border-slate-100">
        <IdBlock
          label={t('recover.before')}
          asin={preview.before.asin}
          sku={preview.before.sku}
        />
        <IdBlock
          label={t('recover.after')}
          asin={preview.after.asin}
          sku={preview.after.sku}
        />
      </div>

      {c.blockers.length > 0 && (
        <div className="border-t border-red-200 bg-red-50 px-4 py-3">
          <div className="flex items-center gap-2 text-md font-semibold text-red-900 mb-1">
            <ShieldAlert className="w-4 h-4" />
            {t('recover.blockers')}
          </div>
          <ul className="list-disc list-inside text-base text-red-800 space-y-0.5">
            {c.blockers.map((b, i) => (
              <li key={i}>{b}</li>
            ))}
          </ul>
        </div>
      )}

      {c.warnings.length > 0 && (
        <div className="border-t border-amber-200 bg-amber-50 px-4 py-3">
          <div className="flex items-center gap-2 text-md font-semibold text-amber-900 mb-1">
            <AlertTriangle className="w-4 h-4" />
            {t('recover.warnings')}
          </div>
          <ul className="list-disc list-inside text-base text-amber-900 space-y-0.5">
            {c.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="border-t border-slate-100 px-4 py-2.5 text-base text-slate-600">
        {t('recover.eta', {
          seconds: preview.estimatedDurationSeconds,
        })}
      </div>
    </div>
  )
}

function Pill({ ok, label }: { ok: boolean; label: string }) {
  return (
    <div className="px-4 py-3 flex items-center gap-2 text-base">
      <CheckCircle2
        className={`w-4 h-4 ${ok ? 'text-green-600' : 'text-slate-300'}`}
      />
      <span
        className={ok ? 'text-slate-900 font-medium' : 'text-slate-400'}
      >
        {label}
      </span>
    </div>
  )
}

function IdBlock({
  label,
  asin,
  sku,
}: {
  label: string
  asin: string | null
  sku: string
}) {
  const { t } = useTranslations()
  return (
    <div className="px-4 py-3">
      <div className="text-base text-slate-500 uppercase tracking-wide mb-1">
        {label}
      </div>
      <div className="text-base text-slate-700">
        ASIN:{' '}
        <span className="font-mono text-slate-900">
          {asin ?? t('recover.none')}
        </span>
      </div>
      <div className="text-base text-slate-700">
        SKU: <span className="font-mono text-slate-900">{sku}</span>
      </div>
    </div>
  )
}

'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  AlertCircle,
  CheckCircle2,
  Loader2,
  RefreshCw,
  Sparkles,
  X,
} from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { emitInvalidation } from '@/lib/sync/invalidation-channel'
import { Card } from '@/components/ui/Card'
import { Input } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'
import { useToast } from '@/components/ui/Toast'
import { useTranslations } from '@/lib/i18n/use-translations'
import { cn } from '@/lib/utils'

interface Props {
  product: any
  onDirtyChange: (count: number) => void
  /** W1.1 — bumped by parent's "Discard" handler. On change we cancel
   *  any pending debounced save, drop the dirty set without flushing,
   *  and reseed local state from the freshly-fetched product prop. */
  discardSignal: number
}

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error'

const SAVE_DEBOUNCE_MS = 600

/** Q.0 — fields the master-data form actually persists. Each
 *  corresponds to a field allowed on the existing
 *  /api/products/bulk PATCH endpoint, so we don't need a new route.
 *  W1.3 added basePrice + status + description.
 *  W1.4 added bulletPoints + keywords (string[]) and hsCode +
 *  countryOfOrigin (Italian fiscal compliance).
 */
const MASTER_FIELDS = [
  'sku',
  'name',
  'brand',
  'manufacturer',
  'upc',
  'ean',
  'status',
  'basePrice',
  'description',
  'bulletPoints',
  'keywords',
  'hsCode',
  'countryOfOrigin',
  'weightValue',
  'weightUnit',
  'dimLength',
  'dimWidth',
  'dimHeight',
  'dimUnit',
  'costPrice',
  'minMargin',
  'minPrice',
  'maxPrice',
] as const

type MasterField = (typeof MASTER_FIELDS)[number]

const NUMERIC_FIELDS: ReadonlySet<string> = new Set([
  'basePrice',
  'weightValue',
  'dimLength',
  'dimWidth',
  'dimHeight',
  'costPrice',
  'minMargin',
  'minPrice',
  'maxPrice',
])

/** W1.4 — fields that the form holds as a raw textarea (one entry per
 *  line) but the server expects as a string[]. We keep the textarea
 *  shape in local state for natural editing, then split + trim on
 *  flush. Empty lines are dropped.
 */
const ARRAY_FIELDS: ReadonlySet<string> = new Set([
  'bulletPoints',
  'keywords',
])

function seedFromProduct(product: any): Record<MasterField, string> {
  const seed = {} as Record<MasterField, string>
  for (const f of MASTER_FIELDS) {
    const v = product[f]
    if (ARRAY_FIELDS.has(f)) {
      // bulletPoints / keywords come back as string[]. Render as
      // newline-separated text for natural multi-line editing.
      seed[f] = Array.isArray(v) ? v.join('\n') : ''
    } else {
      seed[f] = v == null ? '' : String(v)
    }
  }
  if (!seed.weightUnit) seed.weightUnit = 'kg'
  if (!seed.dimUnit) seed.dimUnit = 'cm'
  // Status defaults to ACTIVE on a freshly-created standalone — the
  // server allows DRAFT/INACTIVE too. We don't normalise here so the
  // raw value the server has is what the select reflects.
  if (!seed.status) seed.status = 'ACTIVE'
  return seed
}

export default function MasterDataTab({
  product,
  onDirtyChange,
  discardSignal,
}: Props) {
  const { t } = useTranslations()
  const { toast } = useToast()
  const router = useRouter()
  const [data, setData] = useState<Record<MasterField, string>>(() =>
    seedFromProduct(product),
  )
  // W13.1 — per-field AI suggest busy flag. Keys are MasterField names
  // ('name' | 'description' | 'bulletPoints' | 'keywords'); only the
  // four content fields support AI today.
  const [aiBusy, setAiBusy] = useState<Set<MasterField>>(new Set())
  // W1.2 — local copy of Product.version. Sent as If-Match on every
  // PATCH and bumped from the response so two consecutive saves with
  // no intervening reload still pass the CAS check on the server.
  // Seeded from the product prop on mount and on discard (along with
  // the field values themselves).
  const [version, setVersion] = useState<number | null>(
    typeof product.version === 'number' ? product.version : null,
  )
  // W1.2 — surfaced when the server returns 409 VERSION_CONFLICT.
  // Until the user clicks Reload (or Dismiss), the dirty set is held
  // intact so a second save attempt with a fresh version still has
  // every touched field to flush.
  const [conflict, setConflict] = useState<{
    expected: number
    current: number | null
  } | null>(null)

  const [status, setStatus] = useState<SaveStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  // Track which fields have been touched since the last successful
  // save — only those flush in the next PATCH.
  const dirtyRef = useRef<Set<MasterField>>(new Set())
  const saveTimer = useRef<number | null>(null)
  // W1.1 — onDirtyChange is invoked whenever dirty cardinality
  // changes. The parent aggregates per-tab counts to drive the
  // header's accurate "{n} unsaved" badge.
  const reportDirty = () => onDirtyChange(dirtyRef.current.size)

  const update = (field: MasterField, value: string) => {
    setData((prev) => ({ ...prev, [field]: value }))
    dirtyRef.current.add(field)
    reportDirty()
    setStatus('saving')
    setError(null)
    if (saveTimer.current) window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => {
      void flush()
    }, SAVE_DEBOUNCE_MS)
  }

  // W13.1 — AI suggest a value for one master content field. Hits the
  // existing /products/ai/bulk-generate endpoint with dryRun=true so
  // the suggestion lands inline first; the operator can edit before
  // the debounced auto-save commits. Marketplace='IT' (primary) is
  // hard-coded because this writes to Product master columns; non-
  // primary languages flow through the Locales tab (W4.x) instead.
  const aiSuggest = async (field: MasterField) => {
    const fieldMap: Partial<Record<MasterField, 'title' | 'description' | 'bullets' | 'keywords'>> = {
      name: 'title',
      description: 'description',
      bulletPoints: 'bullets',
      keywords: 'keywords',
    }
    const aiField = fieldMap[field]
    if (!aiField) return
    setAiBusy((prev) => {
      const next = new Set(prev)
      next.add(field)
      return next
    })
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/products/ai/bulk-generate`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            productIds: [product.id],
            fields: [aiField],
            marketplace: 'IT',
            dryRun: true,
          }),
        },
      )
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        throw new Error(body?.error ?? `HTTP ${res.status}`)
      }
      const json = await res.json()
      const result = json?.results?.[0]
      if (!result?.ok) {
        throw new Error(result?.error ?? t('products.edit.master.aiNoSuggestion'))
      }
      const generated = result.generated
      let next: string | undefined
      if (aiField === 'title') next = generated?.title?.content
      else if (aiField === 'description') next = generated?.description?.content
      else if (aiField === 'bullets') {
        const c = generated?.bullets?.content
        if (Array.isArray(c)) {
          next = c
            .filter((b: unknown) => typeof b === 'string' && b.trim().length > 0)
            .join('\n')
        }
      } else if (aiField === 'keywords') {
        const c = generated?.keywords?.content
        if (typeof c === 'string') {
          next = c
            .split(/[,\n]/)
            .map((k) => k.trim())
            .filter(Boolean)
            .join('\n')
        } else if (Array.isArray(c)) {
          next = c.filter((k: unknown) => typeof k === 'string').join('\n')
        }
      }
      if (typeof next === 'string' && next.length > 0) {
        update(field, next)
        toast.success(t('products.edit.master.aiSuggested'))
      } else {
        toast.error(t('products.edit.master.aiNoSuggestion'))
      }
    } catch (e: any) {
      toast.error(
        t('products.edit.master.aiFailed', {
          error: e?.message ?? String(e),
        }),
      )
    } finally {
      setAiBusy((prev) => {
        const next = new Set(prev)
        next.delete(field)
        return next
      })
    }
  }

  const flush = async () => {
    const fields = Array.from(dirtyRef.current)
    if (fields.length === 0) {
      setStatus('idle')
      return
    }
    const changes = fields.map((field) => {
      const raw = data[field]
      let value: unknown = raw
      if (NUMERIC_FIELDS.has(field)) {
        value = raw === '' ? null : Number(raw)
        if (typeof value === 'number' && Number.isNaN(value)) value = null
      } else if (ARRAY_FIELDS.has(field)) {
        // W1.4 — split textarea into a string[] for the server. The
        // /bulk validator caps at 20, trims, and drops blanks anyway,
        // but normalising here keeps the round-trip predictable.
        value = (raw ?? '')
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
      } else if (raw === '') {
        value = null
      }
      return { id: product.id, field, value }
    })
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      }
      // W1.2 — send the version we read with so the server can CAS-
      // bump in the same transaction as our field updates. expected
      // Version doubles up in the body for older route handlers that
      // can't read headers cleanly; the server reads If-Match first.
      if (typeof version === 'number') {
        headers['If-Match'] = String(version)
      }
      const res = await fetch(`${getBackendUrl()}/api/products/bulk`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({
          changes,
          ...(typeof version === 'number'
            ? { expectedVersion: version }
            : {}),
        }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        // W1.2 — VERSION_CONFLICT means another writer landed first.
        // Keep the dirty set so the user can choose to reapply after
        // reloading; surface a banner that names the version skew.
        if (res.status === 409 && body?.code === 'VERSION_CONFLICT') {
          setStatus('error')
          setError(null)
          setConflict({
            expected:
              typeof body.expectedVersion === 'number'
                ? body.expectedVersion
                : (version ?? 0),
            current:
              typeof body.currentVersion === 'number'
                ? body.currentVersion
                : null,
          })
          return
        }
        throw new Error(body?.error ?? `HTTP ${res.status}`)
      }
      const respBody = await res.json().catch(() => null)
      // W1.2 — track the server's freshly-incremented version so the
      // next debounced save still passes the CAS check without a
      // round-trip to GET /api/products/:id.
      if (typeof respBody?.currentVersion === 'number') {
        setVersion(respBody.currentVersion)
      } else if (typeof version === 'number') {
        setVersion(version + 1)
      }
      const flushedFields = Array.from(dirtyRef.current)
      dirtyRef.current = new Set()
      reportDirty()
      setStatus('saved')
      window.setTimeout(() => {
        setStatus((s) => (s === 'saved' ? 'idle' : s))
      }, 1500)
      // Phase 10/F11 — broadcast so /products grid + /bulk-operations
      // refresh within ~200ms.
      emitInvalidation({
        type: 'product.updated',
        id: product.id,
        fields: flushedFields,
        meta: { source: 'master-data-tab' },
      })
    } catch (e) {
      setStatus('error')
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  // Flush on unmount so an in-flight debounce doesn't drop the last
  // edit when the user switches tabs. Discard path clears dirtyRef
  // first, so this becomes a no-op when the user explicitly chose
  // to throw away pending edits.
  useEffect(() => {
    return () => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current)
      if (dirtyRef.current.size > 0) void flush()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // W1.1 — react to parent Discard. Skip the initial mount so
  // discardSignal=0 doesn't trigger a no-op reset on every render.
  const discardSeen = useRef(discardSignal)
  useEffect(() => {
    if (discardSignal === discardSeen.current) return
    discardSeen.current = discardSignal
    if (saveTimer.current) {
      window.clearTimeout(saveTimer.current)
      saveTimer.current = null
    }
    dirtyRef.current = new Set()
    setData(seedFromProduct(product))
    setStatus('idle')
    setError(null)
    // W1.2 — discard also clears the conflict banner and reseeds
    // version from the freshly-fetched product prop. ProductEditClient
    // calls router.refresh() right after bumping discardSignal, so
    // the next render carries the latest version.
    setConflict(null)
    setVersion(typeof product.version === 'number' ? product.version : null)
    reportDirty()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [discardSignal, product])

  return (
    <div className="space-y-4">
      {conflict && (
        <ConflictBanner
          expected={conflict.expected}
          current={conflict.current}
          onReload={() => router.refresh()}
          onDismiss={() => setConflict(null)}
          t={t}
        />
      )}
      <SaveStatusBar status={status} error={error} t={t} />

      <Card
        title={t('products.edit.master.identityTitle')}
        description={t('products.edit.master.identityDesc')}
      >
        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-3">
          <Input
            label={t('products.edit.master.skuLabel')}
            value={data.sku}
            mono
            onChange={(e) => update('sku', e.target.value)}
          />
          <div className="relative">
            <Input
              label={t('products.edit.master.nameLabel')}
              value={data.name}
              onChange={(e) => update('name', e.target.value)}
            />
            <AiSuggestOverlay
              busy={aiBusy.has('name')}
              onClick={() => void aiSuggest('name')}
              tooltip={t('products.edit.master.aiSuggestTitle')}
            />
            <NameCounter value={data.name} t={t} />
          </div>
          <Input
            label={t('products.edit.master.brandLabel')}
            value={data.brand}
            onChange={(e) => update('brand', e.target.value)}
          />
          <Input
            label={t('products.edit.master.manufacturerLabel')}
            value={data.manufacturer}
            onChange={(e) => update('manufacturer', e.target.value)}
          />
          <Input
            label={t('products.edit.master.upcLabel')}
            value={data.upc}
            mono
            onChange={(e) => update('upc', e.target.value)}
          />
          <Input
            label={t('products.edit.master.eanLabel')}
            value={data.ean}
            mono
            onChange={(e) => update('ean', e.target.value)}
          />
        </div>
      </Card>

      <Card
        title={t('products.edit.master.statusTitle')}
        description={t('products.edit.master.statusDesc')}
      >
        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-3">
          <SelectField
            label={t('products.edit.master.statusLabel')}
            value={data.status || 'ACTIVE'}
            onChange={(v) => update('status', v)}
            options={[
              { value: 'ACTIVE', label: t('products.edit.master.statusActive') },
              { value: 'DRAFT', label: t('products.edit.master.statusDraft') },
              { value: 'INACTIVE', label: t('products.edit.master.statusInactive') },
            ]}
          />
        </div>
      </Card>

      <Card
        title={t('products.edit.master.contentTitle')}
        description={t('products.edit.master.contentDesc')}
      >
        <div className="space-y-1">
          <div className="flex items-baseline justify-between">
            <label
              htmlFor="master-description"
              className="text-base font-medium text-slate-700 dark:text-slate-300"
            >
              {t('products.edit.master.descriptionLabel')}
            </label>
            <AiSuggestInline
              busy={aiBusy.has('description')}
              onClick={() => void aiSuggest('description')}
              label={t('products.edit.master.aiSuggest')}
              tooltip={t('products.edit.master.aiSuggestDescription')}
            />
          </div>
          <textarea
            id="master-description"
            value={data.description}
            onChange={(e) => update('description', e.target.value)}
            placeholder={t('products.edit.master.descriptionPlaceholder')}
            rows={6}
            className="w-full rounded-md border border-slate-200 dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-600 bg-white dark:bg-slate-900 text-md text-slate-900 dark:text-slate-100 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-colors font-sans"
          />
          <DescriptionCounter value={data.description} t={t} />
        </div>
      </Card>

      <Card
        title={t('products.edit.master.contentSecondaryTitle')}
        description={t('products.edit.master.contentSecondaryDesc')}
      >
        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-3">
          <div className="space-y-1">
            <div className="flex items-baseline justify-between gap-2">
              <label
                htmlFor="master-bullets"
                className="text-base font-medium text-slate-700 dark:text-slate-300"
              >
                {t('products.edit.master.bulletsLabel')}
              </label>
              <div className="flex items-center gap-2">
                <span className="text-xs text-slate-500 dark:text-slate-400 tabular-nums">
                  {t('products.edit.master.bulletsCount', {
                    count: bulletCount(data.bulletPoints),
                  })}
                </span>
                <AiSuggestInline
                  busy={aiBusy.has('bulletPoints')}
                  onClick={() => void aiSuggest('bulletPoints')}
                  label={t('products.edit.master.aiSuggest')}
                  tooltip={t('products.edit.master.aiSuggestBullets')}
                />
              </div>
            </div>
            <textarea
              id="master-bullets"
              value={data.bulletPoints}
              onChange={(e) => update('bulletPoints', e.target.value)}
              placeholder={t('products.edit.master.bulletsPlaceholder')}
              rows={6}
              className="w-full rounded-md border border-slate-200 dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-600 bg-white dark:bg-slate-900 text-md text-slate-900 dark:text-slate-100 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-colors font-sans"
            />
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {t('products.edit.master.bulletsHint')}
            </p>
          </div>
          <div className="space-y-1">
            <div className="flex items-baseline justify-between gap-2">
              <label
                htmlFor="master-keywords"
                className="text-base font-medium text-slate-700 dark:text-slate-300"
              >
                {t('products.edit.master.keywordsLabel')}
              </label>
              <AiSuggestInline
                busy={aiBusy.has('keywords')}
                onClick={() => void aiSuggest('keywords')}
                label={t('products.edit.master.aiSuggest')}
                tooltip={t('products.edit.master.aiSuggestKeywords')}
              />
            </div>
            <textarea
              id="master-keywords"
              value={data.keywords}
              onChange={(e) => update('keywords', e.target.value)}
              placeholder={t('products.edit.master.keywordsPlaceholder')}
              rows={6}
              className="w-full rounded-md border border-slate-200 dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-600 bg-white dark:bg-slate-900 text-md text-slate-900 dark:text-slate-100 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-colors font-sans"
            />
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {t('products.edit.master.keywordsHint')}
            </p>
          </div>
        </div>
      </Card>

      <Card
        title={t('products.edit.master.complianceTitle')}
        description={t('products.edit.master.complianceDesc')}
      >
        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-3">
          <div className="space-y-1">
            <Input
              label={t('products.edit.master.hsCodeLabel')}
              value={data.hsCode}
              mono
              onChange={(e) => update('hsCode', e.target.value)}
            />
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {t('products.edit.master.hsCodeHint')}
            </p>
          </div>
          <div className="space-y-1">
            <Input
              label={t('products.edit.master.countryOfOriginLabel')}
              value={data.countryOfOrigin}
              mono
              onChange={(e) =>
                update('countryOfOrigin', e.target.value.toUpperCase())
              }
            />
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {t('products.edit.master.countryOfOriginHint')}
            </p>
          </div>
        </div>
      </Card>

      <Card
        title={t('products.edit.master.physicalTitle')}
        description={t('products.edit.master.physicalDesc')}
      >
        <div className="grid grid-cols-2 md:grid-cols-4 gap-x-4 gap-y-3">
          <Input
            label={t('products.edit.master.weightLabel')}
            type="number"
            value={data.weightValue}
            onChange={(e) => update('weightValue', e.target.value)}
          />
          <SelectField
            label={t('products.edit.master.unitLabel')}
            value={data.weightUnit}
            onChange={(v) => update('weightUnit', v)}
            options={[
              { value: 'kg', label: 'kg' },
              { value: 'g', label: 'g' },
              { value: 'lb', label: 'lb' },
              { value: 'oz', label: 'oz' },
            ]}
          />
          <div />
          <div />
          <Input
            label={t('products.edit.master.lengthLabel')}
            type="number"
            value={data.dimLength}
            onChange={(e) => update('dimLength', e.target.value)}
          />
          <Input
            label={t('products.edit.master.widthLabel')}
            type="number"
            value={data.dimWidth}
            onChange={(e) => update('dimWidth', e.target.value)}
          />
          <Input
            label={t('products.edit.master.heightLabel')}
            type="number"
            value={data.dimHeight}
            onChange={(e) => update('dimHeight', e.target.value)}
          />
          <SelectField
            label={t('products.edit.master.unitLabel')}
            value={data.dimUnit}
            onChange={(v) => update('dimUnit', v)}
            options={[
              { value: 'cm', label: 'cm' },
              { value: 'mm', label: 'mm' },
              { value: 'in', label: 'in' },
            ]}
          />
        </div>
      </Card>

      <Card
        title={t('products.edit.master.pricingTitle')}
        description={t('products.edit.master.pricingDesc')}
      >
        <div className="grid grid-cols-2 md:grid-cols-4 gap-x-4 gap-y-3">
          <Input
            label={t('products.edit.master.basePriceLabel')}
            type="number"
            prefix="€"
            value={data.basePrice}
            onChange={(e) => update('basePrice', e.target.value)}
          />
          <Input
            label={t('products.edit.master.costLabel')}
            type="number"
            prefix="€"
            value={data.costPrice}
            onChange={(e) => update('costPrice', e.target.value)}
          />
          <Input
            label={t('products.edit.master.minMarginLabel')}
            type="number"
            suffix="%"
            value={data.minMargin}
            onChange={(e) => update('minMargin', e.target.value)}
          />
          <div />
          <Input
            label={t('products.edit.master.minPriceLabel')}
            type="number"
            prefix="€"
            value={data.minPrice}
            onChange={(e) => update('minPrice', e.target.value)}
          />
          <Input
            label={t('products.edit.master.maxPriceLabel')}
            type="number"
            prefix="€"
            value={data.maxPrice}
            onChange={(e) => update('maxPrice', e.target.value)}
          />
        </div>
      </Card>
    </div>
  )
}

// W13.1 — AI suggest helpers. Two flavours:
//   - AiSuggestOverlay sits as an absolute-positioned button on top
//     of an Input row (used for the single-line title field).
//   - AiSuggestInline is a label-row affordance for textarea fields
//     where there's already a header row to dock onto.
function AiSuggestOverlay({
  busy,
  onClick,
  tooltip,
}: {
  busy: boolean
  onClick: () => void
  tooltip: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={tooltip}
      aria-label={tooltip}
      disabled={busy}
      className={cn(
        'absolute right-1.5 bottom-1.5 inline-flex items-center justify-center w-6 h-6 rounded text-slate-400 dark:text-slate-500 hover:bg-blue-50 dark:hover:bg-blue-950/40 hover:text-blue-600 dark:hover:text-blue-400 transition-colors',
        busy && 'opacity-50 cursor-wait',
      )}
    >
      {busy ? (
        <Loader2 className="w-3.5 h-3.5 animate-spin" />
      ) : (
        <Sparkles className="w-3.5 h-3.5" />
      )}
    </button>
  )
}

function AiSuggestInline({
  busy,
  onClick,
  label,
  tooltip,
}: {
  busy: boolean
  onClick: () => void
  label: string
  tooltip: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={tooltip}
      disabled={busy}
      className={cn(
        'inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded text-slate-500 dark:text-slate-400 hover:bg-blue-50 dark:hover:bg-blue-950/40 hover:text-blue-600 dark:hover:text-blue-400 transition-colors',
        busy && 'opacity-50 cursor-wait',
      )}
    >
      {busy ? (
        <Loader2 className="w-3 h-3 animate-spin" />
      ) : (
        <Sparkles className="w-3 h-3" />
      )}
      {label}
    </button>
  )
}

// W14.7 — character counter for the master product name.
//
// eBay's 80-char title limit is the most restrictive across our
// channels; Amazon 200; Shopify unlimited. We surface eBay as the
// headline so an operator writing for "all channels in one shot"
// stays inside the tightest envelope. Channel-specific overrides
// can still extend per-channel.
const NAME_LIMITS = [
  { channel: 'eBay', limit: 80 },
  { channel: 'Amazon', limit: 200 },
] as const

function NameCounter({
  value,
  t,
}: {
  value: string
  t: (key: string, vars?: Record<string, string | number>) => string
}) {
  const len = value.length
  const ebayLimit = NAME_LIMITS[0].limit
  const tone =
    len === 0
      ? 'idle'
      : len > ebayLimit
        ? 'over'
        : len > ebayLimit * 0.9
          ? 'near'
          : 'ok'
  return (
    <div className="mt-1 text-right">
      <span
        className={cn(
          'inline-block tabular-nums font-mono text-[10px] px-1.5 py-px rounded',
          tone === 'over' &&
            'text-rose-700 dark:text-rose-300 bg-rose-50 dark:bg-rose-950/40',
          tone === 'near' &&
            'text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/40',
          tone === 'ok' &&
            'text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-950/40',
          tone === 'idle' && 'text-slate-500 dark:text-slate-400',
        )}
        title={NAME_LIMITS.map((c) => `${c.channel}: ${c.limit}`).join(' · ')}
      >
        {t('products.edit.master.nameCount', { len, ebayLimit })}
      </span>
    </div>
  )
}

// W3.1 — character counter for the master description.
//
// Per-channel limits we surface as guidance (not enforcement; the
// master row is locale-agnostic and can hold longer copy than any
// single channel accepts; the operator decides whether to truncate
// per-channel via overrides). Surfacing the most-restrictive limit
// (Amazon's 2000) as the headline keeps the operator inside the
// safe envelope by default.
const CHANNEL_DESCRIPTION_LIMITS = [
  { channel: 'Amazon', limit: 2000 },
  { channel: 'eBay', limit: 4000 },
  { channel: 'Shopify', limit: 65000 },
] as const

function DescriptionCounter({
  value,
  t,
}: {
  value: string
  t: (key: string, vars?: Record<string, string | number>) => string
}) {
  const len = value.length
  const amazonLimit = CHANNEL_DESCRIPTION_LIMITS[0].limit
  const tone =
    len === 0
      ? 'idle'
      : len > amazonLimit
        ? 'over'
        : len > amazonLimit * 0.9
          ? 'near'
          : 'ok'
  return (
    <div className="mt-1.5 flex items-center justify-between gap-2 flex-wrap text-xs">
      <div className="text-slate-500 dark:text-slate-400">
        {t('products.edit.master.descriptionLimitsHint')}
      </div>
      <div
        className={cn(
          'tabular-nums font-mono px-1.5 py-0.5 rounded',
          tone === 'over' &&
            'text-rose-700 dark:text-rose-300 bg-rose-50 dark:bg-rose-950/40',
          tone === 'near' &&
            'text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/40',
          tone === 'ok' &&
            'text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-950/40',
          tone === 'idle' &&
            'text-slate-500 dark:text-slate-400',
        )}
        title={CHANNEL_DESCRIPTION_LIMITS.map(
          (c) => `${c.channel}: ${c.limit}`,
        ).join(' · ')}
      >
        {t('products.edit.master.descriptionCount', {
          len,
          amazonLimit,
        })}
      </div>
    </div>
  )
}

function bulletCount(raw: string): number {
  return raw
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0).length
}

function ConflictBanner({
  expected,
  current,
  onReload,
  onDismiss,
  t,
}: {
  expected: number
  current: number | null
  onReload: () => void
  onDismiss: () => void
  t: (key: string, vars?: Record<string, string | number>) => string
}) {
  return (
    <div
      role="alert"
      className="border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 rounded-lg px-4 py-3 flex items-start justify-between gap-3"
    >
      <div className="flex items-start gap-2 min-w-0">
        <AlertCircle className="w-4 h-4 mt-0.5 text-amber-600 dark:text-amber-400 flex-shrink-0" />
        <div className="min-w-0">
          <div className="text-md font-semibold text-amber-900 dark:text-amber-200">
            {t('products.edit.conflict.title')}
          </div>
          <div className="text-sm text-amber-800 dark:text-amber-300 mt-0.5">
            {current != null
              ? t('products.edit.conflict.body', { expected, current })
              : t('products.edit.conflict.bodyNoCurrent', { expected })}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-1 flex-shrink-0">
        <Button variant="primary" size="sm" onClick={onReload}>
          <RefreshCw className="w-3.5 h-3.5 mr-1.5" />
          {t('products.edit.conflict.reload')}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={onDismiss}
          aria-label={t('products.edit.conflict.dismiss')}
        >
          <X className="w-3.5 h-3.5" />
        </Button>
      </div>
    </div>
  )
}

function SaveStatusBar({
  status,
  error,
  t,
}: {
  status: SaveStatus
  error: string | null
  t: (key: string, vars?: Record<string, string | number>) => string
}) {
  if (status === 'idle') return null
  return (
    <div
      className={cn(
        'inline-flex items-center gap-1.5 text-sm px-2 py-1 rounded border',
        status === 'saving' && 'border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-400 bg-slate-50 dark:bg-slate-800',
        status === 'saved' && 'border-emerald-200 dark:border-emerald-800 text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-950/40',
        status === 'error' && 'border-rose-200 dark:border-rose-800 text-rose-700 dark:text-rose-300 bg-rose-50 dark:bg-rose-950/40',
      )}
    >
      {status === 'saving' && <Loader2 className="w-3 h-3 animate-spin" />}
      {status === 'saved' && <CheckCircle2 className="w-3 h-3" />}
      {status === 'error' && <AlertCircle className="w-3 h-3" />}
      {status === 'saving' && t('products.edit.savingFlag')}
      {status === 'saved' && t('products.edit.savedFlag')}
      {status === 'error' && (error ?? 'Save failed')}
    </div>
  )
}

function SelectField({
  label,
  value,
  onChange,
  options,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  options: Array<{ value: string; label: string }>
}) {
  return (
    <div className="space-y-1">
      <label className="text-base font-medium text-slate-700 dark:text-slate-300">{label}</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full h-8 rounded-md border border-slate-200 dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-600 bg-white dark:bg-slate-900 text-md text-slate-900 dark:text-slate-100 px-3 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-colors"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  )
}

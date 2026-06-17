'use client'

// EC.1.2 — EbayCockpit shell.
//
// 3-zone layout for the new eBay listing surface:
//   • Header strip: market chip, status, "back to classic" link, action
//     placeholders (Pull / AI / Publish — wired in EC.10).
//   • Preview / health band (collapsible): live eBay-styled preview + a
//     placeholder for the EC.9 health score panel.
//   • Cards section: placeholder cards for Category, Aspects,
//     Variations, Images, Pricing, Policies. Each card is a stub in
//     EC.1 — they fill in across EC.4–EC.8.
//
// During EC.1 we ALSO render the existing ChannelListingTab below the
// cards as a transitional pass-through so no data wiring is lost.
// The pass-through goes away phase-by-phase as each card supersedes
// the corresponding ChannelListingTab section.

import { useEffect, useMemo, useState } from 'react'
import { Send, ExternalLink, Settings2, History, Layers, ListTree, Link2 } from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { cn } from '@/lib/utils'
import { useTranslations } from '@/lib/i18n/use-translations'
import {
  COCKPIT_ROOT,
  CockpitHeader,
  CockpitPreviewBand,
  CockpitCardGrid,
  CockpitClassicPassthrough,
  CockpitDrawer,
  useCockpitFlag,
  IdentifiersCard,
  FieldScopePopover,
  PropagationDiffModal,
  CrossChannelMatrix,
  LinkSuggestionsBanner,
  useFieldLinks,
  type ScopeMember,
  type PropagatePreview,
  type FieldSource,
} from '../../_shared/cockpit-shell'

/** A linkable content field surfaced in the Shared-fields card.
 *  fieldKey matches the Amazon keys so a link group can span channels. */
interface LinkField {
  fieldKey: string
  label: string
  value: string | null
  translatable: boolean
  source: FieldSource
}
import MarketChipStrip from '../../_shared/market-switch/MarketChipStrip'
import { useMarketSwitch } from '../../_shared/market-switch/useMarketSwitch'
import { compareMarketChips, type MarketChip } from '../../_shared/market-switch/types'
import { postCockpitEvent } from '../../_shared/telemetry/cockpit-telemetry'
import ChannelListingTab from '../ChannelListingTab'
import { useEbayCompositor } from './useEbayCompositor'
import { useCockpitMode } from './useCockpitMode'
import EbayLivePreview from './EbayLivePreview'
import { FieldSourceProvider } from './field-source/FieldSourceProvider'
import SourceDiffModal from './field-source/SourceDiffModal'
import ListingEssentialsCard from './cards/ListingEssentialsCard'
import CategoryCard from './cards/CategoryCard'
import AspectsCard from './cards/AspectsCard'
import VariationsMatrixCard from './cards/VariationsMatrixCard'
import ImagesCard from './cards/ImagesCard'
import PricingPoliciesCard from './cards/PricingPoliciesCard'
import FulfillmentMethodCard from './cards/FulfillmentMethodCard'
import CompatibilityCard from './cards/CompatibilityCard'
import ApplyToSiblingsModal from './templates/ApplyToSiblingsModal'
import MasterDivergenceBanner from './backwrite/MasterDivergenceBanner'
import HealthScoreRail from './health/HealthScoreRail'
import VersionHistoryDrawer from './versioning/VersionHistoryDrawer'
import PublishDrawer from './publish/PublishDrawer'
import { useEbayChannelEvents } from './realtime/useEbayChannelEvents'
import HeartbeatDot from './realtime/HeartbeatDot'
import CrossTabChangeToast from './realtime/CrossTabChangeToast'

interface MarketInfo {
  code: string
  name: string
  channel: string
  marketplaceId?: string | null
  region: string
  currency: string
  language: string
  domainUrl?: string | null
}

interface Listing {
  id: string
  channel: string
  marketplace: string
  channelMarket: string
  region: string
  title: string | null
  description: string | null
  price: string | number | null
  quantity: number | null
  isPublished: boolean
  listingStatus: string
  externalListingId: string | null
  bulletPointsOverride: string[] | null
  pricingRule?: string | null
  priceOverride?: string | number | null
  priceAdjustmentPercent?: string | number | null
  followMasterPrice?: boolean
  [key: string]: any
}

interface ChildProduct {
  id: string
  sku: string
  name?: string | null
  variantLabel?: string | null
}

interface Props {
  product: any
  marketplace: string
  marketInfo: MarketInfo
  siblingMarkets?: MarketInfo[]
  /** EC.2 — listings for OTHER marketplaces on the same channel.
   *  Feeds the Sibling source resolver in ListingEssentialsCard so
   *  operators can pull title/description/price from a sister IT/DE
   *  listing. Optional because ProductEditClient may not always
   *  provide it. */
  siblingListings?: Listing[]
  listing: Listing | undefined
  onDirtyChange: (count: number) => void
  onSave: (updated: Listing) => void
  onRegister?: (handlers: {
    flush: () => Promise<void>
    discard: () => void
  }) => void
  childrenList?: ChildProduct[]
  /** UC.9.1 — market-switch wiring (parity with Amazon). Optional so
   *  the cockpit still renders if the parent doesn't provide them. */
  onMarketSwitch?: (code: string) => void
  getDirtyForMarket?: (code: string) => number
  flushActiveMarket?: () => Promise<void>
  discardActiveMarket?: () => void
}

const STATUS_TONE: Record<string, { bg: string; text: string }> = {
  ACTIVE:    { bg: 'bg-emerald-100 dark:bg-emerald-950/50', text: 'text-emerald-700 dark:text-emerald-300' },
  DRAFT:     { bg: 'bg-amber-100 dark:bg-amber-950/50',     text: 'text-amber-700 dark:text-amber-300'     },
  ENDED:     { bg: 'bg-slate-100 dark:bg-slate-800',        text: 'text-slate-600 dark:text-slate-400'     },
  INACTIVE:  { bg: 'bg-slate-100 dark:bg-slate-800',        text: 'text-slate-600 dark:text-slate-400'     },
  ERROR:     { bg: 'bg-rose-100 dark:bg-rose-950/50',       text: 'text-rose-700 dark:text-rose-300'       },
}

export default function EbayCockpit(props: Props) {
  const {
    product, marketplace, marketInfo, siblingMarkets, siblingListings = [], listing, childrenList,
    onMarketSwitch, getDirtyForMarket, flushActiveMarket, discardActiveMarket,
  } = props
  const { t } = useTranslations()
  const [, setMode] = useCockpitMode()
  const [previewOpen, setPreviewOpen] = useState(true)
  const [classicOpen, setClassicOpen] = useState(true)
  // AF.4/5 — "All fields" drawer (flag-guarded; keepMounted keeps the
  // editor's dirty/save lifecycle identical to today).
  const useDrawer = useCockpitFlag('all-fields-drawer', true)
  const [allFieldsOpen, setAllFieldsOpen] = useState(false)
  const [versionDrawerOpen, setVersionDrawerOpen] = useState(false)
  // FL — per-field scope control (parity with Amazon). Same fieldKeys so
  // a link group can span Amazon + eBay.
  const fieldLinks = useFieldLinks(product.id)
  const [scopeFieldKey, setScopeFieldKey] = useState<string | null>(null)
  // OL.A.5 — cross-channel matrix drawer (parity with the Amazon cockpit).
  const [xChannelOpen, setXChannelOpen] = useState(false)
  const [propagateField, setPropagateField] = useState<LinkField | null>(null)
  const [propagateData, setPropagateData] = useState<PropagatePreview | null>(null)
  const [propagateBusy, setPropagateBusy] = useState(false)
  const [publishDrawerOpen, setPublishDrawerOpen] = useState(false)
  const [siblingsModalOpen, setSiblingsModalOpen] = useState(false)

  // EC.10 — Version history. Snapshots live on
  // ChannelListing.platformAttributes._versionHistory[] (capped 10),
  // populated by POST /api/ebay/cockpit/snapshot. The drawer reads
  // straight from the prop and surfaces a Restore button per row.
  const versionHistory = useMemo(() => {
    const raw = (listing?.platformAttributes as Record<string, unknown> | null)?._versionHistory
    if (!Array.isArray(raw)) return []
    return raw as Array<{
      id: string
      ts: string
      reason: string
      snapshot: {
        platformAttributes: Record<string, unknown>
        priceOverride: number | null
        quantity: number | null
      }
    }>
  }, [listing])

  const composed = useEbayCompositor({
    product,
    listing,
    marketInfo,
    children: childrenList?.map((c) => ({ id: c.id })) ?? [],
  })

  // EC.3 — Real-time event hook filtered to THIS product + marketplace.
  // Drives the header heartbeat dot, status-chip pulse, and the
  // CrossTabChangeToast below the header.
  const events = useEbayChannelEvents({
    productId: product.id,
    marketplace,
    currentListingId: listing?.id,
    siblingListingIds: siblingListings
      .map((l) => l.id)
      .filter((id): id is string => typeof id === 'string'),
  })

  const tone = STATUS_TONE[composed.status.listingStatus] ?? STATUS_TONE.DRAFT
  // Status chip pulses for 3s after the listing changes elsewhere.
  const listingPulse =
    events.listingUpdatedAt != null &&
    Date.now() - events.listingUpdatedAt < 3000

  // UC.9.1 — market chips (parity with Amazon). Built from marketInfo +
  // siblingMarkets, per-market status from the listings the parent
  // already fetched, dirty counts via getDirtyForMarket.
  const chips = useMemo<MarketChip[]>(() => {
    const ordered: MarketInfo[] = [marketInfo, ...(siblingMarkets ?? [])].filter(
      (m, i, arr) => arr.findIndex((x) => x.code === m.code) === i,
    )
    return ordered
      .map((m) => {
        const l =
          m.code === marketInfo.code
            ? listing
            : siblingListings.find((sl) => sl.marketplace === m.code)
        return {
          code: m.code,
          name: m.name,
          hasListing: !!l,
          listingStatus: l?.listingStatus ?? null,
          dirtyCount: getDirtyForMarket?.(m.code) ?? 0,
        }
      })
      .sort(compareMarketChips)
  }, [marketInfo, siblingMarkets, listing, siblingListings, getDirtyForMarket])

  const activeDirty = getDirtyForMarket?.(marketInfo.code) ?? 0
  const { switchTo } = useMarketSwitch({
    channel: 'EBAY',
    active: marketInfo.code,
    markets: chips,
    onSwitch: (code) => onMarketSwitch?.(code),
    flush: flushActiveMarket,
    discard: discardActiveMarket,
    isDirty: activeDirty,
    syncUrl: true,
  })

  // UC.9.3 — telemetry parity: one mount event per cockpit instance.
  useEffect(() => {
    postCockpitEvent({
      type: 'cockpit_mounted',
      productId: product.id,
      marketplace: marketInfo.code,
      payload: { channel: 'EBAY', language: marketInfo.language },
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // FL — scope members + linkable content fields (same fieldKeys as
  // Amazon so a link group spans channels).
  const scopeMembers: ScopeMember[] = chips.map((c) => ({
    key: `EBAY:${c.code}`,
    channel: 'EBAY',
    marketplace: c.code,
    label: `eBay ${c.code}`,
  }))
  const linkFields: LinkField[] = [
    { fieldKey: 'item_name', label: 'Title', value: composed.title.value || null, translatable: true, source: composed.title.source },
    { fieldKey: 'product_description', label: 'Description', value: composed.description.value || null, translatable: true, source: composed.description.source },
    { fieldKey: 'our_price', label: 'Price', value: composed.price.value != null ? `${composed.currency} ${composed.price.value.toFixed(2)}` : null, translatable: false, source: composed.price.source },
    { fieldKey: 'brand', label: 'Brand', value: composed.brand.value || null, translatable: false, source: composed.brand.source },
  ]
  const activeScopeField = scopeFieldKey ? linkFields.find((f) => f.fieldKey === scopeFieldKey) ?? null : null
  const scopeRows = linkFields.map((f) => ({
    label: f.label,
    value: f.value,
    source: fieldLinks.scopeFor(f.fieldKey) === 'linked' ? ('linked' as const) : f.source,
    onSourceClick: () => setScopeFieldKey(f.fieldKey),
  }))

  // AF.4/5 — single classic-editor element, hosted by EITHER the
  // All-fields drawer (flag on) or the legacy stacked pass-through.
  const classicEditor = (
    <ChannelListingTab
      product={product}
      channel="EBAY"
      marketplace={marketplace}
      marketInfo={marketInfo}
      siblingMarkets={siblingMarkets}
      listing={listing}
      onDirtyChange={props.onDirtyChange}
      onSave={props.onSave}
      onRegister={props.onRegister}
      childrenList={childrenList}
    />
  )

  return (
    <FieldSourceProvider productId={product.id} marketplace={marketplace}>
    <div className={COCKPIT_ROOT}>
      {/* ── Zone 1: Header strip (UC.4 — shared CockpitHeader) ─────── */}
      <CockpitHeader
        ariaLabel="eBay Listing Cockpit header"
        chipStrip={
          chips.length > 1 ? (
            <div className="px-4 py-2 border-b border-subtle dark:border-slate-800 bg-slate-50/60 dark:bg-slate-900/40 flex items-center gap-3 flex-wrap">
              <span className="text-[10.5px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                {t('products.edit.cockpit.ebay.markets')}
              </span>
              <MarketChipStrip
                markets={chips}
                active={marketInfo.code}
                onSelect={(code) => void switchTo(code)}
                shortcutsHint
                className="min-w-0 flex-1"
              />
            </div>
          ) : null
        }
        leading={
          <Badge mono variant={listing ? 'info' : 'warning'}>
            {marketInfo.code}
          </Badge>
        }
        title={marketInfo.name}
        titlePills={
          <>
            <span
              className={cn(
                'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10.5px] font-medium transition-all',
                tone.bg,
                tone.text,
                // EC.3 — flash a ring for 3s after the listing changes
                // elsewhere so the operator notices the status came
                // from a remote update.
                listingPulse && 'ring-2 ring-emerald-300 dark:ring-emerald-700',
              )}
            >
              {composed.status.listingStatus}
            </span>
            <HeartbeatDot
              connected={events.connected}
              secondsSinceLast={events.secondsSinceLast}
            />
            {composed.status.publicUrl && (
              <a
                href={composed.status.publicUrl}
                target="_blank"
                rel="noreferrer"
                className="text-xs text-blue-600 dark:text-blue-400 hover:underline inline-flex items-center gap-0.5"
              >
                View <ExternalLink className="w-3 h-3" />
              </a>
            )}
          </>
        }
        subtitle={
          <>
            {composed.status.externalListingId ? (
              <span className="font-mono text-xs">{composed.status.externalListingId}</span>
            ) : (
              <span>{t('products.edit.cockpit.ebay.notListed')}</span>
            )}
            <span>·</span>
            <span>{marketInfo.currency}</span>
            <span>·</span>
            <span className="uppercase tracking-wide">{marketInfo.language}</span>
          </>
        }
        actions={
          <>
            {/* P.1 — removed the disabled Pull / AI placeholder buttons
                (their tooltips referenced the old stacked classic editor,
                now the All-fields drawer). */}
            <Button
              size="sm"
              icon={<Send className="w-3.5 h-3.5" />}
              onClick={() => setPublishDrawerOpen(true)}
              title={t('products.edit.cockpit.ebay.publishTitle', { market: marketInfo.code })}
            >
              {t('products.edit.cockpit.ebay.publish')}
            </Button>
            {/* OL.A.5 — cross-channel propagation (parity with Amazon cockpit) */}
            <button
              type="button"
              onClick={() => setXChannelOpen(true)}
              className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded border border-default dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800"
              title={t('products.edit.cockpit.ebay.crossChannelTitle')}
            >
              <Link2 className="w-3 h-3" /> {t('products.edit.cockpit.ebay.crossChannel')}
            </button>
            <button
              type="button"
              onClick={() => setSiblingsModalOpen(true)}
              className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded border border-default dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800"
              title={t('products.edit.cockpit.ebay.applyToSiblingsTitle')}
            >
              <Layers className="w-3 h-3" /> {t('products.edit.cockpit.ebay.applyToSiblings')}
            </button>
            <button
              type="button"
              onClick={() => setVersionDrawerOpen(true)}
              className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded border border-default dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800"
              title={t('products.edit.cockpit.ebay.historyTitle')}
            >
              <History className="w-3 h-3" /> {t('products.edit.cockpit.ebay.history')}
              {versionHistory.length > 0 && (
                <span className="text-[10px] font-mono px-1 py-0 rounded bg-slate-100 dark:bg-slate-800 text-slate-500 ml-0.5">
                  {versionHistory.length}
                </span>
              )}
            </button>
            {useDrawer && (
              <button
                type="button"
                onClick={() => setAllFieldsOpen(true)}
                className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded border border-default dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800"
                title={t('products.edit.cockpit.ebay.allFieldsTitle')}
              >
                <ListTree className="w-3 h-3" /> {t('products.edit.cockpit.ebay.allFields')}
              </button>
            )}
            {/* SY.1 — outbound handoff to the bulk eBay flat-file editor. */}
            <a
              href={`/products/ebay-flat-file?marketplace=${encodeURIComponent(marketInfo.code)}&familyId=${encodeURIComponent(product.id)}`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded border border-default dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800"
              title={t('products.edit.cockpit.ebay.editInBulkTitle')}
            >
              {t('products.edit.cockpit.ebay.editInBulk')} <ExternalLink className="w-3 h-3" />
            </a>
            <button
              type="button"
              onClick={() => setMode('classic')}
              className="ml-1 inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-900 dark:hover:text-slate-200 underline-offset-2 hover:underline"
              title={t('products.edit.cockpit.ebay.classicViewTitle')}
            >
              <Settings2 className="w-3 h-3" /> {t('products.edit.cockpit.ebay.classicView')}
            </button>
          </>
        }
      />

      {/* OL.A.5 — smart link suggestions (parity with the Amazon cockpit). */}
      <LinkSuggestionsBanner
        suggestions={fieldLinks.suggestions}
        onLink={(s) => void fieldLinks.linkSuggestion(s)}
        onDismiss={fieldLinks.dismissSuggestion}
      />

      {/* EC.3 — Cross-tab change toast. Slim banner that surfaces
          when Master / Translations / Images / a sibling listing
          changes for THIS product while the cockpit is open. */}
      <CrossTabChangeToast
        masterChangedAt={events.masterChangedAt}
        listingUpdatedAt={events.listingUpdatedAt}
        siblingChangedAt={events.siblingChangedAt}
      />

      {/* EC.15 — Cross-tab BACK-write. Fires when cockpit edits
          (title / description / price) diverge from the Product
          master AND were authored locally (manual / ai / sibling).
          Prompts to promote the cockpit value back UP to Master so
          every other channel sees the improvement. */}
      <MasterDivergenceBanner
        productId={product.id}
        marketplace={marketplace}
        initial={{
          title: { source: composed.title.source, value: composed.title.value },
          description: { source: composed.description.source, value: composed.description.value },
          price: {
            source: composed.price.source,
            value: composed.price.value != null ? String(composed.price.value) : '',
          },
        }}
        master={{
          name: (product?.name as string | null) ?? null,
          description: (product?.description as string | null) ?? null,
          basePrice: (() => {
            const v = product.basePrice
            if (v == null || v === '') return null
            const n = typeof v === 'string' ? parseFloat(v) : Number(v)
            return Number.isFinite(n) ? n : null
          })(),
        }}
      />

      {/* ── Zone 2: Preview + Health band (UC.4 — shared band) ────── */}
      <CockpitPreviewBand
        open={previewOpen}
        onToggle={() => setPreviewOpen((o) => !o)}
        title={t('products.edit.cockpit.ebay.preview.title')}
        subtitle={t('products.edit.cockpit.ebay.preview.subtitle', { market: marketInfo.code })}
        healthWidth="280px"
        contentClassName="bg-slate-50/40 dark:bg-slate-900/30"
        preview={<EbayLivePreview composed={composed} />}
        health={
          <HealthScoreRail
            marketplace={marketplace}
            categoryId={composed.categoryId.value}
            categoryName={composed.categoryLabel.value}
            categoryPath={((listing?.platformAttributes as Record<string, unknown> | null)
              ?.categoryPath as string | undefined) ?? null}
            title={composed.title.value}
            description={composed.description.value}
            brand={composed.brand.value}
            gtin={(product?.gtin as string | null) ?? null}
            mpn={(product?.mpn as string | null) ?? null}
            priceValue={composed.price.value}
            imageCount={composed.galleryUrls.value.length}
            itemSpecifics={
              (((listing?.platformAttributes as Record<string, unknown> | null)
                ?.itemSpecifics as Record<string, unknown> | undefined) ?? {})
            }
            policies={{
              fulfillmentPolicyId: ((listing?.platformAttributes as Record<string, unknown> | null)?.fulfillmentPolicyId as string | null) ?? null,
              paymentPolicyId: ((listing?.platformAttributes as Record<string, unknown> | null)?.paymentPolicyId as string | null) ?? null,
              returnPolicyId: ((listing?.platformAttributes as Record<string, unknown> | null)?.returnPolicyId as string | null) ?? null,
              merchantLocationKey: ((listing?.platformAttributes as Record<string, unknown> | null)?.merchantLocationKey as string | null) ?? null,
            }}
          />
        }
      />

      {/* ── Zone 3: Cards (UC.4 — shared CockpitCardGrid, sequential) ─ */}
      <CockpitCardGrid layout="sequential">
      {/* FL — Shared fields: scope pill (master / linked / independent)
          + propagate per linkable content field. */}
      <IdentifiersCard title={t('products.edit.cockpit.ebay.sharedFields')} rows={scopeRows} />
      {/* ── EC.2 — Listing Essentials (Field Source System demo) ──── */}
      <ListingEssentialsCard
        productId={product.id}
        marketplace={marketplace}
        currency={marketInfo.currency}
        initial={{
          title: { source: composed.title.source, value: composed.title.value },
          description: { source: composed.description.source, value: composed.description.value },
          price: {
            source: composed.price.source,
            value: composed.price.value != null ? String(composed.price.value) : '',
          },
        }}
        master={{
          name: product.name ?? '',
          description: product.description ?? '',
          price: (() => {
            const raw = product.basePrice
            if (raw == null || raw === '') return null
            const n = typeof raw === 'string' ? parseFloat(raw) : Number(raw)
            return Number.isFinite(n) ? n : null
          })(),
        }}
        siblings={siblingListings.map((l) => {
          const priceRaw = l.priceOverride ?? l.price
          const priceNum = priceRaw == null
            ? null
            : typeof priceRaw === 'string'
            ? parseFloat(priceRaw)
            : Number(priceRaw)
          return {
            marketplace: l.marketplace,
            title: l.title ?? '',
            description: l.description ?? '',
            price: Number.isFinite(priceNum) ? (priceNum as number) : null,
          }
        })}
      />

      {/* ── EC.4 — Category card (replaces the EC.1 placeholder) ───── */}
      <CategoryCard
        productId={product.id}
        marketplace={marketplace}
        marketName={marketInfo.name}
        siblingMarketCodes={(siblingMarkets ?? []).map((m) => m.code)}
        seedTitle={composed.title.value}
        seedDescription={composed.description.value}
        current={{
          id: composed.categoryId.value,
          name: composed.categoryLabel.value,
          path: ((listing?.platformAttributes as Record<string, unknown> | null)
            ?.categoryPath as string | undefined) ?? null,
        }}
      />

      {/* ── EC.5 — Aspects card (dynamic, Field Source aware) ─────── */}
      <AspectsCard
        productId={product.id}
        marketplace={marketplace}
        categoryId={composed.categoryId.value}
        initialItemSpecifics={
          (((listing?.platformAttributes as Record<string, unknown> | null)
            ?.itemSpecifics as Record<string, string | string[]> | undefined) ?? {})
        }
        master={{
          brand: (product.brand as string | null) ?? null,
          color: (product.color as string | null) ?? null,
          size: (product.size as string | null) ?? null,
          material: (product.material as string | null) ?? null,
          gender: (product.gender as string | null) ?? null,
          productType: (product.productType as string | null) ?? null,
          weightG: (product.weightG as number | null) ?? null,
          countryOfOrigin: (product.countryOfOrigin as string | null) ?? null,
          mpn: (product.mpn as string | null) ?? null,
          gtin: (product.gtin as string | null) ?? null,
          ean: (product.ean as string | null) ?? null,
          upc: (product.upc as string | null) ?? null,
        }}
        siblings={siblingListings.map((l) => ({
          marketplace: l.marketplace,
          itemSpecifics:
            (((l.platformAttributes as Record<string, unknown> | null)
              ?.itemSpecifics as Record<string, string[]> | undefined) ?? {}),
        }))}
      />

      {/* ── EC.6 — Variations Matrix (replaces placeholder) ─────────── */}
      <VariationsMatrixCard
        productId={product.id}
        marketplace={marketplace}
        currency={marketInfo.currency}
        isParentWithChildren={(childrenList?.length ?? 0) > 0}
      />

      {/* ── EC.7 — Images card (replaces placeholder) ─────────────── */}
      <ImagesCard
        productId={product.id}
        marketplace={marketplace}
        productUpdatedAt={(product?.updatedAt as string | undefined) ?? null}
      />

      {/* ── EC.8 — Pricing + Best Offer + Policies (one card) ──────── */}
      <PricingPoliciesCard
        productId={product.id}
        marketplace={marketplace}
        currency={marketInfo.currency}
        initial={{
          priceOverride: (() => {
            const v = listing?.priceOverride
            if (v == null || v === '') return null
            const n = typeof v === 'string' ? parseFloat(v) : Number(v)
            return Number.isFinite(n) ? n : null
          })(),
          pricingRule: ((listing?.pricingRule as string | undefined) ?? 'FIXED') as 'FIXED' | 'MATCH_AMAZON' | 'PERCENT_OF_MASTER',
          priceAdjustmentPercent: (() => {
            const v = listing?.priceAdjustmentPercent
            if (v == null || v === '') return null
            const n = typeof v === 'string' ? parseFloat(v) : Number(v)
            return Number.isFinite(n) ? n : null
          })(),
          bestOfferEnabled: !!((listing?.platformAttributes as Record<string, unknown> | null)?.bestOfferEnabled),
          bestOfferAutoAcceptPrice: ((listing?.platformAttributes as Record<string, unknown> | null)?.bestOfferAutoAcceptPrice as number | null) ?? null,
          bestOfferMinAcceptPrice: ((listing?.platformAttributes as Record<string, unknown> | null)?.bestOfferMinAcceptPrice as number | null) ?? null,
          fulfillmentPolicyId: ((listing?.platformAttributes as Record<string, unknown> | null)?.fulfillmentPolicyId as string | null) ?? null,
          paymentPolicyId: ((listing?.platformAttributes as Record<string, unknown> | null)?.paymentPolicyId as string | null) ?? null,
          returnPolicyId: ((listing?.platformAttributes as Record<string, unknown> | null)?.returnPolicyId as string | null) ?? null,
          merchantLocationKey: ((listing?.platformAttributes as Record<string, unknown> | null)?.merchantLocationKey as string | null) ?? null,
        }}
        masterPrice={(() => {
          const v = product.basePrice
          if (v == null || v === '') return null
          const n = typeof v === 'string' ? parseFloat(v) : Number(v)
          return Number.isFinite(n) ? n : null
        })()}
      />

      {/* ── FCF.5b — Fulfillment method (FBM vs Amazon MCF) ─────────── */}
      <FulfillmentMethodCard productId={product.id} marketplace={marketplace} />

      {/* ── EC.13 — Compatibility (motors) — replaces placeholder ───── */}
      <CompatibilityCard
        productId={product.id}
        marketplace={marketplace}
        categoryName={composed.categoryLabel.value}
        categoryPath={((listing?.platformAttributes as Record<string, unknown> | null)
          ?.categoryPath as string | undefined) ?? null}
        productName={(product?.name as string | null) ?? null}
        productType={(product?.productType as string | null) ?? null}
        initial={(() => {
          const raw = (listing?.platformAttributes as Record<string, unknown> | null)?.compatibility
          if (raw && typeof raw === 'object') {
            const r = raw as Record<string, unknown>
            return {
              universal: typeof r.universal === 'boolean' ? r.universal : true,
              fitments: Array.isArray(r.fitments)
                ? (r.fitments as Array<Record<string, unknown>>).map((f) => ({
                    year: String(f?.year ?? ''),
                    make: String(f?.make ?? ''),
                    model: String(f?.model ?? ''),
                    submodel: f?.submodel ? String(f.submodel) : null,
                  }))
                : [],
              updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : null,
            }
          }
          return { universal: true, fitments: [], updatedAt: null }
        })()}
      />
      </CockpitCardGrid>

      {/* ── Zone 4 — classic editor (AF.4/5) ─────────────────────────
          Full classic editor in a slide-over when the All-fields drawer
          flag is on; legacy stacked pass-through otherwise. Single
          instance either way. */}
      {useDrawer ? (
        <CockpitDrawer
          keepMounted
          open={allFieldsOpen}
          onClose={() => setAllFieldsOpen(false)}
          width="full"
          title={`${t('products.edit.cockpit.ebay.allFields')} — eBay ${marketInfo.code}`}
        >
          {classicEditor}
        </CockpitDrawer>
      ) : (
        <CockpitClassicPassthrough
          open={classicOpen}
          onToggle={() => setClassicOpen((o) => !o)}
          label={
            <>
              <span className="text-md font-medium text-slate-900 dark:text-slate-100">
                {t('products.edit.cockpit.ebay.classic.title')}
              </span>
              <Badge variant="info">{t('products.edit.cockpit.ebay.classic.transitional')}</Badge>
              <span className="text-xs text-slate-500 dark:text-slate-400">
                {t('products.edit.cockpit.ebay.classic.subtitle')}
              </span>
            </>
          }
        >
          {classicEditor}
        </CockpitClassicPassthrough>
      )}

      {/* EC.2 — Diff modal slot. Renders only when a source switch is
          pending; the slot is owned by FieldSourceProvider and only
          one modal can be open across the entire cockpit at a time. */}
      <SourceDiffModal />

      {/* EC.10 — Version history drawer (snapshots + restore). */}
      <VersionHistoryDrawer
        productId={product.id}
        marketplace={marketplace}
        marketName={marketInfo.name}
        currency={marketInfo.currency}
        history={versionHistory}
        open={versionDrawerOpen}
        onClose={() => setVersionDrawerOpen(false)}
      />

      {/* EC.11 — Publish drawer (Inventory API three-step flow). */}
      <PublishDrawer
        productId={product.id}
        marketplace={marketplace}
        marketName={marketInfo.name}
        hardFails={(() => {
          // Cheap client-side guards. The server enforces the
          // authoritative required-aspects check via the schema
          // endpoint inside POST /publish; the drawer's preflight
          // is just to keep the operator from firing an obviously-
          // doomed publish.
          const fails: Array<{ label: string; hint?: string }> = []
          if (!composed.categoryId.value) {
            fails.push({ label: 'No category picked', hint: 'Use the Category card above' })
          }
          if (composed.price.value == null || composed.price.value <= 0) {
            fails.push({ label: 'No price set', hint: 'Use the Pricing card above' })
          }
          if (!composed.title.value || composed.title.value.trim().length === 0) {
            fails.push({ label: 'No title set', hint: 'Use the Listing Essentials card above' })
          }
          if (composed.galleryUrls.value.length === 0) {
            fails.push({ label: 'No images attached', hint: 'Add at least one image in the Images tab' })
          }
          return fails
        })()}
        summary={{
          title: composed.title.value,
          categoryName: composed.categoryLabel.value,
          price: composed.price.value,
          currency: marketInfo.currency,
          quantity: composed.quantity.value,
          imageCount: composed.galleryUrls.value.length,
          aspectCount: Object.keys(
            (((listing?.platformAttributes as Record<string, unknown> | null)
              ?.itemSpecifics as Record<string, unknown> | undefined) ?? {}),
          ).length,
        }}
        open={publishDrawerOpen}
        onClose={() => setPublishDrawerOpen(false)}
      />

      {/* EC.14 — Apply layout to siblings. */}
      <ApplyToSiblingsModal
        productId={product.id}
        marketplace={marketplace}
        open={siblingsModalOpen}
        onClose={() => setSiblingsModalOpen(false)}
      />

      {/* OL.A.5 — cross-channel comparison + propagation drawer (Amazon + eBay). */}
      <CrossChannelMatrix
        productId={product.id}
        open={xChannelOpen}
        onClose={() => setXChannelOpen(false)}
      />

      {/* FL — per-field scope control + propagation (generic). */}
      <FieldScopePopover
        open={scopeFieldKey !== null}
        onClose={() => setScopeFieldKey(null)}
        fieldLabel={activeScopeField?.label ?? ''}
        marketLabel={`eBay ${marketInfo.code}`}
        scope={scopeFieldKey ? fieldLinks.scopeFor(scopeFieldKey) : 'master'}
        selectedMembers={scopeFieldKey ? fieldLinks.memberKeysFor(scopeFieldKey) : []}
        members={scopeMembers}
        canTranslate={activeScopeField?.translatable ?? false}
        onApply={(r) => {
          if (scopeFieldKey) {
            void fieldLinks.setScope(scopeFieldKey, r, { sourceLanguage: marketInfo.language })
          }
        }}
        onPropagate={() => {
          const f = activeScopeField
          if (!f) return
          setScopeFieldKey(null)
          void (async () => {
            const preview = await fieldLinks.propagatePreview(f.fieldKey, f.value ?? '', {
              channel: 'EBAY',
              marketplace: marketInfo.code,
              language: marketInfo.language,
            })
            setPropagateData(preview)
            setPropagateField(f)
          })()
        }}
      />
      <PropagationDiffModal
        open={propagateField !== null}
        onClose={() => {
          if (!propagateBusy) {
            setPropagateField(null)
            setPropagateData(null)
          }
        }}
        fieldLabel={propagateField?.label ?? ''}
        entries={propagateData?.entries ?? []}
        translatable={propagateData?.translatable ?? false}
        aiBudgetExceeded={propagateData?.aiBudgetExceeded}
        busy={propagateBusy}
        onApply={(selected) => {
          const f = propagateField
          if (!f) return
          void (async () => {
            setPropagateBusy(true)
            await fieldLinks.applyPropagation(f.fieldKey, selected)
            setPropagateBusy(false)
            setPropagateField(null)
            setPropagateData(null)
          })()
        }}
      />
    </div>
    </FieldSourceProvider>
  )
}

// EC.13 closes the last placeholder — every cockpit card is now a
// real surface. The legacy PlaceholderCard helper was removed.

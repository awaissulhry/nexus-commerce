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

import { useState } from 'react'
import { ChevronDown, ChevronUp, ArrowDownToLine, Sparkles, Send, ExternalLink, Settings2, Package } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { cn } from '@/lib/utils'
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
import HealthScoreRail from './health/HealthScoreRail'
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
}

const STATUS_TONE: Record<string, { bg: string; text: string }> = {
  ACTIVE:    { bg: 'bg-emerald-100 dark:bg-emerald-950/50', text: 'text-emerald-700 dark:text-emerald-300' },
  DRAFT:     { bg: 'bg-amber-100 dark:bg-amber-950/50',     text: 'text-amber-700 dark:text-amber-300'     },
  ENDED:     { bg: 'bg-slate-100 dark:bg-slate-800',        text: 'text-slate-600 dark:text-slate-400'     },
  INACTIVE:  { bg: 'bg-slate-100 dark:bg-slate-800',        text: 'text-slate-600 dark:text-slate-400'     },
  ERROR:     { bg: 'bg-rose-100 dark:bg-rose-950/50',       text: 'text-rose-700 dark:text-rose-300'       },
}

export default function EbayCockpit(props: Props) {
  const { product, marketplace, marketInfo, siblingMarkets, siblingListings = [], listing, childrenList } = props
  const [, setMode] = useCockpitMode()
  const [previewOpen, setPreviewOpen] = useState(true)
  const [classicOpen, setClassicOpen] = useState(true)

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

  return (
    <FieldSourceProvider productId={product.id} marketplace={marketplace}>
    <div className="space-y-4">
      {/* ── Zone 1: Header strip ────────────────────────────────── */}
      <div className="sticky top-14 z-[5]">
        <Card noPadding>
          <div className="px-4 py-3 flex items-center justify-between flex-wrap gap-3">
            <div className="flex items-center gap-3 min-w-0">
              <Badge mono variant={listing ? 'info' : 'warning'}>
                {marketInfo.code}
              </Badge>
              <div className="min-w-0">
                <div className="text-md font-semibold text-slate-900 dark:text-slate-100 truncate flex items-center gap-2">
                  {marketInfo.name}
                  <span
                    className={cn(
                      'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10.5px] font-medium transition-all',
                      tone.bg,
                      tone.text,
                      // EC.3 — flash a ring for 3s after the listing
                      // changes elsewhere so the operator notices the
                      // status came from a remote update.
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
                </div>
                <div className="text-sm text-slate-500 dark:text-slate-400 mt-0.5 flex items-center gap-2 flex-wrap">
                  {composed.status.externalListingId ? (
                    <span className="font-mono text-xs">{composed.status.externalListingId}</span>
                  ) : (
                    <span>Not yet listed on this marketplace</span>
                  )}
                  <span>·</span>
                  <span>{marketInfo.currency}</span>
                  <span>·</span>
                  <span className="uppercase tracking-wide">{marketInfo.language}</span>
                </div>
              </div>
            </div>

            <div className="flex items-center gap-2 flex-wrap">
              {/* EC.1 — these buttons are placeholders. The real Pull /
                  Translate / Publish wiring lives in the classic pane
                  below until EC.4–EC.10 land their replacements. */}
              <Button
                variant="secondary"
                size="sm"
                icon={<ArrowDownToLine className="w-3.5 h-3.5" />}
                disabled
                title="Coming in EC.6 — until then use the classic Pull below"
              >
                Pull
              </Button>
              <Button
                variant="secondary"
                size="sm"
                icon={<Sparkles className="w-3.5 h-3.5" />}
                disabled
                title="Coming in EC.12 — until then use the classic AI Translate below"
              >
                AI improve
              </Button>
              <Button
                size="sm"
                icon={<Send className="w-3.5 h-3.5" />}
                disabled
                title="Coming in EC.10 (Inventory API publish) — until then use the classic Publish below"
              >
                Publish
              </Button>
              <button
                type="button"
                onClick={() => setMode('classic')}
                className="ml-1 inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-900 dark:hover:text-slate-200 underline-offset-2 hover:underline"
                title="Switch back to the legacy view for this session"
              >
                <Settings2 className="w-3 h-3" /> Classic view
              </button>
            </div>
          </div>
        </Card>
      </div>

      {/* EC.3 — Cross-tab change toast. Slim banner that surfaces
          when Master / Translations / Images / a sibling listing
          changes for THIS product while the cockpit is open. */}
      <CrossTabChangeToast
        masterChangedAt={events.masterChangedAt}
        listingUpdatedAt={events.listingUpdatedAt}
        siblingChangedAt={events.siblingChangedAt}
      />

      {/* ── Zone 2: Preview + Health band (collapsible) ───────────── */}
      <Card noPadding>
        <button
          type="button"
          onClick={() => setPreviewOpen((o) => !o)}
          className="w-full px-4 py-2.5 flex items-center justify-between text-left border-b border-slate-100 dark:border-slate-800"
        >
          <div className="flex items-center gap-2">
            <span className="text-md font-medium text-slate-900 dark:text-slate-100">
              Live preview
            </span>
            <span className="text-xs text-slate-500 dark:text-slate-400">
              How operators see this on eBay {marketInfo.code}
            </span>
          </div>
          {previewOpen ? <ChevronUp className="w-4 h-4 text-slate-400" /> : <ChevronDown className="w-4 h-4 text-slate-400" />}
        </button>
        {previewOpen && (
          <div className="p-4 grid grid-cols-1 lg:grid-cols-[1fr_280px] gap-4 bg-slate-50/40 dark:bg-slate-900/30">
            <EbayLivePreview composed={composed} />
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
          </div>
        )}
      </Card>

      {/* ── EC.2 — Listing Essentials (Field Source System demo) ──── */}
      <ListingEssentialsCard
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

      {/* ── Zone 3: Remaining placeholder cards (EC.13) ──────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <PlaceholderCard
          icon={<Package className="w-4 h-4" />}
          title="Compatibility (motors)"
          phase="EC.13"
          value="Xavia motorcycle gear — fit list editor"
        />
      </div>

      {/* ── Transitional pass-through ─────────────────────────────────
          EC.1 keeps all existing ChannelListingTab functionality alive
          below the cards. Each EC.4–EC.8 phase replaces a corresponding
          section of this pane until the pass-through goes away. */}
      <Card noPadding>
        <button
          type="button"
          onClick={() => setClassicOpen((o) => !o)}
          className="w-full px-4 py-2.5 flex items-center justify-between text-left border-b border-slate-100 dark:border-slate-800"
        >
          <div className="flex items-center gap-2">
            <span className="text-md font-medium text-slate-900 dark:text-slate-100">
              Existing fields
            </span>
            <Badge variant="info">transitional</Badge>
            <span className="text-xs text-slate-500 dark:text-slate-400">
              All current eBay tab functionality, kept live while EC.4–EC.8 land
            </span>
          </div>
          {classicOpen ? <ChevronUp className="w-4 h-4 text-slate-400" /> : <ChevronDown className="w-4 h-4 text-slate-400" />}
        </button>
        {classicOpen && (
          <div className="p-4">
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
          </div>
        )}
      </Card>

      {/* EC.2 — Diff modal slot. Renders only when a source switch is
          pending; the slot is owned by FieldSourceProvider and only
          one modal can be open across the entire cockpit at a time. */}
      <SourceDiffModal />
    </div>
    </FieldSourceProvider>
  )
}

// ── Placeholder card (remaining EC.13 fillers) ─────────────────────────
function PlaceholderCard({
  icon,
  title,
  phase,
  value,
}: {
  icon: React.ReactNode
  title: string
  phase: string
  value: string
}) {
  return (
    <div className="rounded-lg border border-dashed border-slate-300 dark:border-slate-700 bg-white/60 dark:bg-slate-900/40 p-3.5">
      <div className="flex items-center justify-between mb-1.5">
        <div className="inline-flex items-center gap-2 text-sm font-semibold text-slate-800 dark:text-slate-200">
          <span className="text-slate-400">{icon}</span>
          {title}
        </div>
        <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400">
          {phase}
        </span>
      </div>
      <div className="text-xs text-slate-600 dark:text-slate-400">{value}</div>
      <div className="mt-1.5 text-[10.5px] text-slate-400 italic">
        Edit via the Existing fields panel below until this card lands.
      </div>
    </div>
  )
}

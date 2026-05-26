'use client'

// AC.1 — AmazonCockpit shell.
//
// 3-zone layout for the new Amazon listing surface:
//   • Header strip: market chip, listing status, ASIN, fulfillment
//     channel pill, "back to classic" link, and placeholder action
//     buttons (Pull / AI / Publish — wired in AC.11 + AC.12).
//   • Preview / health band (collapsible): placeholder for the AC.2
//     live PDP preview + a placeholder for the AC.4 health score.
//   • Cards section: stubs for Identifiers, Category & Browse Node,
//     Variations Matrix, Images, A+ Content, Pricing & Offers, FBA/
//     FBM, Suppression & Quality, Compliance. Each card fills in
//     across AC.4–AC.10.
//
// During AC.1 we ALSO render the existing ChannelListingTab below
// the cards as a transitional pass-through so no Amazon functionality
// is lost while the cockpit cards land. The pass-through goes away
// phase-by-phase as each card supersedes the corresponding section.
//
// Hard constraint: /products/amazon-flat-file is OFF-LIMITS. The
// cockpit reads the same template manifest and the same Listing
// records, but the flat-file grid is never modified.

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ArrowDownToLine,
  Sparkles,
  Send,
  ExternalLink,
  Settings2,
  Package,
  ShieldCheck,
  Truck,
  ListTree,
} from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { cn } from '@/lib/utils'
import { useTranslations } from '@/lib/i18n/use-translations'
import ChannelListingTab from '../ChannelListingTab'
import { useAmazonCompositor } from './useAmazonCompositor'
import { useAmazonCockpitMode } from './useAmazonCockpitMode'
import AmazonLivePreview from './AmazonLivePreview'
import MarketChipStrip from '../../_shared/market-switch/MarketChipStrip'
import {
  useMarketSwitch,
  isManifestWarm,
  markManifestWarm,
} from '../../_shared/market-switch/useMarketSwitch'
import type { MarketChip } from '../../_shared/market-switch/types'
import HealthPanel from './health/HealthPanel'
import { computeHealthScore, type JumpTarget } from './health/computeHealthScore'
import VariationMatrix from './variations/VariationMatrix'
import VariantCube from './variations/VariantCube'
import CategoryCard from './category/CategoryCard'
import AplusCard from './aplus/AplusCard'
import PricingCard from './pricing/PricingCard'
import SuppressionCard from './suppression/SuppressionCard'
import AutoFillCard from './autofill/AutoFillCard'
import PublishCard from './publish/PublishCard'
import { useCockpitShortcuts } from './useCockpitShortcuts'
import { LiveRegion } from '../../_shared/announce/useAnnounce'
import { postCockpitEvent } from '../../_shared/telemetry/cockpit-telemetry'
import { getBackendUrl } from '@/lib/backend-url'
import {
  COCKPIT_ROOT,
  CockpitHeader,
  CockpitPreviewBand,
  CockpitCardGrid,
  CockpitClassicPassthrough,
  CockpitDrawer,
  IdentifiersCard,
  ImagesSummaryCard,
  useCockpitFlag,
  FieldScopePopover,
  PropagationDiffModal,
  LinkSuggestionsBanner,
  useFieldLinks,
  type FieldScope,
  type ScopeMember,
  type PropagatePreview,
} from '../../_shared/cockpit-shell'

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
  platformAttributes?: Record<string, unknown> | null
  [key: string]: any
}

interface ChildProduct {
  id: string
  sku: string
  name?: string | null
  variantLabel?: string | null
  /** AC.6 — variation axis values. `variations` is the API-normalised
   *  flat map (categoryAttributes.variations); `variantAttributes`
   *  is the raw categoryAttributes for legacy payloads. The matrix
   *  reads either. */
  variations?: Record<string, string> | null
  variantAttributes?: Record<string, unknown> | null
  basePrice?: number | string | null
  totalStock?: number | null
  lowStockThreshold?: number | null
  status?: string | null
  images?: Array<{ url: string; type?: string; sortOrder?: number; isPrimary?: boolean }>
}

interface Props {
  product: any
  marketplace: string
  marketInfo: MarketInfo
  siblingMarkets?: MarketInfo[]
  /** Listings on OTHER Amazon marketplaces — feeds the Compare-
   *  markets view (later phase) and the AC.11 multi-market auto-
   *  fill. Also used by AC.3 to compute the status dot per chip. */
  siblingListings?: Listing[]
  listing: Listing | undefined
  onDirtyChange: (count: number) => void
  onSave: (updated: Listing) => void
  onRegister?: (handlers: {
    flush: () => Promise<void>
    discard: () => void
  }) => void
  childrenList?: ChildProduct[]
  /** AC.3 — Switch to another marketplace. Parent owns the actual
   *  state update (setMarketSelection) and remount; the cockpit
   *  handles the dirty-flush prompt and URL sync. */
  onMarketSwitch?: (code: string) => void
  /** AC.3 — Returns unsaved field count for the given market, so
   *  the chip strip can render a per-market dirty badge. */
  getDirtyForMarket?: (code: string) => number
  /** AC.3 — Triggered on dirty-prompt "Save & switch". Defaults to
   *  the same handler the editor registered via onRegister. */
  flushActiveMarket?: () => Promise<void>
  /** AC.3 — Triggered on dirty-prompt "Discard & switch". */
  discardActiveMarket?: () => void
}

const STATUS_TONE: Record<string, { bg: string; text: string }> = {
  ACTIVE:     { bg: 'bg-emerald-100 dark:bg-emerald-950/50', text: 'text-emerald-700 dark:text-emerald-300' },
  DRAFT:      { bg: 'bg-amber-100 dark:bg-amber-950/50',     text: 'text-amber-700 dark:text-amber-300'     },
  INACTIVE:   { bg: 'bg-slate-100 dark:bg-slate-800',        text: 'text-slate-600 dark:text-slate-400'     },
  SUPPRESSED: { bg: 'bg-rose-100 dark:bg-rose-950/50',       text: 'text-rose-700 dark:text-rose-300'       },
  ERROR:      { bg: 'bg-rose-100 dark:bg-rose-950/50',       text: 'text-rose-700 dark:text-rose-300'       },
}

export default function AmazonCockpit(props: Props) {
  const {
    product,
    marketplace,
    marketInfo,
    siblingMarkets,
    siblingListings = [],
    listing,
    childrenList,
    onMarketSwitch,
    getDirtyForMarket,
    flushActiveMarket,
    discardActiveMarket,
  } = props
  const [, setMode] = useAmazonCockpitMode()
  const { t } = useTranslations()
  const [previewOpen, setPreviewOpen] = useState(true)
  const [classicOpen, setClassicOpen] = useState(true)
  // AF.4/5 — "All fields" drawer. The full classic editor moves into a
  // slide-over (decluttered cockpit, one editor surface). Flag-guarded:
  // when off, fall back to the legacy stacked classic. keepMounted keeps
  // the editor's dirty/save lifecycle identical to today.
  const useDrawer = useCockpitFlag('all-fields-drawer', true)
  const [allFieldsOpen, setAllFieldsOpen] = useState(false)
  // FL.3 / FL.3b — per-field scope control, persisted via FieldLinkGroup.
  // Demonstrated on the Brand field; the chosen scope is stored and
  // reloaded across sessions (degrades to inert if the table is absent).
  const [brandScopeOpen, setBrandScopeOpen] = useState(false)
  const fieldLinks = useFieldLinks(product.id)
  // FL.4 — propagation diff modal state for the Brand demo.
  const [propagateOpen, setPropagateOpen] = useState(false)
  const [propagateData, setPropagateData] = useState<PropagatePreview | null>(null)
  const [propagateBusy, setPropagateBusy] = useState(false)

  const composed = useAmazonCompositor({
    product,
    listing,
    marketInfo,
    children: childrenList?.map((c) => ({ id: c.id })) ?? [],
  })

  const tone =
    STATUS_TONE[composed.status.listingStatus] ?? STATUS_TONE.DRAFT

  // AC.3 — Build the chip array from marketInfo + siblingMarkets, in
  // a stable order (current first, then siblings in their original
  // marketplace seed order). Per-market status comes from the
  // listings the parent already fetched; dirty counts come from the
  // parent's registry via getDirtyForMarket.
  const chips = useMemo<MarketChip[]>(() => {
    const ordered: MarketInfo[] = [
      marketInfo,
      ...(siblingMarkets ?? []),
    ].filter(
      (m, i, arr) => arr.findIndex((x) => x.code === m.code) === i,
    )
    return ordered.map((m) => {
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
  }, [marketInfo, siblingMarkets, listing, siblingListings, getDirtyForMarket])

  // AC.3 — Hover-warm. Primes the schema template cache for the
  // hovered (marketplace, productType) tuple so a subsequent click
  // paints instantly. Uses the SAME endpoint the flat-file editor
  // uses (5-min TtlCache on the API). No state in the cockpit —
  // we just fire-and-forget the GET; the SWR-style cache lives
  // server-side. Module-level isManifestWarm guard avoids re-firing
  // within the 5-min window.
  const productType =
    (product?.productType as string | null | undefined) ?? null
  const handleHoverWarm = useCallback(
    (code: string) => {
      if (!productType) return
      const cacheKey = `amazon:${code}:${productType}`
      if (isManifestWarm(cacheKey)) return
      markManifestWarm(cacheKey)
      const url = `${getBackendUrl()}/api/amazon/flat-file/template?marketplace=${encodeURIComponent(code)}&productType=${encodeURIComponent(productType)}`
      // No await; pre-warm only.
      fetch(url, { credentials: 'include' }).catch(() => {
        // Swallow — pre-warm failures shouldn't ever surface.
      })
    },
    [productType],
  )

  // AC.3 — Switch hook. Calls back to parent's onMarketSwitch after
  // resolving the dirty prompt. URL ?market= sync is owned here.
  const activeDirty = getDirtyForMarket?.(marketInfo.code) ?? 0
  const { switchTo } = useMarketSwitch({
    channel: 'AMAZON',
    active: marketInfo.code,
    markets: chips,
    onSwitch: (code) => onMarketSwitch?.(code),
    flush: flushActiveMarket,
    discard: discardActiveMarket,
    isDirty: activeDirty,
    syncUrl: true,
  })

  // AC.13 — cockpit-scoped keyboard shortcuts (Cmd+Shift+P, 1..9).
  // Editor-level Cmd+S / Esc come from useEditorShortcuts at the
  // ProductEditClient level, so we don't duplicate them here.
  useCockpitShortcuts({
    enabled: true,
    onJumpTo: (target) => handleJumpTo(target),
  })

  // AC.14 — one mount-time event per cockpit instance. Drives the
  // toggle-rate denominator in /api/cockpit/events/stats.
  useEffect(() => {
    postCockpitEvent({
      type: 'cockpit_mounted',
      productId: product.id,
      marketplace: marketInfo.code,
      payload: { language: marketInfo.language },
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // AC.4 — Pre-publish health report. Recomputed every render — the
  // function is pure and cheap (~15 checks). AC.5 swaps to a memo
  // once the manifest cross-tab pipe lands and the dependency set
  // changes shape.
  const report = useMemo(() => computeHealthScore(composed), [composed])

  // AC.4 — Jump-to-card. Each card carries data-jump-target=<id>; the
  // health panel rows wire their target through to here. When a card
  // doesn't exist yet (AC.5–AC.10 cards are stubs) we fall through to
  // the transitional pass-through and expand it so the operator can
  // still reach the underlying field.
  const handleJumpTo = useCallback(
    (target: JumpTarget) => {
      const el = document.querySelector<HTMLElement>(
        `[data-jump-target="${target}"]`,
      )
      if (el && target !== 'classic') {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' })
        // Subtle highlight so the operator's eye lands on the card.
        const prevOutline = el.style.boxShadow
        el.style.boxShadow = '0 0 0 2px rgba(59, 130, 246, 0.6)'
        el.style.transition = 'box-shadow 0.3s'
        window.setTimeout(() => {
          el.style.boxShadow = prevOutline
        }, 1400)
        return
      }
      // Fallback to the classic editor. AF.4/5 — when the drawer is on,
      // "fix in classic" opens the All-fields drawer instead of scrolling
      // to the (now removed) stacked pass-through.
      if (useDrawer) {
        setAllFieldsOpen(true)
        return
      }
      setClassicOpen(true)
      window.setTimeout(() => {
        const classicEl = document.querySelector<HTMLElement>(
          '[data-jump-target="classic"]',
        )
        classicEl?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }, 60)
    },
    [useDrawer],
  )

  // FL.3 — Amazon-market members offered in the scope popover.
  const scopeMembers: ScopeMember[] = chips.map((c) => ({
    key: `AMAZON:${c.code}`,
    channel: 'AMAZON',
    marketplace: c.code,
    label: `Amazon ${c.code}`,
  }))
  const brandScope: FieldScope = fieldLinks.scopeFor('brand')

  // AF.4/5 — single classic-editor element, hosted by EITHER the
  // All-fields drawer (flag on) or the legacy stacked pass-through
  // (flag off). One instance only, so dirty/save/onRegister are intact.
  const classicEditor = (
    <ChannelListingTab
      product={product}
      channel="AMAZON"
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
    // min-w-0 lets the cockpit shrink inside its grid parent (the
    // ProductEditClient gives the channel-tab branch a single-column
    // grid in cockpit mode). Without min-w-0 a wide descendant
    // (live preview, variation matrix table, classic pass-through)
    // can push the column wider than the viewport.
    <div className={COCKPIT_ROOT}>
      {/* AC.13 — Cockpit-wide ARIA live region. Mounted once near
          the top; any nested component can announce() via the
          module-scope util in _shared/announce/useAnnounce. */}
      <LiveRegion />

      {/* ── Zone 1: Header strip (UC.3 — shared CockpitHeader) ────── */}
      <CockpitHeader
        ariaLabel="Amazon Listing Cockpit header"
        chipStrip={
          // AC.3 — Market chip strip. Sits above the title row so
          // operators can flick between markets without scrolling.
          // Alt+1..9 wired via useMarketSwitch; hover prefetch hits
          // the cached flat-file template endpoint.
          chips.length > 1 ? (
            <div className="px-4 py-2 border-b border-slate-100 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-900/40 flex items-center gap-3 flex-wrap">
              <span className="text-[10.5px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                {t('products.edit.cockpit.amazon.markets')}
              </span>
              <MarketChipStrip
                markets={chips}
                active={marketInfo.code}
                onSelect={(code) => void switchTo(code)}
                onHoverWarm={handleHoverWarm}
                shortcutsHint
                className="min-w-0 flex-1"
              />
              <span className="text-[10.5px] text-slate-400 hidden md:inline">
                {t('products.edit.cockpit.amazon.markets.hint')}
              </span>
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
                'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10.5px] font-medium',
                tone.bg,
                tone.text,
              )}
            >
              {composed.status.listingStatus}
            </span>
            {composed.fulfillmentChannel.value && (
              <span
                className={cn(
                  'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10.5px] font-medium',
                  composed.fulfillmentChannel.value === 'FBA'
                    ? 'bg-blue-100 text-blue-700 dark:bg-blue-950/50 dark:text-blue-300'
                    : 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
                )}
              >
                <Truck className="w-2.5 h-2.5" />
                {composed.fulfillmentChannel.value}
              </span>
            )}
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
            {composed.asin.value ? (
              <span className="font-mono text-xs">ASIN {composed.asin.value}</span>
            ) : (
              <span>No ASIN — listing not yet published on this marketplace</span>
            )}
            <span>·</span>
            <span className="font-mono text-xs">SKU {composed.sku}</span>
            <span>·</span>
            <span>{marketInfo.currency}</span>
            <span>·</span>
            <span className="uppercase tracking-wide">{marketInfo.language}</span>
          </>
        }
        actions={
          <>
            {/* AC.1 — placeholder action buttons. The real Pull / AI
                improve / Publish wiring lives in the classic pane below
                until AC.11–AC.12 land replacements. */}
            <Button
              variant="secondary"
              size="sm"
              icon={<ArrowDownToLine className="w-3.5 h-3.5" />}
              disabled
              title="Coming in AC.11 — until then use the classic Pull below"
            >
              {t('products.edit.cockpit.amazon.actionPull')}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              icon={<Sparkles className="w-3.5 h-3.5" />}
              disabled
              title="Coming in AC.11 — until then use the classic AI Translate below"
            >
              {t('products.edit.cockpit.amazon.actionAiImprove')}
            </Button>
            <Button
              size="sm"
              icon={<Send className="w-3.5 h-3.5" />}
              onClick={() => handleJumpTo('publish')}
              title="Pick markets + submit via JSON_LISTINGS_FEED"
            >
              {t('products.edit.cockpit.amazon.actionPublish')}
            </Button>
            {useDrawer && (
              <button
                type="button"
                onClick={() => setAllFieldsOpen(true)}
                className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800"
                title={t('products.edit.cockpit.amazon.allFieldsTitle')}
              >
                <ListTree className="w-3 h-3" /> {t('products.edit.cockpit.amazon.allFields')}
              </button>
            )}
            {/* SY.1 — outbound handoff to the bulk flat-file editor,
                pre-filtered to this product family (new tab). */}
            <a
              href={`/products/amazon-flat-file?marketplace=${encodeURIComponent(marketInfo.code)}${productType ? `&productType=${encodeURIComponent(productType)}` : ''}&familyId=${encodeURIComponent(product.id)}`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800"
              title={t('products.edit.cockpit.amazon.editInBulkTitle')}
            >
              {t('products.edit.cockpit.amazon.editInBulk')} <ExternalLink className="w-3 h-3" />
            </a>
            <button
              type="button"
              onClick={() => {
                postCockpitEvent({
                  type: 'classic_toggled',
                  productId: product.id,
                  marketplace: marketInfo.code,
                })
                setMode('classic')
              }}
              className="ml-1 inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-900 dark:hover:text-slate-200 underline-offset-2 hover:underline"
              title={t('products.edit.cockpit.amazon.classicViewTitle')}
            >
              <Settings2 className="w-3 h-3" />{' '}
              {t('products.edit.cockpit.amazon.classicView')}
            </button>
          </>
        }
      />

      {/* FL.6.2 — smart link suggestions (identical values across markets). */}
      <LinkSuggestionsBanner
        suggestions={fieldLinks.suggestions}
        onLink={(s) => void fieldLinks.linkSuggestion(s)}
        onDismiss={fieldLinks.dismissSuggestion}
      />

      {/* ── Zone 2: Preview + Health band (UC.3 — shared band) ────── */}
      <CockpitPreviewBand
        open={previewOpen}
        onToggle={() => setPreviewOpen((o) => !o)}
        title={t('products.edit.cockpit.amazon.preview.title')}
        subtitle={t('products.edit.cockpit.amazon.preview.subtitle', {
          market: marketInfo.code,
        })}
        healthWidth="320px"
        contentClassName="bg-slate-50/40 dark:bg-slate-900/30"
        preview={<AmazonLivePreview composed={composed} />}
        health={<HealthPanel report={report} onJumpTo={handleJumpTo} />}
      />

      {/* ── AC.12 — Publish flow (full-width, top of cards zone) ──── */}
      <PublishCard
        productId={product.id}
        activeMarketplace={marketInfo.code}
        activeHealth={report}
        markets={chips}
      />

      {/* ── AC.11 — Smart auto-fill bar (full-width, top of cards zone) ── */}
      <AutoFillCard
        productId={product.id}
        productName={product.name ?? null}
        productDescription={product.description ?? null}
        productBrand={product.brand ?? null}
        productKeywords={
          Array.isArray(product.keywords) ? (product.keywords as string[]) : null
        }
        marketplace={marketInfo.code}
        language={marketInfo.language}
        currentTitle={composed.title.value}
        currentDescription={composed.description.value}
        currentBullets={composed.bullets.value}
        siblingListings={siblingListings.map((l) => ({
          marketplace: l.marketplace,
          title: l.title,
          description: l.description,
          bulletPointsOverride: l.bulletPointsOverride,
        }))}
        onJumpToClassic={() => handleJumpTo('classic')}
      />

      {/* ── UC.6 — Variant Cube (wraps the AC.6 axis grid + pivots) ── */}
      {childrenList && childrenList.length > 0 && (
        <VariantCube
          productId={product.id}
          channel="AMAZON"
          activeMarket={marketInfo.code}
          activeCurrency={marketInfo.currency}
          axisGrid={
            <VariationMatrix
              productId={product.id}
              children={childrenList}
              channelListings={[
                ...(listing ? [listing] : []),
                ...siblingListings,
              ]}
              activeMarketplace={marketInfo.code}
              activeCurrency={marketInfo.currency}
              siblingMarkets={(siblingMarkets ?? []).map((m) => ({
                code: m.code,
                name: m.name,
                currency: m.currency,
              }))}
              variationTheme={composed.variationTheme.value}
              onJumpToClassic={() => handleJumpTo('classic')}
            />
          }
        />
      )}

      {/* ── Zone 3: Cards (UC.3 — shared CockpitCardGrid) ─────────── */}
      <CockpitCardGrid layout="grid">
        {/* UC.2/UC.3 — Identifiers now uses the shared IdentifiersCard
            (replaces the dashed placeholder). */}
        <IdentifiersCard
          title={t('products.edit.cockpit.amazon.cards.identifiers')}
          rows={[
            { label: 'SKU', value: composed.sku, mono: true, source: 'locked' },
            {
              label: 'ASIN',
              value: composed.asin.value,
              mono: true,
              source: composed.asin.source,
            },
            {
              label: 'GTIN',
              value: composed.gtin.value,
              mono: true,
              source: 'locked',
            },
            {
              label: 'Brand',
              value: composed.brand.value,
              source: brandScope === 'linked' ? 'linked' : composed.brand.source,
              onSourceClick: () => setBrandScopeOpen(true),
            },
          ]}
        />
        <CategoryCard
          productId={product.id}
          productType={composed.productType.value}
          browseNodeId={composed.browseNodeId.value}
          categoryPath={
            (listing?.platformAttributes as Record<string, unknown> | null | undefined)
              ?.detectedCategoryPath as string | null | undefined
          }
          marketplace={marketInfo.code}
          listingId={listing?.id ?? null}
          onSaved={() =>
            // Parent's onSave currently does router.refresh() and
            // ignores the payload; pass the listing if we have it,
            // otherwise an empty stub so the call type-checks.
            props.onSave(listing ?? ({} as Listing))
          }
          onJumpToClassic={() => handleJumpTo('classic')}
        />
        {/* UC.2/UC.3 — Images now uses the shared ImagesSummaryCard
            (read-only summary; the AC.5 deep editor handoff is added
            when that card lands). */}
        <ImagesSummaryCard
          title="Images"
          primaryImageUrl={composed.primaryImageUrl.value}
          galleryCount={composed.galleryUrls.value.length}
          totalSlots={9}
        />
        <AplusCard
          asin={composed.asin.value}
          brand={composed.brand.value}
          marketplace={marketInfo.code}
          onJumpToClassic={() => handleJumpTo('classic')}
        />
        <PricingCard
          productId={product.id}
          marketplace={marketInfo.code}
          currency={composed.currency}
          price={composed.price.value}
          salePrice={
            listing?.salePrice != null
              ? typeof listing.salePrice === 'string'
                ? parseFloat(listing.salePrice)
                : Number(listing.salePrice)
              : null
          }
          quantity={composed.quantity.value}
          lastSyncedAt={
            (listing?.lastSyncedAt as string | null | undefined) ?? null
          }
          listingId={listing?.id ?? null}
          onSaved={() => props.onSave(listing ?? ({} as Listing))}
          snsEnabled={
            (
              (
                listing?.platformAttributes as Record<string, unknown> | null | undefined
              )?.subscribeAndSave as Record<string, unknown> | null | undefined
            )?.enabled === true
          }
          snsDiscountPercent={(() => {
            const v = (
              (
                listing?.platformAttributes as Record<string, unknown> | null | undefined
              )?.subscribeAndSave as Record<string, unknown> | null | undefined
            )?.discountPercent
            return typeof v === 'number' ? v : null
          })()}
          businessQty={(() => {
            const v = (
              (
                listing?.platformAttributes as Record<string, unknown> | null | undefined
              )?.businessPricing as Record<string, unknown> | null | undefined
            )?.quantity
            return typeof v === 'number' ? v : null
          })()}
          businessPrice={(() => {
            const v = (
              (
                listing?.platformAttributes as Record<string, unknown> | null | undefined
              )?.businessPricing as Record<string, unknown> | null | undefined
            )?.price
            return typeof v === 'number' ? v : null
          })()}
          onJumpToClassic={() => handleJumpTo('classic')}
        />
        <PlaceholderCard
          targetId="fulfillment"
          icon={<Truck className="w-4 h-4" />}
          title={t('products.edit.cockpit.amazon.cards.fulfillment')}
          phase="AC.9"
          value={
            composed.fulfillmentChannel.value
              ? `${composed.fulfillmentChannel.value} · ${composed.conditionType.value}`
              : 'Pick FBA or FBM'
          }
        />
        <SuppressionCard
          productId={product.id}
          marketplace={marketInfo.code}
          asin={composed.asin.value}
          healthReport={report}
          onJumpTo={handleJumpTo}
        />
        <PlaceholderCard
          targetId="compliance"
          icon={<ShieldCheck className="w-4 h-4" />}
          title={t('products.edit.cockpit.amazon.cards.compliance')}
          phase="AC.4"
          value="GPSR · Hazmat · Battery · Country of origin — checks land in AC.4"
        />
        <PlaceholderCard
          icon={<Package className="w-4 h-4" />}
          title={t('products.edit.cockpit.amazon.cards.compatibility')}
          phase="AC.13"
          value="Xavia motorcycle gear — model/year fit list editor"
        />
      </CockpitCardGrid>

      {/* ── Zone 4 — classic editor (AF.4/5) ─────────────────────────
          Full classic editor in a slide-over when the All-fields drawer
          flag is on (decluttered cockpit); legacy stacked pass-through
          otherwise. Single instance either way. */}
      {useDrawer ? (
        <CockpitDrawer
          keepMounted
          open={allFieldsOpen}
          onClose={() => setAllFieldsOpen(false)}
          width="full"
          title={t('products.edit.cockpit.amazon.allFieldsTitle')}
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
                {t('products.edit.cockpit.amazon.classic.title')}
              </span>
              <Badge variant="info">
                {t('products.edit.cockpit.amazon.classic.transitional')}
              </Badge>
              <span className="text-xs text-slate-500 dark:text-slate-400">
                {t('products.edit.cockpit.amazon.classic.subtitle')}
              </span>
            </>
          }
        >
          {classicEditor}
        </CockpitClassicPassthrough>
      )}

      {/* FL.3 (UI) — per-field scope control. Session-local until FL.3b
          wires persistence to FieldLinkGroup. */}
      <FieldScopePopover
        open={brandScopeOpen}
        onClose={() => setBrandScopeOpen(false)}
        fieldLabel="Brand"
        marketLabel={`Amazon ${marketInfo.code}`}
        scope={brandScope}
        selectedMembers={fieldLinks.memberKeysFor('brand')}
        members={scopeMembers}
        canTranslate={false}
        onApply={(r) =>
          void fieldLinks.setScope('brand', r, { sourceLanguage: marketInfo.language })
        }
        onPropagate={() => {
          setBrandScopeOpen(false)
          void (async () => {
            const preview = await fieldLinks.propagatePreview('brand', composed.brand.value ?? '', {
              channel: 'AMAZON',
              marketplace: marketInfo.code,
              language: marketInfo.language,
            })
            setPropagateData(preview)
            setPropagateOpen(true)
          })()
        }}
      />

      {/* FL.4 — propagation diff (never silent: operator confirms members). */}
      <PropagationDiffModal
        open={propagateOpen}
        onClose={() => {
          if (!propagateBusy) setPropagateOpen(false)
        }}
        fieldLabel="Brand"
        entries={propagateData?.entries ?? []}
        translatable={propagateData?.translatable ?? false}
        aiBudgetExceeded={propagateData?.aiBudgetExceeded}
        busy={propagateBusy}
        onApply={(selected) => {
          void (async () => {
            setPropagateBusy(true)
            await fieldLinks.applyPropagation('brand', selected)
            setPropagateBusy(false)
            setPropagateOpen(false)
          })()
        }}
      />
    </div>
  )
}

// ── Placeholder card (AC.4–AC.10 fillers) ──────────────────────────────
function PlaceholderCard({
  icon,
  title,
  phase,
  value,
  targetId,
}: {
  icon: React.ReactNode
  title: string
  phase: string
  value: string
  /** AC.4 — jump-target id. The health panel's onJumpTo handler
   *  scrolls the cockpit to the card with this attribute. Omit for
   *  cards that don't yet have a corresponding health-check row. */
  targetId?: string
}) {
  return (
    <div
      data-jump-target={targetId}
      className="rounded-lg border border-dashed border-slate-300 dark:border-slate-700 bg-white/60 dark:bg-slate-900/40 p-3.5"
    >
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
        Edit via the Existing Amazon fields panel below until this card lands.
      </div>
    </div>
  )
}

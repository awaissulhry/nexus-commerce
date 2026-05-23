/**
 * ATM.1 — Cross-channel attribute hub.
 *
 * This is the new central source-of-truth view for a SKU's data
 * across every channel and market it lives on. The DS.1-9 printable
 * spec sheet lives at /products/[id]/datasheet/print/ — accessible
 * via the Print button in this hub's header.
 *
 * Phase 1 ships only the shell: header + tab navigation + stubs for
 * each tab. Subsequent ATM phases fill in:
 *
 *   ATM.2  — Header health pulse (markets active, sync status, drift)
 *   ATM.3  — Master attribute matrix
 *   ATM.4  — Per-channel × per-market value expansion
 *   ATM.5  — Channel readiness scorecard
 *   ATM.6  — Validation engine
 *   ATM.7  — Drift & conflict resolver
 *   ATM.8  — Pricing × market grid
 *   ATM.9  — Translations × language matrix
 *   ATM.10 — Compliance × market grid
 *   ATM.11 — Images × channel × variant matrix
 *   ATM.12 — Audit timeline
 *   ATM.13 — Bulk + saved views
 *   ATM.14 — Output modes (already covers DS print + line sheet)
 *   ATM.15 — Real-time + perf + a11y polish
 *
 * URL shape: /products/[id]/datasheet?tab=overview (default).
 * The querystring tab avoids creating eight separate sub-routes for
 * what is conceptually one page with views.
 */

import { prisma } from '@nexus/database'
import { notFound } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, FileText } from 'lucide-react'
import { getServerLocale, getServerT } from '@/lib/i18n/server'
import HeaderHealthPulse from './HeaderHealthPulse'
import AttributesTab from './AttributesTab'
import VariantsTab from './VariantsTab'
import ChannelsTab from './ChannelsTab'
import OverviewTab from './OverviewTab'
import PricingTab from './PricingTab'
import TranslationsTab from './TranslationsTab'
import CompliancePerMarketTab from './CompliancePerMarketTab'

export const dynamic = 'force-dynamic'

type Tab =
  | 'overview'
  | 'attributes'
  | 'variants'
  | 'channels'
  | 'pricing'
  | 'translations'
  | 'compliance'
  | 'images'
  | 'history'

// VR.1 — "variants" tab inserts between attributes and channels for
// parent SKUs only. The TABS array drives both the nav and the
// querystring validator; building it from product.isParent at render
// time keeps the nav in sync with the actual SKU shape.
function buildTabs(isParent: boolean): Tab[] {
  return [
    'overview',
    'attributes',
    ...(isParent ? (['variants'] as const) : []),
    'channels',
    'pricing',
    'translations',
    'compliance',
    'images',
    'history',
  ]
}

function parseTab(
  v: string | string[] | undefined,
  validTabs: readonly Tab[],
): Tab {
  if (typeof v !== 'string') return 'overview'
  return (validTabs as readonly string[]).includes(v) ? (v as Tab) : 'overview'
}

interface PageProps {
  params: Promise<{ id: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

export default async function ProductDatasheetHubPage({
  params,
  searchParams,
}: PageProps) {
  const { id } = await params
  const sp = await searchParams
  const locale = await getServerLocale()
  const t = await getServerT()

  // Minimal product fetch — just what the header needs. Each tab's
  // page in subsequent ATM phases will fetch its own data.
  const product = await prisma.product.findUnique({
    where: { id },
    select: {
      id: true,
      sku: true,
      name: true,
      brand: true,
      status: true,
      isParent: true,
      updatedAt: true,
    },
  })

  if (!product) notFound()

  // VR.1 — Tabs depend on isParent (variants tab only for parents).
  // Parse tab AFTER the fetch so the validator knows whether
  // ?tab=variants is allowed for this SKU.
  const tabs = buildTabs(product.isParent)
  const tab = parseTab(sp.tab, tabs)

  // VR.2 — Variants layout: 'matrix' (default) or 'flat'. Falls
  // back to 'matrix' silently for anything unrecognized; the tab
  // re-resolves to flat when no axes are detected.
  const layoutParam =
    typeof sp.layout === 'string' && sp.layout === 'flat' ? 'flat' : 'matrix'

  return (
    <div className="space-y-4">
      {/* ── Header ─────────────────────────────────────────────────── */}
      <header className="flex items-start justify-between gap-4 border-b border-slate-200 dark:border-slate-800 pb-3">
        <div className="min-w-0 flex-1">
          <Link
            href={`/products/${product.id}/edit`}
            className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 mb-1"
          >
            <ArrowLeft className="w-3 h-3" />
            {t('products.datasheetHub.backToProduct')}
          </Link>
          <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100 truncate">
            {product.name}
          </h1>
          <div className="text-sm font-mono text-slate-600 dark:text-slate-400 mt-0.5 flex items-center gap-2 flex-wrap">
            <span>{product.sku}</span>
            {product.brand && (
              <>
                <span className="text-slate-300">·</span>
                <span>{product.brand}</span>
              </>
            )}
            {product.status !== 'ACTIVE' && (
              <span className="inline-block px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wider bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-300 font-semibold">
                {product.status}
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <Link
            href={`/products/${product.id}/datasheet/print`}
            className="inline-flex items-center gap-1.5 h-8 px-3 text-md text-slate-700 border border-slate-300 rounded-md hover:bg-slate-100 dark:text-slate-200 dark:border-slate-700 dark:hover:bg-slate-800"
          >
            <FileText className="w-4 h-4" />
            {t('products.datasheetHub.print')}
          </Link>
        </div>
      </header>

      {/* ── ATM.2 — Header health pulse ────────────────────────────── */}
      <HeaderHealthPulse
        productId={product.id}
        productUpdatedAt={product.updatedAt}
        locale={locale}
        t={t}
      />

      {/* ── Tab nav ────────────────────────────────────────────────── */}
      <nav
        className="flex items-center gap-1 border-b border-slate-200 dark:border-slate-800 overflow-x-auto"
        aria-label={t('products.datasheetHub.tabsAria')}
      >
        {tabs.map((tabKey) => {
          const active = tabKey === tab
          return (
            <Link
              key={tabKey}
              href={`/products/${product.id}/datasheet?tab=${tabKey}`}
              scroll={false}
              aria-current={active ? 'page' : undefined}
              className={
                'inline-flex items-center h-9 px-3 text-md font-medium whitespace-nowrap border-b-2 -mb-px transition-colors ' +
                (active
                  ? 'border-blue-600 text-slate-900 dark:border-blue-400 dark:text-slate-100'
                  : 'border-transparent text-slate-500 hover:text-slate-700 hover:border-slate-300 dark:text-slate-400 dark:hover:text-slate-200')
              }
            >
              {t(`products.datasheetHub.tab.${tabKey}`)}
            </Link>
          )
        })}
      </nav>

      {/* ── Tab content (stubs gradually replaced by ATM.3+) ──────── */}
      <section
        role="tabpanel"
        aria-labelledby={`tab-${tab}`}
        className="min-h-[40vh]"
      >
        {tab === 'overview' ? (
          <OverviewTab productId={product.id} locale={locale} t={t} />
        ) : tab === 'attributes' ? (
          <AttributesTab productId={product.id} locale={locale} t={t} />
        ) : tab === 'variants' && product.isParent ? (
          <VariantsTab
            parentId={product.id}
            layout={layoutParam}
            locale={locale}
            t={t}
          />
        ) : tab === 'channels' ? (
          <ChannelsTab productId={product.id} locale={locale} t={t} />
        ) : tab === 'pricing' ? (
          <PricingTab productId={product.id} locale={locale} t={t} />
        ) : tab === 'translations' ? (
          <TranslationsTab productId={product.id} locale={locale} t={t} />
        ) : tab === 'compliance' ? (
          <CompliancePerMarketTab
            productId={product.id}
            locale={locale}
            t={t}
          />
        ) : (
          <TabStub tab={tab} t={t} />
        )}
      </section>
    </div>
  )
}

function TabStub({
  tab,
  t,
}: {
  tab: Tab
  t: (key: string, vars?: Record<string, string | number>) => string
}) {
  // Maps each tab to the ATM phase that will own it. Operators
  // landing here today see a clear "coming next" rather than a
  // blank page; the planned-phase code makes the rollout legible.
  const phase: Record<Tab, string> = {
    overview: 'ATM.2',
    attributes: 'ATM.3 / ATM.4',
    variants: 'VR.1',
    channels: 'ATM.5 / ATM.6',
    pricing: 'ATM.8',
    translations: 'ATM.9',
    compliance: 'ATM.10',
    images: 'ATM.11',
    history: 'ATM.12',
  }
  return (
    <div className="border border-dashed border-slate-300 dark:border-slate-700 rounded p-8 text-center">
      <div className="text-sm text-slate-700 dark:text-slate-200 font-medium">
        {t(`products.datasheetHub.tab.${tab}`)}
      </div>
      <div className="text-xs text-slate-500 mt-2">
        {t('products.datasheetHub.stub.coming', { phase: phase[tab] })}
      </div>
    </div>
  )
}

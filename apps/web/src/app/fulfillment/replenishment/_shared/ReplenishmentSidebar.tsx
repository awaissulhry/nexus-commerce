'use client'

import { useEffect, useState } from 'react'
import {
  AlertTriangle,
  BarChart3,
  Bot,
  ChevronDown,
  ChevronRight,
  DollarSign,
  Flame,
  Package,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  TrendingDown,
  TrendingUp,
  X,
  Zap,
  type LucideIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { AutomationRulesCard } from './AutomationRulesCard'
import { ScenariosCard } from './ScenariosCard'
import { SlowMoversCard } from './SlowMoversCard'
import { PanEuDistributionCard } from './PanEuDistributionCard'
import { SupplierSpendCard } from './SupplierSpendCard'
import { ForecastBiasCard } from './ForecastBiasCard'
import { CannibalizationCard } from './CannibalizationCard'
import { StockoutImpactCard } from './StockoutImpactCard'
import { ForecastModelsCard } from './ForecastModelsCard'
import { CashFlowCard } from './CashFlowCard'
import { FbaRestockHealthCard } from './FbaRestockPanels'
import { ForecastHealthCard } from './ForecastDiagnosticsCards'
import { ContainerFillCard, type ContainerFillEntry } from './ContainerFillCard'
import { PipelineHealthStrip } from './PipelineHealthStrip'
import type { WidgetId } from './FloatingWidgetSystem'

/**
 * RX.UI — collapsible in-page panel sidebar for /fulfillment/replenishment,
 * modelled on the advertising sidebar's collapse mechanics. Replaces the
 * fiddly floating draggable widgets: a left rail groups every panel; click
 * to open one, and open panels STACK in a scrollable column below the
 * picker. Collapse shrinks it to an icon rail. Collapsed state + the open
 * set persist per device. Every panel card is self-contained and reused
 * verbatim.
 */

type PanelDef = { id: WidgetId; label: string; icon: LucideIcon }
type PanelGroup = { label: string; items: PanelDef[] }

const GROUPS: PanelGroup[] = [
  {
    label: 'Forecast',
    items: [
      { id: 'forecast-health', label: 'Forecast accuracy', icon: BarChart3 },
      { id: 'forecast-bias', label: 'Forecast bias', icon: Zap },
      { id: 'forecast-models', label: 'Forecast models A/B', icon: BarChart3 },
      { id: 'pipeline', label: 'Pipeline health', icon: RefreshCw },
    ],
  },
  {
    label: 'Planning',
    items: [
      { id: 'scenarios', label: 'What-if scenarios', icon: BarChart3 },
      { id: 'cashflow', label: 'Cash flow projection', icon: DollarSign },
      { id: 'container-fill', label: 'Container fill', icon: Package },
      { id: 'restock', label: 'Amazon Restock signal', icon: RefreshCw },
    ],
  },
  {
    label: 'Inventory',
    items: [
      { id: 'slow-movers', label: 'Slow movers', icon: TrendingDown },
      { id: 'pan-eu', label: 'Pan-EU distribution', icon: Package },
      { id: 'stockout', label: 'Stockout impact', icon: AlertTriangle },
    ],
  },
  {
    label: 'Suppliers',
    items: [
      { id: 'supplier-spend', label: 'Supplier spend', icon: TrendingUp },
      { id: 'automation', label: 'Automation rules', icon: Bot },
      { id: 'cannibalization', label: 'Cannibalization', icon: Flame },
    ],
  },
]

const ALL_PANELS: PanelDef[] = GROUPS.flatMap((g) => g.items)
const COLLAPSE_KEY = 'nexus-replenishment-sidebar-collapsed'
const OPEN_KEY = 'nexus-replenishment-sidebar-open'

function PanelBody({
  id,
  onRefreshPageData,
  containerFill,
}: {
  id: WidgetId
  onRefreshPageData?: () => void
  containerFill?: ContainerFillEntry[]
}) {
  switch (id) {
    case 'pipeline':
      return <PipelineHealthStrip onRefreshPageData={onRefreshPageData} />
    case 'automation':
      return <AutomationRulesCard />
    case 'scenarios':
      return <ScenariosCard />
    case 'stockout':
      return <StockoutImpactCard />
    case 'cashflow':
      return <CashFlowCard />
    case 'restock':
      return <FbaRestockHealthCard />
    case 'slow-movers':
      return <SlowMoversCard />
    case 'pan-eu':
      return <PanEuDistributionCard />
    case 'supplier-spend':
      return <SupplierSpendCard />
    case 'forecast-bias':
      return <ForecastBiasCard />
    case 'cannibalization':
      return <CannibalizationCard />
    case 'forecast-health':
      return <ForecastHealthCard />
    case 'forecast-models':
      return <ForecastModelsCard />
    case 'container-fill':
      return containerFill && containerFill.length > 0 ? (
        <ContainerFillCard entries={containerFill} />
      ) : (
        <div className="p-3 text-sm text-tertiary">No container fill data available.</div>
      )
    default:
      return null
  }
}

export function ReplenishmentSidebar({
  onRefreshPageData,
  containerFill,
}: {
  onRefreshPageData?: () => void
  containerFill?: ContainerFillEntry[]
}) {
  const [collapsed, setCollapsed] = useState(false)
  const [open, setOpen] = useState<WidgetId[]>([])
  const [hydrated, setHydrated] = useState(false)

  // Hydrate from localStorage after mount (SSR-safe).
  useEffect(() => {
    try {
      setCollapsed(window.localStorage.getItem(COLLAPSE_KEY) === '1')
      const raw = window.localStorage.getItem(OPEN_KEY)
      if (raw) {
        const ids = JSON.parse(raw) as string[]
        setOpen(ALL_PANELS.filter((p) => ids.includes(p.id)).map((p) => p.id))
      }
    } catch {
      /* defaults */
    }
    setHydrated(true)
  }, [])

  useEffect(() => {
    if (!hydrated) return
    try {
      window.localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0')
      window.localStorage.setItem(OPEN_KEY, JSON.stringify(open))
    } catch {
      /* ignore */
    }
  }, [collapsed, open, hydrated])

  const isOpen = (id: WidgetId) => open.includes(id)
  const toggle = (id: WidgetId) =>
    setOpen((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  const close = (id: WidgetId) => setOpen((prev) => prev.filter((x) => x !== id))

  const openDefs = ALL_PANELS.filter((p) => isOpen(p.id))

  return (
    <aside
      className={cn(
        'shrink-0 self-start sticky top-2 max-h-[calc(100vh-1rem)] overflow-y-auto',
        'rounded-md border border-default bg-white dark:border-slate-800 dark:bg-slate-900',
        'transition-[width] duration-200',
        collapsed ? 'w-12' : 'w-[22rem]',
      )}
      aria-label="Replenishment insights"
    >
      {/* Header / collapse toggle */}
      <div className="flex items-center justify-between border-b border-default px-2 py-2 dark:border-slate-800">
        {!collapsed && (
          <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">
            Insights
          </span>
        )}
        <button
          onClick={() => setCollapsed((v) => !v)}
          title={collapsed ? 'Expand panels' : 'Collapse panels'}
          className="rounded p-1 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
        >
          {collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
        </button>
      </div>

      {/* Collapsed: icon rail. Click opens the panel + expands. */}
      {collapsed ? (
        <div className="flex flex-col items-center gap-1 py-2">
          {ALL_PANELS.map((p) => {
            const Icon = p.icon
            return (
              <button
                key={p.id}
                title={p.label}
                onClick={() => {
                  if (!isOpen(p.id)) toggle(p.id)
                  setCollapsed(false)
                }}
                className={cn(
                  'rounded p-2 hover:bg-slate-100 dark:hover:bg-slate-800',
                  isOpen(p.id)
                    ? 'bg-blue-50 text-blue-600 dark:bg-blue-950 dark:text-blue-400'
                    : 'text-slate-500',
                )}
              >
                <Icon size={16} />
              </button>
            )
          })}
        </div>
      ) : (
        <>
          {/* Expanded: grouped picker */}
          <div className="space-y-2 border-b border-default p-2 dark:border-slate-800">
            {GROUPS.map((g) => (
              <PickerGroup
                key={g.label}
                group={g}
                isOpen={isOpen}
                onToggle={toggle}
              />
            ))}
            {open.length > 0 && (
              <button
                onClick={() => setOpen([])}
                className="w-full rounded px-2 py-1 text-left text-[11px] text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                Close all ({open.length})
              </button>
            )}
          </div>

          {/* Open panels, stacked */}
          <div className="space-y-2 p-2">
            {openDefs.length === 0 ? (
              <p className="px-1 py-4 text-center text-xs text-tertiary">
                Pick a panel above to pin it here.
              </p>
            ) : (
              openDefs.map((p) => {
                const Icon = p.icon
                return (
                  <section
                    key={p.id}
                    className="rounded-md border border-default bg-slate-50/60 dark:border-slate-800 dark:bg-slate-950/40"
                  >
                    <header className="flex items-center justify-between border-b border-default px-2 py-1.5 dark:border-slate-800">
                      <span className="flex items-center gap-1.5 text-xs font-medium text-slate-700 dark:text-slate-200">
                        <Icon size={13} /> {p.label}
                      </span>
                      <button
                        onClick={() => close(p.id)}
                        title="Close panel"
                        className="rounded p-0.5 text-tertiary hover:bg-slate-200 hover:text-slate-700 dark:hover:bg-slate-800"
                      >
                        <X size={13} />
                      </button>
                    </header>
                    <div className="p-1">
                      <PanelBody
                        id={p.id}
                        onRefreshPageData={onRefreshPageData}
                        containerFill={containerFill}
                      />
                    </div>
                  </section>
                )
              })
            )}
          </div>
        </>
      )}
    </aside>
  )
}

function PickerGroup({
  group,
  isOpen,
  onToggle,
}: {
  group: PanelGroup
  isOpen: (id: WidgetId) => boolean
  onToggle: (id: WidgetId) => void
}) {
  const [expanded, setExpanded] = useState(true)
  return (
    <div>
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-1 px-1 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-tertiary hover:text-slate-600 dark:hover:text-slate-300"
      >
        {expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        {group.label}
      </button>
      {expanded && (
        <div className="mt-0.5 space-y-0.5">
          {group.items.map((p) => {
            const Icon = p.icon
            const active = isOpen(p.id)
            return (
              <button
                key={p.id}
                onClick={() => onToggle(p.id)}
                className={cn(
                  'flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs',
                  active
                    ? 'bg-blue-600 text-white'
                    : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800',
                )}
              >
                <Icon size={13} className="shrink-0" />
                <span className="truncate">{p.label}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

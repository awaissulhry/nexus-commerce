'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AlertTriangle,
  BarChart3,
  Bot,
  DollarSign,
  Flame,
  GripVertical,
  LayoutGrid,
  Package,
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
import type { ContainerFillEntry } from './ContainerFillCard'
import { ContainerFillCard } from './ContainerFillCard'
import { PipelineHealthStrip } from './PipelineHealthStrip'

// ── Types ──────────────────────────────────────────────────────────────────

export type WidgetId =
  | 'pipeline'
  | 'automation'
  | 'scenarios'
  | 'stockout'
  | 'cashflow'
  | 'restock'
  | 'slow-movers'
  | 'pan-eu'
  | 'supplier-spend'
  | 'forecast-bias'
  | 'cannibalization'
  | 'forecast-health'
  | 'forecast-models'
  | 'container-fill'

type WidgetPos  = { x: number; y: number }
type WidgetState = { open: boolean; pos: WidgetPos; z: number }
type WidgetStore = Partial<Record<WidgetId, WidgetState>>

const STORAGE_KEY = 'nexus-replenishment-widgets'
const DEFAULT_W   = 500
const BASE_Z      = 200

let globalZ = BASE_Z

// ── Widget definitions ─────────────────────────────────────────────────────

type WidgetDef = {
  id: WidgetId
  label: string
  icon: LucideIcon
  defaultPos: WidgetPos
}

const WIDGET_DEFS: WidgetDef[] = [
  { id: 'pipeline',       label: 'Pipeline health',       icon: RefreshCw,     defaultPos: { x: 80,  y: 80  } },
  { id: 'automation',     label: 'Automation rules',      icon: Bot,           defaultPos: { x: 120, y: 120 } },
  { id: 'scenarios',      label: 'What-if scenarios',     icon: BarChart3,     defaultPos: { x: 160, y: 160 } },
  { id: 'stockout',       label: 'Stockout impact',       icon: AlertTriangle, defaultPos: { x: 200, y: 100 } },
  { id: 'cashflow',       label: 'Cash flow projection',  icon: DollarSign,    defaultPos: { x: 240, y: 140 } },
  { id: 'restock',        label: 'Amazon Restock signal', icon: RefreshCw,     defaultPos: { x: 280, y: 180 } },
  { id: 'slow-movers',    label: 'Slow movers',           icon: TrendingDown,  defaultPos: { x: 100, y: 200 } },
  { id: 'pan-eu',         label: 'Pan-EU distribution',   icon: Package,       defaultPos: { x: 140, y: 240 } },
  { id: 'supplier-spend', label: 'Supplier spend',        icon: TrendingUp,    defaultPos: { x: 180, y: 280 } },
  { id: 'forecast-bias',  label: 'Forecast bias',         icon: Zap,           defaultPos: { x: 220, y: 200 } },
  { id: 'cannibalization',label: 'Cannibalization',       icon: Flame,         defaultPos: { x: 260, y: 240 } },
  { id: 'forecast-health',label: 'Forecast accuracy',     icon: BarChart3,     defaultPos: { x: 300, y: 280 } },
  { id: 'forecast-models',label: 'Forecast models A/B',   icon: BarChart3,     defaultPos: { x: 340, y: 200 } },
  { id: 'container-fill', label: 'Container fill',        icon: Package,       defaultPos: { x: 380, y: 240 } },
]

// ── localStorage helpers ───────────────────────────────────────────────────

function loadStore(): WidgetStore {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    return raw ? (JSON.parse(raw) as WidgetStore) : {}
  } catch {
    return {}
  }
}

function saveStore(store: WidgetStore) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store))
  } catch { /* storage full — ignore */ }
}

// ── FloatingWidget ─────────────────────────────────────────────────────────

interface FloatingWidgetProps {
  label: string
  icon: LucideIcon
  pos: WidgetPos
  z: number
  onClose: () => void
  onFocus: () => void
  onMove: (pos: WidgetPos) => void
  children: React.ReactNode
}

function FloatingWidget({ label, icon: Icon, pos, z, onClose, onFocus, onMove, children }: FloatingWidgetProps) {
  const dragRef = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null)

  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    dragRef.current = { sx: e.clientX, sy: e.clientY, ox: pos.x, oy: pos.y }
    onFocus()
  }, [pos.x, pos.y, onFocus])

  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return
    onMove({
      x: Math.max(0, dragRef.current.ox + e.clientX - dragRef.current.sx),
      y: Math.max(0, dragRef.current.oy + e.clientY - dragRef.current.sy),
    })
  }, [onMove])

  const handlePointerUp = useCallback(() => {
    dragRef.current = null
  }, [])

  return (
    <div
      role="dialog"
      aria-label={label}
      style={{ position: 'fixed', left: pos.x, top: pos.y, zIndex: z, width: DEFAULT_W }}
      className="rounded-lg border border-default dark:border-slate-700 bg-white dark:bg-slate-900 shadow-2xl flex flex-col max-h-[80vh]"
      onPointerDown={onFocus}
    >
      {/* Drag handle / title bar */}
      <div
        className="flex items-center gap-2 px-3 py-2 border-b border-default dark:border-slate-700 cursor-grab active:cursor-grabbing select-none bg-slate-50 dark:bg-slate-800/60 rounded-t-lg"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
      >
        <GripVertical size={14} className="text-tertiary flex-shrink-0" />
        <Icon size={14} className="text-slate-500 flex-shrink-0" />
        <span className="text-sm font-semibold text-slate-700 dark:text-slate-200 flex-1 truncate">{label}</span>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onClose() }}
          className="h-6 w-6 inline-flex items-center justify-center rounded hover:bg-slate-200 dark:hover:bg-slate-700 text-tertiary hover:text-slate-700 dark:hover:text-slate-200 transition-colors flex-shrink-0"
          aria-label={`Close ${label}`}
        >
          <X size={12} />
        </button>
      </div>

      {/* Content */}
      <div className="overflow-y-auto flex-1 p-1">
        {children}
      </div>
    </div>
  )
}

// ── Widget picker dropdown ─────────────────────────────────────────────────

interface WidgetPickerProps {
  store: WidgetStore
  onToggle: (id: WidgetId) => void
  onClose: () => void
}

function WidgetPicker({ store, onToggle, onClose }: WidgetPickerProps) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onClose])

  return (
    <div
      ref={ref}
      className="absolute right-0 top-full mt-1 w-64 bg-white dark:bg-slate-900 border border-default dark:border-slate-700 rounded-lg shadow-xl z-50 overflow-hidden"
    >
      <div className="px-3 py-2 border-b border-subtle dark:border-slate-800">
        <span className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">Panels</span>
      </div>
      <div className="max-h-80 overflow-y-auto py-1">
        {WIDGET_DEFS.map((def) => {
          const open = store[def.id]?.open ?? false
          return (
            <button
              key={def.id}
              type="button"
              onClick={() => onToggle(def.id)}
              className={cn(
                'w-full flex items-center gap-2.5 px-3 py-2 text-sm text-left hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors',
                open ? 'text-blue-600 dark:text-blue-400' : 'text-slate-700 dark:text-slate-300',
              )}
            >
              <def.icon size={13} className="flex-shrink-0" />
              <span className="flex-1 truncate">{def.label}</span>
              {open && (
                <span className="text-xs bg-blue-50 dark:bg-blue-950/50 text-blue-600 dark:text-blue-400 border border-blue-200 dark:border-blue-900 rounded px-1.5 py-px">
                  open
                </span>
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}

// ── Widget content renderer ────────────────────────────────────────────────

interface WidgetContentProps {
  id: WidgetId
  onRefreshPageData?: () => void
  containerFill?: ContainerFillEntry[]
}

function WidgetContent({ id, onRefreshPageData, containerFill }: WidgetContentProps) {
  switch (id) {
    case 'pipeline':        return <div className="p-1"><PipelineHealthStrip onRefreshPageData={onRefreshPageData} /></div>
    case 'automation':      return <AutomationRulesCard />
    case 'scenarios':       return <ScenariosCard />
    case 'stockout':        return <StockoutImpactCard />
    case 'cashflow':        return <CashFlowCard />
    case 'restock':         return <FbaRestockHealthCard />
    case 'slow-movers':     return <SlowMoversCard />
    case 'pan-eu':          return <PanEuDistributionCard />
    case 'supplier-spend':  return <SupplierSpendCard />
    case 'forecast-bias':   return <ForecastBiasCard />
    case 'cannibalization': return <CannibalizationCard />
    case 'forecast-health': return <ForecastHealthCard />
    case 'forecast-models': return <ForecastModelsCard />
    case 'container-fill':
      return containerFill && containerFill.length > 0
        ? <ContainerFillCard entries={containerFill} />
        : <div className="p-3 text-sm text-tertiary">No container fill data available.</div>
    default: return null
  }
}

// ── Main exported hook ─────────────────────────────────────────────────────

export function useWidgetStore() {
  const [store, setStore] = useState<WidgetStore>({})

  useEffect(() => {
    setStore(loadStore())
  }, [])

  const save = useCallback((next: WidgetStore) => {
    setStore(next)
    saveStore(next)
  }, [])

  const toggle = useCallback((id: WidgetId) => {
    setStore((prev) => {
      const cur = prev[id]
      const def = WIDGET_DEFS.find((d) => d.id === id)!
      const next: WidgetStore = {
        ...prev,
        [id]: cur?.open
          ? { ...cur, open: false }
          : { open: true, pos: cur?.pos ?? def.defaultPos, z: ++globalZ },
      }
      saveStore(next)
      return next
    })
  }, [])

  const close = useCallback((id: WidgetId) => {
    setStore((prev) => {
      const next = { ...prev, [id]: { ...prev[id]!, open: false } }
      saveStore(next)
      return next
    })
  }, [])

  const move = useCallback((id: WidgetId, pos: WidgetPos) => {
    setStore((prev) => {
      const next = { ...prev, [id]: { ...prev[id]!, pos } }
      saveStore(next)
      return next
    })
  }, [])

  const focus = useCallback((id: WidgetId) => {
    setStore((prev) => {
      const next = { ...prev, [id]: { ...prev[id]!, z: ++globalZ } }
      saveStore(next)
      return next
    })
  }, [])

  return { store, toggle, close, move, focus, save }
}

// ── Main exported components ───────────────────────────────────────────────

interface ReplenishmentWidgetsProps {
  store: WidgetStore
  onClose: (id: WidgetId) => void
  onMove: (id: WidgetId, pos: WidgetPos) => void
  onFocus: (id: WidgetId) => void
  onRefreshPageData?: () => void
  containerFill?: ContainerFillEntry[]
}

export function ReplenishmentWidgets({
  store, onClose, onMove, onFocus, onRefreshPageData, containerFill,
}: ReplenishmentWidgetsProps) {
  return (
    <>
      {WIDGET_DEFS.map((def) => {
        const state = store[def.id]
        if (!state?.open) return null
        return (
          <FloatingWidget
            key={def.id}
            label={def.label}
            icon={def.icon}
            pos={state.pos}
            z={state.z}
            onClose={() => onClose(def.id)}
            onFocus={() => onFocus(def.id)}
            onMove={(pos) => onMove(def.id, pos)}
          >
            <WidgetContent id={def.id} onRefreshPageData={onRefreshPageData} containerFill={containerFill} />
          </FloatingWidget>
        )
      })}
    </>
  )
}

interface WidgetLauncherProps {
  store: WidgetStore
  onToggle: (id: WidgetId) => void
}

export function WidgetLauncher({ store, onToggle }: WidgetLauncherProps) {
  const [open, setOpen] = useState(false)
  const openCount = WIDGET_DEFS.filter((d) => store[d.id]?.open).length

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'h-8 px-3 text-sm border rounded-md inline-flex items-center gap-1.5 transition-colors',
          open || openCount > 0
            ? 'bg-blue-50 dark:bg-blue-950/40 border-blue-200 dark:border-blue-900 text-blue-700 dark:text-blue-400'
            : 'bg-white dark:bg-slate-900 border-default dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:border-slate-300',
        )}
        aria-label="Toggle panels"
      >
        <LayoutGrid size={13} />
        <span>Panels</span>
        {openCount > 0 && (
          <span className="text-xs bg-blue-600 text-white rounded-full px-1.5 leading-4">
            {openCount}
          </span>
        )}
      </button>
      {open && (
        <WidgetPicker
          store={store}
          onToggle={(id) => { onToggle(id); setOpen(false) }}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  )
}

import { Layers, Boxes, Link2, AlertTriangle, RefreshCw } from 'lucide-react'

export interface InventoryStats {
  masterProducts: number
  totalSKUs: number
  standalone: number
  variations: number
  syncedToAmazon: number
  lowStock: number
  lastSync: string | null
}

function formatRelative(iso: string | null): string {
  if (!iso) return 'Never'
  const date = new Date(iso)
  const diffMs = Date.now() - date.getTime()
  const diffMin = Math.floor(diffMs / 60_000)
  if (diffMin < 1) return 'Just now'
  if (diffMin < 60) return `${diffMin}m ago`
  const diffHr = Math.floor(diffMin / 60)
  if (diffHr < 24) return `${diffHr}h ago`
  const diffDay = Math.floor(diffHr / 24)
  if (diffDay < 30) return `${diffDay}d ago`
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}

interface StatProps {
  label: string
  value: string | number
  hint?: string
  icon: typeof Layers
  warning?: boolean
}

function Stat({ label, value, hint, icon: Icon, warning }: StatProps) {
  return (
    <div className="bg-white border border-slate-200 rounded-lg px-4 py-3">
      <div className="flex items-start justify-between gap-2">
        <div className="text-[11px] font-medium text-slate-500 uppercase tracking-wide">
          {label}
        </div>
        <Icon className={`w-3.5 h-3.5 flex-shrink-0 ${warning ? 'text-amber-500' : 'text-slate-400'}`} />
      </div>
      <div className={`text-[20px] font-semibold tabular-nums mt-1 ${warning ? 'text-amber-700' : 'text-slate-900'}`}>
        {value}
      </div>
      {hint && (
        <div className="text-[11px] text-slate-500 mt-0.5 truncate" title={hint}>
          {hint}
        </div>
      )}
    </div>
  )
}

export function StatsBar({ stats }: { stats: InventoryStats }) {
  const syncPct =
    stats.totalSKUs > 0
      ? `${Math.round((stats.syncedToAmazon / stats.totalSKUs) * 100)}% of catalog`
      : 'no SKUs yet'

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
      <Stat
        label="Master Products"
        value={stats.masterProducts.toLocaleString()}
        hint={`${stats.standalone} standalone, ${stats.masterProducts - stats.standalone} parents`}
        icon={Layers}
      />
      <Stat
        label="Total SKUs"
        value={stats.totalSKUs.toLocaleString()}
        hint={`includes ${stats.variations.toLocaleString()} variations`}
        icon={Boxes}
      />
      <Stat
        label="Synced to Amazon"
        value={`${stats.syncedToAmazon.toLocaleString()} / ${stats.totalSKUs.toLocaleString()}`}
        hint={syncPct}
        icon={Link2}
      />
      <Stat
        label="Low Stock"
        value={stats.lowStock.toLocaleString()}
        hint="≤ 5 units"
        icon={AlertTriangle}
        warning={stats.lowStock > 0}
      />
      <Stat
        label="Last Sync"
        value={formatRelative(stats.lastSync)}
        hint={stats.lastSync ? new Date(stats.lastSync).toLocaleString() : 'never run'}
        icon={RefreshCw}
      />
    </div>
  )
}

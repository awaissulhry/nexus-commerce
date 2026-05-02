import { Package, Link2, AlertTriangle, RefreshCw } from 'lucide-react'

interface Stats {
  total: number
  synced: number
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

export function StatsBar({ stats }: { stats: Stats }) {
  const items = [
    {
      label: 'Total Products',
      value: stats.total.toLocaleString(),
      icon: Package,
      sub: 'in master catalog',
    },
    {
      label: 'Synced',
      value: stats.synced.toLocaleString(),
      icon: Link2,
      sub: stats.total > 0
        ? `${Math.round((stats.synced / stats.total) * 100)}% of catalog`
        : 'no products yet',
    },
    {
      label: 'Low Stock',
      value: stats.lowStock.toLocaleString(),
      icon: AlertTriangle,
      sub: 'below 5 units',
      tone: stats.lowStock > 0 ? 'warning' : 'default',
    },
    {
      label: 'Last Sync',
      value: formatRelative(stats.lastSync),
      icon: RefreshCw,
      sub: stats.lastSync ? new Date(stats.lastSync).toLocaleString() : 'never run',
    },
  ] as const

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      {items.map((it) => {
        const Icon = it.icon
        return (
          <div
            key={it.label}
            className="bg-white border border-slate-200 rounded-lg px-4 py-3"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="text-[11px] font-medium text-slate-500 uppercase tracking-wide">
                {it.label}
              </div>
              <Icon
                className={`w-3.5 h-3.5 flex-shrink-0 ${
                  'tone' in it && it.tone === 'warning'
                    ? 'text-amber-500'
                    : 'text-slate-400'
                }`}
              />
            </div>
            <div
              className={`text-[20px] font-semibold tabular-nums mt-1 ${
                'tone' in it && it.tone === 'warning'
                  ? 'text-amber-700'
                  : 'text-slate-900'
              }`}
            >
              {it.value}
            </div>
            <div className="text-[11px] text-slate-500 mt-0.5 truncate" title={it.sub}>
              {it.sub}
            </div>
          </div>
        )
      })}
    </div>
  )
}

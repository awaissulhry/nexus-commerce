import { Boxes, Clock, Truck, AlertCircle, CheckCircle2 } from 'lucide-react'
import PageHeader from '@/components/layout/PageHeader'
import { getBackendUrl } from '@/lib/backend-url'
import { OrdersClient, type Order } from './OrdersClient'

export const dynamic = 'force-dynamic'

interface OrderStats {
  total: number
  pending: number
  shipped: number
  cancelled: number
  delivered: number
  lastOrderAt: string | null
}

const FALLBACK_STATS: OrderStats = {
  total: 0,
  pending: 0,
  shipped: 0,
  cancelled: 0,
  delivered: 0,
  lastOrderAt: null,
}

interface ApiOrder {
  id: string
  channel: Order['channel']
  channelOrderId: string
  status: Order['status']
  totalPrice: number | string
  customerName: string
  customerEmail: string
  items: Array<{ id: string }>
  createdAt: string
}

async function loadOrders(): Promise<{ orders: Order[]; stats: OrderStats }> {
  const backend = getBackendUrl()
  const [statsRes, listRes] = await Promise.all([
    fetch(`${backend}/api/orders/stats`, { cache: 'no-store' }),
    fetch(`${backend}/api/orders?page=1&limit=100`, { cache: 'no-store' }),
  ])

  const stats: OrderStats = statsRes.ok ? await statsRes.json() : FALLBACK_STATS

  if (!listRes.ok) {
    return { orders: [], stats }
  }
  const data = await listRes.json()
  const raw: ApiOrder[] = data?.data?.orders ?? []

  const orders: Order[] = raw.map((o) => ({
    id: o.id,
    channel: o.channel,
    channelOrderId: o.channelOrderId,
    status: o.status,
    totalPrice: o.totalPrice,
    customerName: o.customerName,
    customerEmail: o.customerEmail,
    itemCount: o.items?.length ?? 0,
    createdAt: o.createdAt,
  }))

  return { orders, stats }
}

interface StatCardProps {
  label: string
  value: number
  icon: typeof Boxes
  warning?: boolean
}

function StatCard({ label, value, icon: Icon, warning }: StatCardProps) {
  return (
    <div className="bg-white border border-slate-200 rounded-lg px-4 py-3">
      <div className="flex items-start justify-between gap-2">
        <div className="text-[11px] font-medium text-slate-500 uppercase tracking-wide">
          {label}
        </div>
        <Icon
          className={`w-3.5 h-3.5 flex-shrink-0 ${
            warning ? 'text-amber-500' : 'text-slate-400'
          }`}
        />
      </div>
      <div
        className={`text-[20px] font-semibold tabular-nums mt-1 ${
          warning ? 'text-amber-700' : 'text-slate-900'
        }`}
      >
        {value.toLocaleString()}
      </div>
    </div>
  )
}

export default async function OrdersPage() {
  const { orders, stats } = await loadOrders()

  return (
    <div className="space-y-5">
      <PageHeader
        title="Orders"
        description="Cross-channel order management"
      />

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
        <StatCard label="Total" value={stats.total} icon={Boxes} />
        <StatCard
          label="Pending"
          value={stats.pending}
          icon={Clock}
          warning={stats.pending > 0}
        />
        <StatCard label="Shipped" value={stats.shipped} icon={Truck} />
        <StatCard label="Delivered" value={stats.delivered} icon={CheckCircle2} />
        <StatCard label="Cancelled" value={stats.cancelled} icon={AlertCircle} />
      </div>

      <OrdersClient orders={orders} stats={stats} />
    </div>
  )
}

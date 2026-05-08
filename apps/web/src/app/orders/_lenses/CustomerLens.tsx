'use client'

/**
 * O.8a — extracted from OrdersWorkspace.tsx as the first step of the
 * file-decomposition sweep (mirrors /products P.1 pattern). Self-
 * contained: manages its own search state, fetches /api/orders with
 * a 500-row page, groups by customerEmail in-memory.
 *
 * No props from parent. Lens dispatcher in OrdersWorkspace mounts
 * <CustomerLens /> when ?lens=customer; on lens swap, the component
 * unmounts and the next render re-fetches.
 *
 * Display: dense table with email link, order count (highlighted
 * when >1), lifetime value, last order date. Drilling on the email
 * navigates back to the Grid lens with the customerEmail filter
 * applied — closes the loop.
 */

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Mail, Search, User } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { Input } from '@/components/ui/Input'
import { Skeleton } from '@/components/ui/Skeleton'
import { getBackendUrl } from '@/lib/backend-url'

type CustomerGroup = {
  email: string
  orderCount: number
  totalSpent: number
  lastOrderAt: string | null
}

export function CustomerLens() {
  const [search, setSearch] = useState('')
  const [groups, setGroups] = useState<CustomerGroup[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    fetch(
      `${getBackendUrl()}/api/orders?pageSize=500${
        search ? `&customerEmail=${encodeURIComponent(search)}` : ''
      }`,
      { cache: 'no-store' },
    )
      .then((r) => r.json())
      .then((data) => {
        const map = new Map<string, CustomerGroup>()
        for (const o of data.orders ?? []) {
          const cur = map.get(o.customerEmail) ?? {
            email: o.customerEmail,
            orderCount: 0,
            totalSpent: 0,
            lastOrderAt: null,
          }
          cur.orderCount += 1
          cur.totalSpent += Number(o.totalPrice ?? 0)
          if (
            !cur.lastOrderAt ||
            (o.purchaseDate && o.purchaseDate > cur.lastOrderAt)
          ) {
            cur.lastOrderAt = o.purchaseDate ?? o.createdAt
          }
          map.set(o.customerEmail, cur)
        }
        setGroups(
          Array.from(map.values()).sort(
            (a, b) => b.totalSpent - a.totalSpent,
          ),
        )
      })
      .finally(() => setLoading(false))
  }, [search])

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <div className="flex-1 max-w-md relative">
          <Search
            size={12}
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400"
          />
          <Input
            placeholder="Search customer email…"
            value={search}
            onChange={(e: any) => setSearch(e.target.value)}
            className="pl-7"
          />
        </div>
      </div>
      {loading ? (
        <Card>
          <Skeleton lines={6} />
        </Card>
      ) : groups.length === 0 ? (
        <EmptyState
          icon={User}
          title="No customers"
          description="No orders found yet."
        />
      ) : (
        <Card noPadding>
          <div className="overflow-x-auto">
            <table className="w-full text-md">
              <thead className="bg-slate-50 border-b border-slate-200">
                <tr>
                  <th className="px-3 py-2 text-left text-sm font-semibold uppercase text-slate-700">
                    Customer
                  </th>
                  <th className="px-3 py-2 text-right text-sm font-semibold uppercase text-slate-700">
                    Orders
                  </th>
                  <th className="px-3 py-2 text-right text-sm font-semibold uppercase text-slate-700">
                    LTV
                  </th>
                  <th className="px-3 py-2 text-left text-sm font-semibold uppercase text-slate-700">
                    Last order
                  </th>
                </tr>
              </thead>
              <tbody>
                {groups.map((g) => (
                  <tr
                    key={g.email}
                    className="border-b border-slate-100 hover:bg-slate-50"
                  >
                    <td className="px-3 py-2">
                      <Link
                        href={`/orders?customerEmail=${encodeURIComponent(g.email)}`}
                        className="text-base text-blue-600 hover:underline inline-flex items-center gap-1"
                      >
                        <Mail size={11} /> {g.email}
                      </Link>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {g.orderCount > 1 ? (
                        <span className="font-semibold text-blue-700">
                          {g.orderCount}
                        </span>
                      ) : (
                        <span className="text-slate-500">{g.orderCount}</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums font-semibold text-slate-900">
                      €{g.totalSpent.toFixed(2)}
                    </td>
                    <td className="px-3 py-2 text-sm text-slate-500">
                      {g.lastOrderAt
                        ? new Date(g.lastOrderAt).toLocaleDateString('en-GB', {
                            day: 'numeric',
                            month: 'short',
                            year: '2-digit',
                          })
                        : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  )
}

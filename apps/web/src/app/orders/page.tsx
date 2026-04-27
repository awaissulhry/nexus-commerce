'use client'

import { useState, useEffect } from 'react'
import PageHeader from '@/components/layout/PageHeader'

interface OrderItem {
  id: string
  sku: string
  quantity: number
  price: number
}

interface Order {
  id: string
  channel: 'AMAZON' | 'EBAY' | 'SHOPIFY'
  channelOrderId: string
  status: 'PENDING' | 'SHIPPED' | 'CANCELLED' | 'DELIVERED'
  totalPrice: number
  customerName: string
  customerEmail: string
  shippingAddress: any
  items: OrderItem[]
  createdAt: string
  updatedAt: string
}

interface OrdersResponse {
  orders: Order[]
  total: number
  page: number
  pages: number
}

const CHANNEL_ICONS: Record<string, string> = {
  AMAZON: '🔶',
  EBAY: '🔴',
  SHOPIFY: '🟢',
}

const STATUS_COLORS: Record<string, { bg: string; text: string }> = {
  PENDING: { bg: 'bg-yellow-100', text: 'text-yellow-800' },
  SHIPPED: { bg: 'bg-green-100', text: 'text-green-800' },
  CANCELLED: { bg: 'bg-red-100', text: 'text-red-800' },
  DELIVERED: { bg: 'bg-blue-100', text: 'text-blue-800' },
}

export default function OrdersPage() {
  const [orders, setOrders] = useState<Order[]>([])
  const [loading, setLoading] = useState(false)
  const [ingesting, setIngesting] = useState(false)
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [pages, setPages] = useState(0)
  const [successMessage, setSuccessMessage] = useState('')

  // Fetch orders on mount and when page changes
  useEffect(() => {
    fetchOrders()
  }, [page])

  const fetchOrders = async () => {
    try {
      setLoading(true)
      const response = await fetch(`/api/orders?page=${page}&limit=20`)
      const data: { success: boolean; data: OrdersResponse } = await response.json()

      if (data.success) {
        setOrders(data.data.orders)
        setTotal(data.data.total)
        setPages(data.data.pages)
      }
    } catch (error) {
      console.error('Error fetching orders:', error)
    } finally {
      setLoading(false)
    }
  }

  const handleIngestOrders = async () => {
    try {
      setIngesting(true)
      const response = await fetch('/api/orders/ingest', {
        method: 'POST',
      })
      const data = await response.json()

      if (data.success) {
        setSuccessMessage(
          `✅ Ingested ${data.data.ordersCreated} orders with ${data.data.itemsCreated} items`
        )
        setTimeout(() => setSuccessMessage(''), 5000)
        // Refresh orders
        setPage(1)
        await fetchOrders()
      }
    } catch (error) {
      console.error('Error ingesting orders:', error)
    } finally {
      setIngesting(false)
    }
  }

  const handleShipOrder = async (orderId: string) => {
    try {
      const response = await fetch(`/api/orders/${orderId}/ship`, {
        method: 'PATCH',
      })
      const data = await response.json()

      if (data.success) {
        // Update local state
        setOrders(
          orders.map((order) =>
            order.id === orderId ? { ...order, status: 'SHIPPED' } : order
          )
        )
      }
    } catch (error) {
      console.error('Error shipping order:', error)
    }
  }

  return (
    <div>
      <PageHeader
        title="Orders"
        subtitle={`${total} total order${total !== 1 ? 's' : ''}`}
        breadcrumbs={[{ label: 'Orders' }]}
      />

      {/* Success Message */}
      {successMessage && (
        <div className="mb-4 p-4 bg-green-50 border border-green-200 rounded-lg text-green-800">
          {successMessage}
        </div>
      )}

      {/* Header with Ingest Button */}
      <div className="mb-6 flex justify-between items-center">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">Order Hub</h2>
          <p className="text-sm text-slate-600">
            Cross-channel order management with real-time inventory sync
          </p>
        </div>
        <button
          onClick={handleIngestOrders}
          disabled={ingesting}
          className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium disabled:opacity-50"
        >
          {ingesting ? (
            <>
              <span className="inline-block animate-spin mr-2">⏳</span>
              Ingesting...
            </>
          ) : (
            '+ Ingest Orders'
          )}
        </button>
      </div>

      {/* Orders Table */}
      <div className="bg-white rounded-lg border border-slate-200 overflow-hidden">
        {loading ? (
          <div className="p-12 text-center">
            <p className="text-slate-600">Loading orders...</p>
          </div>
        ) : orders.length === 0 ? (
          <div className="p-12 text-center">
            <p className="text-slate-600 mb-4">No orders found</p>
            <button
              onClick={handleIngestOrders}
              disabled={ingesting}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium disabled:opacity-50"
            >
              {ingesting ? 'Ingesting...' : 'Create Sample Orders'}
            </button>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 border-b border-slate-200">
                <tr>
                  <th className="px-4 py-3 text-left font-semibold text-slate-700">Channel</th>
                  <th className="px-4 py-3 text-left font-semibold text-slate-700">Order ID</th>
                  <th className="px-4 py-3 text-left font-semibold text-slate-700">Date</th>
                  <th className="px-4 py-3 text-left font-semibold text-slate-700">Customer</th>
                  <th className="px-4 py-3 text-left font-semibold text-slate-700">Items</th>
                  <th className="px-4 py-3 text-right font-semibold text-slate-700">Total</th>
                  <th className="px-4 py-3 text-left font-semibold text-slate-700">Status</th>
                  <th className="px-4 py-3 text-left font-semibold text-slate-700">Actions</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((order) => (
                  <tr key={order.id} className="border-b border-slate-200 hover:bg-slate-50">
                    {/* Channel */}
                    <td className="px-4 py-3 text-sm font-medium">
                      <span className="text-lg mr-2">{CHANNEL_ICONS[order.channel]}</span>
                      {order.channel}
                    </td>

                    {/* Order ID */}
                    <td className="px-4 py-3 text-sm font-mono text-slate-700">
                      {order.channelOrderId.substring(0, 20)}...
                    </td>

                    {/* Date */}
                    <td className="px-4 py-3 text-sm text-slate-600">
                      {new Date(order.createdAt).toLocaleDateString('en-US', {
                        month: 'short',
                        day: 'numeric',
                        year: 'numeric',
                      })}
                    </td>

                    {/* Customer */}
                    <td className="px-4 py-3 text-sm">
                      <div className="font-medium text-slate-900">{order.customerName}</div>
                      <div className="text-xs text-slate-500">{order.customerEmail}</div>
                    </td>

                    {/* Items */}
                    <td className="px-4 py-3 text-sm text-slate-600">
                      {order.items.length} item{order.items.length !== 1 ? 's' : ''}
                    </td>

                    {/* Total */}
                    <td className="px-4 py-3 text-sm font-semibold text-slate-900 text-right">
                      ${typeof order.totalPrice === 'string' ? parseFloat(order.totalPrice).toFixed(2) : order.totalPrice.toFixed(2)}
                    </td>

                    {/* Status */}
                    <td className="px-4 py-3 text-sm">
                      <span
                        className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                          STATUS_COLORS[order.status].bg
                        } ${STATUS_COLORS[order.status].text}`}
                      >
                        {order.status}
                      </span>
                    </td>

                    {/* Actions */}
                    <td className="px-4 py-3 text-sm">
                      {order.status === 'PENDING' && (
                        <button
                          onClick={() => handleShipOrder(order.id)}
                          className="text-blue-600 hover:text-blue-700 font-medium"
                        >
                          Ship Order
                        </button>
                      )}
                      {order.status === 'SHIPPED' && (
                        <span className="text-slate-500">Shipped</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Pagination */}
      {pages > 1 && (
        <div className="mt-6 flex justify-center gap-2">
          <button
            onClick={() => setPage(Math.max(1, page - 1))}
            disabled={page === 1}
            className="px-4 py-2 border border-slate-300 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            Previous
          </button>
          <div className="flex items-center gap-2">
            {Array.from({ length: pages }, (_, i) => i + 1).map((p) => (
              <button
                key={p}
                onClick={() => setPage(p)}
                className={`px-3 py-2 rounded-lg text-sm font-medium ${
                  p === page
                    ? 'bg-blue-600 text-white'
                    : 'border border-slate-300 text-slate-700 hover:bg-slate-50'
                }`}
              >
                {p}
              </button>
            ))}
          </div>
          <button
            onClick={() => setPage(Math.min(pages, page + 1))}
            disabled={page === pages}
            className="px-4 py-2 border border-slate-300 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            Next
          </button>
        </div>
      )}
    </div>
  )
}

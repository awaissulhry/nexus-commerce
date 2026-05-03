'use client'

import { useState, useEffect } from 'react'
import { ShoppingBag, Plug, AlertCircle } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { cn } from '@/lib/utils'
import { getBackendUrl } from '@/lib/backend-url'

interface ChannelConnection {
  id: string
  channelType: string
  isActive: boolean
  sellerName?: string
  storeName?: string
  storeFrontUrl?: string
  tokenExpiresAt?: string
  lastSyncAt?: string
  lastSyncStatus?: string
  lastSyncError?: string
}

interface ChannelDef {
  type: 'EBAY' | 'AMAZON' | 'SHOPIFY' | 'WOOCOMMERCE' | 'ETSY'
  name: string
  description: string
}

const CHANNELS: ChannelDef[] = [
  { type: 'AMAZON', name: 'Amazon', description: 'Connect your Amazon seller account' },
  { type: 'EBAY', name: 'eBay', description: 'Connect your eBay seller account' },
  { type: 'SHOPIFY', name: 'Shopify', description: 'Connect your Shopify store' },
  { type: 'WOOCOMMERCE', name: 'WooCommerce', description: 'Connect your WooCommerce store' },
  { type: 'ETSY', name: 'Etsy', description: 'Connect your Etsy shop' },
]

export function ChannelsClient() {
  const [connections, setConnections] = useState<Map<string, ChannelConnection>>(
    new Map()
  )
  const [loading, setLoading] = useState(true)
  const [statusMsg, setStatusMsg] = useState<{ kind: 'error' | 'success' | 'info'; text: string } | null>(null)
  const [connectingChannel, setConnectingChannel] = useState<string | null>(null)
  const [testingId, setTestingId] = useState<string | null>(null)

  useEffect(() => {
    loadConnections()
  }, [])

  async function loadConnections() {
    try {
      setLoading(true)
      setStatusMsg(null)
      // In a real app, fetch from API. Schema's ChannelConnection table
      // exists but no list endpoint is wired yet — start empty.
      const newConnections = new Map<string, ChannelConnection>()
      setConnections(newConnections)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load connections'
      setStatusMsg({ kind: 'error', text: message })
    } finally {
      setLoading(false)
    }
  }

  async function handleConnectEbay() {
    try {
      setConnectingChannel('EBAY')
      setStatusMsg(null)

      const response = await fetch(`${getBackendUrl()}/api/ebay/auth/initiate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          redirectUri: `${window.location.origin}/settings/channels/ebay-callback`,
        }),
      })

      if (!response.ok) {
        throw new Error('Failed to initiate eBay connection')
      }

      const data = await response.json()

      if (!data.success || !data.authUrl) {
        throw new Error(data.error || 'Failed to generate authorization URL')
      }

      sessionStorage.setItem('ebayAuthState', data.state)
      window.location.href = data.authUrl
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Connection failed'
      setStatusMsg({ kind: 'error', text: message })
      setConnectingChannel(null)
    }
  }

  async function handleRevokeConnection(connectionId: string) {
    if (!confirm('Are you sure you want to disconnect this channel?')) return

    try {
      const response = await fetch(`${getBackendUrl()}/api/ebay/auth/revoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connectionId }),
      })

      if (!response.ok) {
        throw new Error('Failed to revoke connection')
      }

      const newConnections = new Map(connections)
      newConnections.delete(connectionId)
      setConnections(newConnections)
      setStatusMsg({ kind: 'success', text: 'Connection revoked.' })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Revocation failed'
      setStatusMsg({ kind: 'error', text: message })
    }
  }

  async function handleTestConnection(connectionId: string) {
    try {
      setTestingId(connectionId)
      const response = await fetch(
        `${getBackendUrl()}/api/ebay/auth/test?connectionId=${connectionId}`,
      )

      if (!response.ok) {
        throw new Error('Connection test failed')
      }

      const data = await response.json()
      setStatusMsg({
        kind: 'success',
        text: `Connection OK. Seller: ${data.seller?.signInName ?? '(unknown)'}`,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Test failed'
      setStatusMsg({ kind: 'error', text: `Connection test failed: ${message}` })
    } finally {
      setTestingId(null)
    }
  }

  if (loading) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {[1, 2, 3].map((i) => (
          <div
            key={i}
            className="bg-white border border-slate-200 rounded-lg p-4 animate-pulse"
          >
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 bg-slate-200 rounded" />
              <div className="flex-1 space-y-2">
                <div className="h-3 bg-slate-200 rounded w-1/2" />
                <div className="h-2 bg-slate-200 rounded w-3/4" />
              </div>
            </div>
            <div className="h-8 bg-slate-200 rounded" />
          </div>
        ))}
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {statusMsg && (
        <div
          className={cn(
            'border rounded-lg px-4 py-3 text-[12px] flex items-start gap-2',
            statusMsg.kind === 'success' && 'bg-green-50 border-green-200 text-green-700',
            statusMsg.kind === 'error' && 'bg-red-50 border-red-200 text-red-700',
            statusMsg.kind === 'info' && 'bg-slate-50 border-slate-200 text-slate-700'
          )}
        >
          {statusMsg.kind === 'error' && (
            <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
          )}
          <span>{statusMsg.text}</span>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {CHANNELS.map((channel) => {
          const connection = connections.get(channel.type)
          const isConnected = !!connection?.isActive
          const isConnecting = connectingChannel === channel.type

          return (
            <Card key={channel.type}>
              <div className="flex items-start justify-between gap-3 mb-3">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-9 h-9 bg-slate-100 rounded-md flex items-center justify-center flex-shrink-0">
                    <ShoppingBag className="w-4 h-4 text-slate-600" />
                  </div>
                  <div className="min-w-0">
                    <h3 className="text-[14px] font-semibold text-slate-900">
                      {channel.name}
                    </h3>
                    <p className="text-[11px] text-slate-500 mt-0.5">
                      {channel.description}
                    </p>
                  </div>
                </div>
                {isConnected ? (
                  <Badge variant="success" size="md">
                    Connected
                  </Badge>
                ) : (
                  <Badge variant="default" size="md">
                    Not connected
                  </Badge>
                )}
              </div>

              {isConnected && connection && (
                <div className="space-y-1.5 mb-3 text-[12px] border-t border-slate-100 pt-3">
                  {connection.sellerName && (
                    <div className="flex justify-between gap-2">
                      <span className="text-slate-500">Seller</span>
                      <span className="text-slate-900 truncate">{connection.sellerName}</span>
                    </div>
                  )}
                  {connection.storeName && (
                    <div className="flex justify-between gap-2">
                      <span className="text-slate-500">Store</span>
                      <span className="text-slate-900 truncate">{connection.storeName}</span>
                    </div>
                  )}
                  {connection.tokenExpiresAt && (
                    <div className="flex justify-between gap-2">
                      <span className="text-slate-500">Token expires</span>
                      <span className="text-slate-900 tabular-nums">
                        {new Date(connection.tokenExpiresAt).toLocaleDateString('en-GB', {
                          day: 'numeric',
                          month: 'short',
                          year: 'numeric',
                        })}
                      </span>
                    </div>
                  )}
                  {connection.lastSyncAt && (
                    <div className="flex justify-between gap-2">
                      <span className="text-slate-500">Last sync</span>
                      <span className="text-slate-900 tabular-nums">
                        {new Date(connection.lastSyncAt).toLocaleDateString('en-GB', {
                          day: 'numeric',
                          month: 'short',
                          year: 'numeric',
                        })}
                      </span>
                    </div>
                  )}
                </div>
              )}

              <div className="flex gap-2">
                {isConnected && connection ? (
                  <>
                    <Button
                      variant="secondary"
                      size="sm"
                      loading={testingId === connection.id}
                      onClick={() => handleTestConnection(connection.id)}
                      className="flex-1"
                    >
                      Test
                    </Button>
                    <Button
                      variant="danger"
                      size="sm"
                      onClick={() => handleRevokeConnection(connection.id)}
                      className="flex-1"
                    >
                      Disconnect
                    </Button>
                  </>
                ) : (
                  <Button
                    variant="primary"
                    size="sm"
                    loading={isConnecting}
                    icon={<Plug className="w-3.5 h-3.5" />}
                    onClick={() => {
                      if (channel.type === 'EBAY') {
                        handleConnectEbay()
                      } else {
                        setStatusMsg({
                          kind: 'info',
                          text: `${channel.name} OAuth flow ships in Phase 5.`,
                        })
                      }
                    }}
                    className="flex-1"
                  >
                    Connect
                  </Button>
                )}
              </div>
            </Card>
          )
        })}
      </div>

      <Card title="About marketplace connections">
        <ul className="text-[12px] text-slate-600 space-y-1.5">
          <li>· Each connection authorizes Nexus to read products, listings, and orders from that channel.</li>
          <li>· OAuth tokens are stored encrypted and refreshed automatically before expiry.</li>
          <li>· Disconnecting revokes the token and stops all syncs for that channel.</li>
          <li>· Currently live: <strong>eBay OAuth</strong>. Other channels are stubbed pending Phase 5.</li>
        </ul>
      </Card>
    </div>
  )
}

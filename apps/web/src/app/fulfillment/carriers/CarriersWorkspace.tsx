'use client'

// FULFILLMENT B.9 — Carriers. Sendcloud is the European carrier middleware that
// covers BRT, GLS, Poste Italiane, DHL, UPS, FedEx, etc. Connect once, then ship
// labels from /fulfillment/outbound. Amazon Buy Shipping handles FBM-via-Amazon.

import { useCallback, useEffect, useState } from 'react'
import { Truck, ExternalLink, Lock } from 'lucide-react'
import PageHeader from '@/components/layout/PageHeader'
import { Card } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { getBackendUrl } from '@/lib/backend-url'

type Carrier = {
  id: string
  code: string
  name: string
  isActive: boolean
  hasCredentials: boolean
  defaultServiceMap: any
  updatedAt: string
}

const CARRIER_DEFS = [
  {
    code: 'SENDCLOUD',
    label: 'Sendcloud',
    description: 'European carrier middleware. Connects BRT, GLS, Poste Italiane, DHL, UPS, FedEx in one integration. Recommended.',
    docsUrl: 'https://api.sendcloud.dev/docs/sendcloud-public-api/',
    fields: [
      { key: 'publicKey', label: 'Public key' },
      { key: 'privateKey', label: 'Private key', password: true },
      { key: 'integrationId', label: 'Integration ID', type: 'number' as const },
    ],
  },
  {
    code: 'AMAZON_BUY_SHIPPING',
    label: 'Amazon Buy Shipping',
    description: 'For FBM orders fulfilled directly through Amazon. Uses your Seller Central credentials — no extra setup.',
    docsUrl: 'https://developer-docs.amazon.com/sp-api/docs/shipping-api-v1-reference',
    fields: [],
  },
  {
    code: 'MANUAL',
    label: 'Manual labels',
    description: 'Skip carrier integration — print labels elsewhere and paste tracking numbers manually. No setup.',
    docsUrl: null,
    fields: [],
  },
]

export default function CarriersWorkspace() {
  const [carriers, setCarriers] = useState<Carrier[]>([])
  const [loading, setLoading] = useState(true)

  const fetchCarriers = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`${getBackendUrl()}/api/fulfillment/carriers`, { cache: 'no-store' })
      if (res.ok) {
        const data = await res.json()
        setCarriers(data.items ?? [])
      }
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { fetchCarriers() }, [fetchCarriers])

  return (
    <div className="space-y-5">
      <PageHeader
        title="Carriers"
        description="Connect shipping providers. Sendcloud handles all European carriers; Amazon Buy Shipping covers FBM-via-Amazon."
        breadcrumbs={[{ label: 'Fulfillment', href: '/fulfillment' }, { label: 'Carriers' }]}
      />

      {loading && carriers.length === 0 ? (
        <Card><div className="text-[13px] text-slate-500 py-8 text-center">Loading…</div></Card>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
          {CARRIER_DEFS.map((def) => {
            const carrier = carriers.find((c) => c.code === def.code)
            return (
              <CarrierCard
                key={def.code}
                def={def}
                carrier={carrier ?? null}
                onChanged={fetchCarriers}
              />
            )
          })}
        </div>
      )}

      <Card>
        <div className="text-[12px] text-slate-600 space-y-1">
          <div className="font-semibold text-slate-900">How carrier connections work</div>
          <ul className="list-disc list-inside space-y-0.5 text-[12px]">
            <li>Sendcloud is the recommended setup for Italian operations — one integration covers BRT, GLS, Poste, DHL, UPS, FedEx.</li>
            <li>When a shipment is created at /fulfillment/outbound, Nexus calls Sendcloud to print the label and pulls the tracking number.</li>
            <li>Tracking numbers automatically push back to the originating channel (Amazon, eBay, Shopify, Woo, Etsy).</li>
            <li>Amazon Buy Shipping is only needed if you want to fulfill FBM orders directly through Amazon's network.</li>
          </ul>
        </div>
      </Card>
    </div>
  )
}

function CarrierCard({
  def, carrier, onChanged,
}: {
  def: (typeof CARRIER_DEFS)[number]
  carrier: Carrier | null
  onChanged: () => void
}) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [fields, setFields] = useState<Record<string, string>>({})

  const isConnected = !!carrier?.isActive

  const connect = async () => {
    setBusy(true)
    try {
      const body: any = {}
      for (const f of def.fields) {
        const v = fields[f.key]
        if (f.type === 'number') body[f.key] = v ? Number(v) : undefined
        else body[f.key] = v
      }
      const res = await fetch(`${getBackendUrl()}/api/fulfillment/carriers/${def.code}/connect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error ?? 'Connect failed')
      }
      setOpen(false)
      setFields({})
      onChanged()
    } catch (e: any) {
      alert(e.message)
    } finally { setBusy(false) }
  }

  const disconnect = async () => {
    if (!confirm(`Disconnect ${def.label}? Existing shipments are preserved.`)) return
    const res = await fetch(`${getBackendUrl()}/api/fulfillment/carriers/${def.code}/disconnect`, { method: 'POST' })
    if (res.ok) onChanged()
    else alert('Disconnect failed')
  }

  return (
    <Card>
      <div className="space-y-3">
        <div className="flex items-start gap-3">
          <div className={`w-10 h-10 rounded-md inline-flex items-center justify-center flex-shrink-0 ${isConnected ? 'bg-emerald-50 text-emerald-600' : 'bg-slate-100 text-slate-500'}`}>
            <Truck size={18} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-[14px] font-semibold text-slate-900">{def.label}</span>
              {isConnected ? (
                <Badge variant="success" size="sm">Connected</Badge>
              ) : (
                <Badge variant="default" size="sm">Not connected</Badge>
              )}
            </div>
            <div className="text-[11px] text-slate-500 mt-1">{def.description}</div>
          </div>
        </div>

        {def.docsUrl && (
          <a href={def.docsUrl} target="_blank" rel="noreferrer" className="text-[11px] text-blue-600 hover:underline inline-flex items-center gap-1">
            API docs <ExternalLink size={10} />
          </a>
        )}

        {def.code === 'AMAZON_BUY_SHIPPING' || def.code === 'MANUAL' ? (
          <div className="text-[11px] text-slate-500">No setup required — uses existing Seller Central credentials or no credentials at all.</div>
        ) : open ? (
          <div className="space-y-2 pt-2 border-t border-slate-100">
            {def.fields.map((f) => (
              <div key={f.key}>
                <div className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold mb-0.5">{f.label}</div>
                <input
                  type={f.password ? 'password' : f.type === 'number' ? 'number' : 'text'}
                  value={fields[f.key] ?? ''}
                  onChange={(e) => setFields({ ...fields, [f.key]: e.target.value })}
                  className="h-7 w-full px-2 text-[12px] font-mono border border-slate-200 rounded"
                />
              </div>
            ))}
            <div className="flex items-center gap-2 pt-1">
              <button onClick={connect} disabled={busy} className="h-7 px-3 text-[12px] bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50">Save</button>
              <button onClick={() => setOpen(false)} className="h-7 px-3 text-[12px] border border-slate-200 rounded hover:bg-slate-50">Cancel</button>
            </div>
          </div>
        ) : isConnected ? (
          <div className="flex items-center gap-2">
            <button onClick={() => setOpen(true)} className="h-7 px-3 text-[12px] bg-white text-slate-700 border border-slate-200 rounded hover:bg-slate-50">Update credentials</button>
            <button onClick={disconnect} className="h-7 px-3 text-[12px] bg-rose-50 text-rose-700 border border-rose-200 rounded hover:bg-rose-100">Disconnect</button>
          </div>
        ) : (
          <button onClick={() => setOpen(true)} className="h-8 px-3 text-[12px] bg-blue-600 text-white rounded hover:bg-blue-700 inline-flex items-center gap-1.5">
            <Lock size={12} /> Connect
          </button>
        )}
      </div>
    </Card>
  )
}

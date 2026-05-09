'use client'

// O.21 — Branded customer tracking page client. Mobile-first,
// PII-minimal. Reads /api/public/track/:trackingNumber and renders a
// Xavia-branded timeline + ETA panel. No auth; URL itself is the key.

import { useEffect, useState } from 'react'
import {
  Truck, Package, MapPin, Clock, AlertTriangle, CheckCircle2, ExternalLink,
} from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'

interface TrackingResponse {
  trackingNumber: string
  carrier: string
  carrierTrackingUrl: string | null
  status: string
  shippedAt: string | null
  deliveredAt: string | null
  estimatedDelivery: string | null
  destinationCity: string | null
  events: Array<{
    id: string
    occurredAt: string
    code: string
    description: string
    location: string | null
  }>
}

const STATUS_LABEL_IT: Record<string, string> = {
  DRAFT: 'In preparazione',
  READY_TO_PICK: 'Da preparare',
  PICKED: 'Preparato',
  PACKED: 'Imballato',
  LABEL_PRINTED: 'Pronto per la spedizione',
  SHIPPED: 'In spedizione',
  IN_TRANSIT: 'In transito',
  DELIVERED: 'Consegnato',
  CANCELLED: 'Annullato',
  RETURNED: 'Restituito al mittente',
}

const EVENT_LABEL_IT: Record<string, string> = {
  ANNOUNCED: 'Etichetta generata',
  PICKED_UP: 'Ritirato dal corriere',
  IN_TRANSIT: 'In transito',
  OUT_FOR_DELIVERY: 'In consegna',
  DELIVERED: 'Consegnato',
  DELIVERY_ATTEMPTED: 'Tentativo di consegna',
  EXCEPTION: 'Anomalia',
  RETURNED_TO_SENDER: 'Restituito al mittente',
  CANCELLED: 'Annullato',
  INFO: 'Aggiornamento',
}

const STATUS_TONE: Record<string, string> = {
  DRAFT: 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300',
  PACKED: 'bg-blue-100 dark:bg-blue-900/60 text-blue-700 dark:text-blue-300',
  LABEL_PRINTED: 'bg-blue-100 dark:bg-blue-900/60 text-blue-700 dark:text-blue-300',
  SHIPPED: 'bg-amber-100 dark:bg-amber-900/60 text-amber-700 dark:text-amber-300',
  IN_TRANSIT: 'bg-amber-100 dark:bg-amber-900/60 text-amber-700 dark:text-amber-300',
  DELIVERED: 'bg-emerald-100 dark:bg-emerald-900/60 text-emerald-700 dark:text-emerald-300',
  CANCELLED: 'bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400',
  RETURNED: 'bg-rose-100 dark:bg-rose-900/60 text-rose-700 dark:text-rose-300',
}

export default function TrackingPageClient({ trackingNumber }: { trackingNumber: string }) {
  const [data, setData] = useState<TrackingResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const ctrl = new AbortController()
    ;(async () => {
      setLoading(true)
      try {
        const res = await fetch(`${getBackendUrl()}/api/public/track/${encodeURIComponent(trackingNumber)}`, {
          cache: 'no-store',
          signal: ctrl.signal,
        })
        if (res.status === 404) {
          setError('Numero di tracking non trovato. Verifica il codice e riprova.')
          return
        }
        if (!res.ok) {
          setError('Tracking non disponibile al momento.')
          return
        }
        setData(await res.json())
      } catch (e: any) {
        if (e.name !== 'AbortError') setError('Errore di connessione.')
      } finally {
        setLoading(false)
      }
    })()
    return () => ctrl.abort()
  }, [trackingNumber])

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-50 dark:bg-slate-800 flex items-center justify-center p-4">
        <div className="text-md text-slate-500 dark:text-slate-400">Caricamento…</div>
      </div>
    )
  }

  if (error || !data) {
    return (
      <div className="min-h-screen bg-slate-50 dark:bg-slate-800 flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-white dark:bg-slate-900 rounded-lg shadow-sm border border-slate-200 dark:border-slate-700 p-6 text-center space-y-3">
          <AlertTriangle size={28} className="mx-auto text-amber-600 dark:text-amber-400" />
          <div className="text-md text-slate-700 dark:text-slate-300">{error ?? 'Tracking non disponibile.'}</div>
          <div className="text-sm text-slate-500 dark:text-slate-400 font-mono">{trackingNumber}</div>
        </div>
      </div>
    )
  }

  const isDelivered = data.status === 'DELIVERED'
  const isException = data.status === 'RETURNED' || data.events[0]?.code === 'EXCEPTION'

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-50 to-white">
      <div className="max-w-2xl mx-auto p-4 md:p-8 space-y-5">
        {/* Brand header — minimal Xavia branding placeholder */}
        <div className="flex items-center justify-between">
          <div className="text-xl font-bold text-slate-900 dark:text-slate-100">Xavia</div>
          <div className="text-xs text-slate-500 dark:text-slate-400">Tracking</div>
        </div>

        {/* Status hero */}
        <div className="bg-white dark:bg-slate-900 rounded-lg shadow-sm border border-slate-200 dark:border-slate-700 p-5 md:p-6 space-y-3">
          <div className="flex items-start gap-3">
            {isDelivered ? (
              <CheckCircle2 size={32} className="text-emerald-600 dark:text-emerald-400 flex-shrink-0" />
            ) : isException ? (
              <AlertTriangle size={32} className="text-rose-600 dark:text-rose-400 flex-shrink-0" />
            ) : (
              <Truck size={32} className="text-blue-600 dark:text-blue-400 flex-shrink-0" />
            )}
            <div className="flex-1">
              <span
                className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${
                  STATUS_TONE[data.status] ?? 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300'
                }`}
              >
                {STATUS_LABEL_IT[data.status] ?? data.status}
              </span>
              <div className="text-2xl font-semibold text-slate-900 dark:text-slate-100 mt-1">
                {isDelivered
                  ? 'Consegnato!'
                  : isException
                  ? 'C’è un’anomalia'
                  : 'In viaggio'}
              </div>
              {data.estimatedDelivery && !isDelivered && (
                <div className="text-md text-slate-600 dark:text-slate-400 mt-1 flex items-center gap-1.5">
                  <Clock size={14} />
                  Consegna stimata:{' '}
                  <span className="tabular-nums">
                    {new Date(data.estimatedDelivery).toLocaleDateString('it-IT', {
                      weekday: 'long',
                      day: 'numeric',
                      month: 'long',
                    })}
                  </span>
                </div>
              )}
              {data.destinationCity && (
                <div className="text-sm text-slate-500 dark:text-slate-400 mt-1 flex items-center gap-1.5">
                  <MapPin size={12} />
                  Destinazione: {data.destinationCity}
                </div>
              )}
            </div>
          </div>

          <div className="border-t border-slate-100 dark:border-slate-800 pt-3 flex items-center gap-3 text-sm">
            <Package size={14} className="text-slate-400 dark:text-slate-500" />
            <div className="flex-1 font-mono text-slate-700 dark:text-slate-300">{data.trackingNumber}</div>
            <div className="text-slate-500 dark:text-slate-400 uppercase tracking-wider text-xs">{data.carrier}</div>
            {data.carrierTrackingUrl && (
              <a
                href={data.carrierTrackingUrl}
                target="_blank"
                rel="noreferrer"
                className="text-blue-600 dark:text-blue-400 hover:underline inline-flex items-center gap-1 text-xs"
              >
                Sito corriere <ExternalLink size={10} />
              </a>
            )}
          </div>
        </div>

        {/* Timeline */}
        <div className="bg-white dark:bg-slate-900 rounded-lg shadow-sm border border-slate-200 dark:border-slate-700 p-5 md:p-6">
          <div className="text-sm font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wider mb-3">
            Cronologia
          </div>
          {data.events.length === 0 ? (
            <div className="text-md text-slate-500 dark:text-slate-400 py-4 text-center">
              In attesa del primo aggiornamento dal corriere.
            </div>
          ) : (
            <ol className="space-y-3">
              {data.events.map((e, idx) => (
                <li key={e.id} className="flex items-start gap-3">
                  <div className="w-2 h-2 rounded-full bg-slate-300 mt-1.5 flex-shrink-0" style={
                    idx === 0 && !isDelivered
                      ? { backgroundColor: '#2563eb' }
                      : e.code === 'DELIVERED'
                      ? { backgroundColor: '#10b981' }
                      : e.code === 'EXCEPTION'
                      ? { backgroundColor: '#f43f5e' }
                      : undefined
                  } />
                  <div className="flex-1 min-w-0">
                    <div className="text-md text-slate-900 dark:text-slate-100">
                      {EVENT_LABEL_IT[e.code] ?? e.description}
                    </div>
                    {e.location && (
                      <div className="text-sm text-slate-500 dark:text-slate-400">{e.location}</div>
                    )}
                    <div className="text-xs text-slate-400 dark:text-slate-500 tabular-nums">
                      {new Date(e.occurredAt).toLocaleString('it-IT', {
                        day: 'numeric',
                        month: 'short',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </div>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </div>

        <div className="text-center text-xs text-slate-400 dark:text-slate-500">
          Hai domande? Scrivi a{' '}
          <a href="mailto:support@xavia.it" className="text-blue-600 dark:text-blue-400 hover:underline">
            support@xavia.it
          </a>
        </div>
      </div>
    </div>
  )
}

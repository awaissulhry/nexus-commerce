'use client'

/** The family endpoint is the only source of variant projections. */
import { useCallback, useEffect, useRef, useState } from 'react'

import { isProjectionState, type ProjectionState } from '@/design-system/grid/renderers/projection'
import { getBackendUrl } from '@/lib/backend-url'

import {
  EMPTY_PROJECTIONS,
  type FamilyProjections,
} from './projections'

export interface UseFamilyProjections {
  projections: FamilyProjections
  loading: boolean
  error: string | null
  reload: () => void
}

/**
 * §5.1's response, narrowed to what this consumes. VP.2 owns the rest.
 *
 * 🔴 `projections[].state` arrives ALREADY in VP.2's own vocabulary (`listed` on the live rows,
 * measured on GALE-JACKET), which is the same five-word set VP.5's `projectionMeta` names. It is
 * still PARSED rather than cast — `isProjectionState` decides, and anything else falls back to the
 * flags, because a wire value that drifts must not be able to paint a green dot.
 */
interface StudioFamilyResponse {
  version: number
  channels?: Array<{ channel: string; market: string; connected: boolean; label: string; accountId: string | null }>
  axes?: Array<{ key: string; label?: string; storedKey?: string; valueOrder?: { codes: string[] }; values?: Array<string | { code?: string }> }>
  parent?: {
    id: string
    image?: string | null
    projections?: Record<string, { externalId?: string | null; listings?: number; state?: string; included?: boolean; published?: boolean }>
  }
  children?: Array<{
    id: string
    image?: string | null
    imageInherited?: boolean
    axisValuesSuspect?: Array<{ axisKey: string; reason: string }>
    axisValues?: Record<string, string | null>
    projections?: Record<string, { included?: boolean; state?: string; externalId?: string | null; published?: boolean }>
  }>
}

export function useFamilyProjections(
  productId: string,
  market: string | null,
  locale?: string,
): UseFamilyProjections {
  const [projections, setProjections] = useState<FamilyProjections>(EMPTY_PROJECTIONS)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)
  const request = useRef(0)

  useEffect(() => {
    if (!productId || !market) return
    const mine = ++request.current
    const abort = new AbortController()
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(30_000)])
    setLoading(true)
    setError(null)

    const backend = getBackendUrl()
    const studioUrl = `${backend}/api/products/${encodeURIComponent(productId)}/studio/family?market=${encodeURIComponent(market)}${locale ? `&locale=${encodeURIComponent(locale)}` : ''}`

    const load = async (): Promise<FamilyProjections> => {
      const studio = await fetch(studioUrl, { credentials: 'include', cache: 'no-store', signal })
      if (studio.ok) return fromStudio((await studio.json()) as StudioFamilyResponse)
      const body = await studio.json().catch(() => null)
      throw new Error(body?.message || body?.error || `Family read refused (HTTP ${studio.status})`)
    }

    void load()
      .then((next) => { if (mine === request.current) setProjections(next) })
      .catch((e: unknown) => {
        if (mine !== request.current) return
        if (abort.signal.aborted) return
        setError(e instanceof Error ? e.message : String(e))
        /* 🔴 Cleared, not left stale. A failed reload that kept the previous answer would draw a
           projection column that is no longer known to be true, beside an error nobody must ignore. */
        setProjections(EMPTY_PROJECTIONS)
      })
      .finally(() => { if (mine === request.current) setLoading(false) })

    return () => { abort.abort() }
  }, [productId, market, locale, nonce])

  const reload = useCallback(() => setNonce((n) => n + 1), [])
  return { projections, loading, error, reload }
}

/** Map §5.1's response onto the internal shape. The studio branch states, it does not infer. */
function fromStudio(body: StudioFamilyResponse): FamilyProjections {
  const channels = (body.channels ?? []).map((c) => ({
    channel: c.channel.toUpperCase(),
    market: c.market.toUpperCase(),
    label: c.label,
    connected: c.connected,
    accountId: c.accountId,
    key: `${c.channel.toUpperCase()}:${c.market.toUpperCase()}`,
  }))
  const byProduct: Record<string, Record<string, ReturnType<typeof rowOf>>> = {}
  const axisValues: Record<string, Record<string, string>> = {}
  const suspect: Record<string, Array<{ axisKey: string; reason: string }>> = {}
  const images: Record<string, { url: string | null; inherited: boolean }> = {}
  const listingsPerChannel: Record<string, number> = {}
  for (const channel of channels) listingsPerChannel[channel.key] = body.parent?.projections?.[channel.key]?.listings ?? 0
  for (const child of body.children ?? []) {
    const mine: Record<string, ReturnType<typeof rowOf>> = {}
    for (const channel of channels) {
      const p = child.projections?.[channel.key]
      if (p) mine[channel.key] = rowOf(p)
    }
    byProduct[child.id] = mine
    /* Only real values are carried across. A `null` axis value is an ABSENT one, and writing it in
       as the string "null" is how an empty cell starts reading as a filled one. */
    const mineAxes: Record<string, string> = {}
    for (const [key, value] of Object.entries(child.axisValues ?? {})) {
      if (typeof value === 'string' && value.trim()) mineAxes[key] = value
    }
    axisValues[child.id] = mineAxes
    suspect[child.id] = child.axisValuesSuspect ?? []
    if (child.image) images[child.id] = { url: child.image, inherited: child.imageInherited === true }
  }
  const axes = (body.axes ?? []).map(a => ({
    key: a.key,
    label: a.label ?? a.key,
    storedKey: a.storedKey,
    valueOrder: a.valueOrder?.codes,
    values: (a.values ?? []).map(v => (typeof v === 'string' ? v : v?.code ?? '')).filter(Boolean),
  }))
  if (body.parent) {
    const mine: Record<string, ReturnType<typeof rowOf>> = {}
    for (const channel of channels) {
      const p = body.parent.projections?.[channel.key]
      if (p) mine[channel.key] = rowOf({ ...p, included: p.included ?? true })
    }
    byProduct[body.parent.id] = mine
    /* The parent's own picture. `inherited: false` by construction — a parent's image is nobody
       else's, and marking it inherited would put a provenance glyph on the one row that owns it. */
    if (body.parent.image) images[body.parent.id] = { url: body.parent.image, inherited: false }
  }
  return { source: 'studio', version: body.version, suspect, channels, byProduct, listingsPerChannel, axes, axisValues, images }
}

function rowOf(p: { included?: boolean; state?: string; externalId?: string | null; published?: boolean }) {
  return {
    included: p.included !== false,
    /* VP.2 states `listed` where the sheet's row vocabulary would say `live`; both mean published.
       Read BOTH rather than one, so this does not go quiet if the field is renamed on either side. */
    published: p.published === true || p.state === 'live' || p.state === 'listed',
    state: asState(p.state),
    projectionState: isProjectionState(p.state?.replace(/_/g, '-')) ? p.state!.replace(/_/g, '-') as ProjectionState : undefined,
    externalId: p.externalId ?? null,
  }
}

const ROW_STATES = new Set(['ready', 'missing', 'errors', 'live', 'unlisted'])
function asState(state: unknown) {
  return typeof state === 'string' && ROW_STATES.has(state) ? (state as 'ready' | 'missing' | 'errors' | 'live' | 'unlisted') : null
}

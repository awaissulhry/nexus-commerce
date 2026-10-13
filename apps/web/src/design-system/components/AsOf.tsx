'use client'

import { ago, when } from '../grid/renderers/format'
import { useHydrated } from './useHydrated'
export interface AsOfProps {
  at: string | null
  /** Omit when the caller has no provenance axis; explicit null means the source is unknown. */
  via?: string | null
  kind?: 'check' | 'event'
  /** Pass the read's clock for a stable server/client render. No freshness timeout is invented. */
  now?: number
}

/** An absent observation is not a measured empty value. */
export function AsOf({ at, via, kind = 'check', now }: AsOfProps) {
  // The viewer's locale/timezone exists only in the browser. ISO is truthful and identical
  // on the server and first hydration render; localized words replace it after hydration.
  const hydrated = useHydrated()
  if (at == null) return <span className="nds-as-of">{kind === 'event' ? 'never' : 'not checked'}</span>
  if (via === null || !Number.isFinite(Date.parse(at))) return <span className="nds-as-of">not checked</span>
  return <time className="nds-as-of" dateTime={at} title={`${hydrated ? when(at) : at}${via ? ` · ${via}` : ''}`}>
    {hydrated ? ago(at, now) : at}{via ? ` · ${via}` : ''}
  </time>
}

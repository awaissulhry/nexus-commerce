'use client'

import { useSyncExternalStore } from 'react'
import { ago, when } from '../grid/renderers/format'
export interface AsOfProps {
  at: string | null
  /** Omit when the caller has no provenance axis; explicit null means the source is unknown. */
  via?: string | null
  kind?: 'check' | 'event'
  /** Pass the read's clock for a stable server/client render. No freshness timeout is invented. */
  now?: number
}
const subscribe = () => () => {}
const clientSnapshot = () => true
const serverSnapshot = () => false

/** An absent observation is not a measured empty value. */
export function AsOf({ at, via, kind = 'check', now }: AsOfProps) {
  // The viewer's locale/timezone exists only in the browser. ISO is truthful and identical
  // on the server and first hydration render; localized words replace it after hydration.
  const hydrated = useSyncExternalStore(subscribe, clientSnapshot, serverSnapshot)
  if (at == null) return <span className="nds-as-of">{kind === 'event' ? 'never' : 'not checked'}</span>
  if (via === null || !Number.isFinite(Date.parse(at))) return <span className="nds-as-of">not checked</span>
  return <time className="nds-as-of" dateTime={at} title={`${hydrated ? when(at) : at}${via ? ` · ${via}` : ''}`}>
    {hydrated ? ago(at, now) : at}{via ? ` · ${via}` : ''}
  </time>
}

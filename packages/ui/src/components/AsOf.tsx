'use client'

import { mergeLabels } from '../lib/labels'
import { AS_OF_LABELS, type AsOfLabels } from './AsOfLabels'
import { useHydrated } from './useHydrated'
export interface AsOfProps {
  at: string | null
  /** Omit when the caller has no provenance axis; explicit null means the source is unknown. */
  via?: string | null
  kind?: 'check' | 'event'
  /** Pass the read's clock for a stable server/client render. No freshness timeout is invented. */
  now?: number
  /** Its words in the person's language (B-W2b-04): the empty words and the `ago` / `when` writers. Default English. */
  labels?: Partial<AsOfLabels>
}

/** An absent observation is not a measured empty value. */
export function AsOf({ at, via, kind = 'check', now, labels }: AsOfProps) {
  const words = mergeLabels(AS_OF_LABELS, labels)
  // The viewer's locale/timezone exists only in the browser. ISO is truthful and identical
  // on the server and first hydration render; localized words replace it after hydration.
  const hydrated = useHydrated()
  if (at == null) return <span className="nds-as-of">{kind === 'event' ? words.never : words.notChecked}</span>
  if (via === null || !Number.isFinite(Date.parse(at))) return <span className="nds-as-of">{words.notChecked}</span>
  return <time className="nds-as-of" dateTime={at} title={`${hydrated ? words.when(at) : at}${via ? ` · ${via}` : ''}`}>
    {hydrated ? words.ago(at, now) : at}{via ? ` · ${via}` : ''}
  </time>
}

'use client'

import { useMemo, type ReactNode } from 'react'
import { useT } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import type { Words } from '../../_shared/model'
import { useWords } from '../../_shared/parts'
import type { Translate } from './model'
import './depth.css'

export { CabinetQr as TagQr } from '../../../../lib/chemicals/marks'

/**
 * The words of machines in depth (B-W2b-136): the catalogue `plant-machines` beside the plant's own (`plant`, which the
 * W2a pages and the shared parts speak). A Words key that starts with `depth:` is this catalogue's; any other is the
 * plant's (its refusals and problems).
 */

export function DepthMessages({ children }: { children?: ReactNode }) {
  return <WithMessages namespaces={['plant-machines']}>{children}</WithMessages>
}

export function useDepthWords(): Translate {
  const t = useT('plant-machines')
  return useMemo<Translate>(() => (key, params) => t(key, params), [t])
}

/** Says Words from either catalogue. */
export function useSay(): (words: Words | null | undefined) => string | null {
  const t = useDepthWords()
  const plant = useWords()
  return useMemo(() => (words: Words | null | undefined) => (words ? (words.key.startsWith('depth:') ? t(words.key.slice('depth:'.length), words.params) : plant(words.key, words.params)) : null), [t, plant])
}

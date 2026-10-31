'use client'

import type { ReactNode } from 'react'
import { useT } from '../../../../lib/i18n/provider'
import { PHOTO_KIT_NAMESPACE } from '../../../../lib/ds-words/photo-capture'
import { StockMessages } from '../../../_shared/stock/parts'
import type { Phrase } from '../../../_shared/stock/model'
import { DAILY_NAMESPACE } from './model'
import './daily.css'

/** The every-day dialogs speak `warehouse-daily` beside the shared `stock` words (and the photo kit's). */
export function DailyMessages({ children }: { children?: ReactNode }) {
  return <StockMessages extra={[DAILY_NAMESPACE, PHOTO_KIT_NAMESPACE]}>{children}</StockMessages>
}

/** A phrase in words: the shared `problem.*` / `held.*` / `common.*` keys are `stock`'s, the rest `warehouse-daily`'s. */
export function useSay(): (words: Phrase | null | undefined) => string {
  const t = useT(DAILY_NAMESPACE)
  const s = useT('stock')
  return (words) => {
    if (!words) return ''
    return /^(problem|held|common)\./.test(words.key) ? s(words.key, words.params) : t(words.key, words.params)
  }
}

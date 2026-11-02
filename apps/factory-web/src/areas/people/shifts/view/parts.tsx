'use client'

import { useMemo, type ReactNode } from 'react'
import { Banner } from '@nexus/ui/components'
import { Button } from '@nexus/ui/primitives'
import { useT } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import type { Notice } from '../../_shared/parts'
import type { Words } from '../model'
import '../shifts.css'

/** The catalogues of the Shifts pages: their own, People's shared words (the privacy note, the keys list), the list frame's. */
export const SHIFT_NAMESPACES = ['shifts', 'people', 'lists'] as const

export function ShiftMessages({ children }: { children?: ReactNode }) {
  return <WithMessages namespaces={SHIFT_NAMESPACES}>{children}</WithMessages>
}

export type ShiftWords = (key: string, params?: Readonly<Record<string, string | number>>) => string

export function useShiftWords(): ShiftWords {
  const t = useT('shifts')
  return useMemo<ShiftWords>(() => (key, params) => t(key, params), [t])
}

/** Words in the page's language, a plain string as it is (a shift's own name). */
export const said = (t: ShiftWords, words: Words | string | null | undefined): string => (typeof words === 'string' ? words : words ? t(words.key, words.params) : '')

/** The page's one notice, in this page's words. */
export function ShiftNotice({ notice, onDismiss }: { notice: Notice | null; onDismiss?: (() => void) | undefined }) {
  const t = useShiftWords()
  if (!notice) return null
  return (
    <Banner
      tone={notice.tone}
      title={said(t, notice.words)}
      action={
        onDismiss ? (
          <Button size="sm" variant="quiet" onClick={onDismiss}>
            {t('common.close')}
          </Button>
        ) : undefined
      }
    >
      {notice.detail ? said(t, notice.detail) : null}
    </Banner>
  )
}

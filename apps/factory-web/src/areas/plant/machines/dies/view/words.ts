'use client'

import { useMemo } from 'react'
import { useT } from '../../../../../lib/i18n/provider'
import type { Translate } from '../../../_shared/parts'
import type { DieWords } from '../model'

/** The clicking-die register's catalogue (`messages/<locale>/plant-dies.json`), added inside the plant's by the view. */
export const DIES_NAMESPACES = ['plant-dies'] as const

/** The section's words (`plant-dies`). */
export function useDieWords(): Translate {
  const t = useT('plant-dies')
  return useMemo<Translate>(() => (key, params) => t(key, params), [t])
}

export const sayDie = (t: Translate, words: DieWords | null | undefined): string | null => (words ? t(words.key, words.params) : null)

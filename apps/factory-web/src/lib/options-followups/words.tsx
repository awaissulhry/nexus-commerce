'use client'

import { useCallback, type ReactNode } from 'react'
import { useLocale, useT } from '../i18n/provider'
import { WithMessages } from '../../record-panels/i18n'

/**
 * The options follow-ups' catalogue (B-W2b-374; `messages/<locale>/options-followups.json`): a typed line's options, the
 * portal share of an order line's artwork, the customer's Options and artwork in the portal, what a group takes, the paste's
 * Options column. Each part brings it with `FollowupsMessages` (the layouts load `shell` only).
 */

export const FOLLOWUPS_NS = 'options-followups'

/** Words of this catalogue, or { it, en } words the API gives (a rule, a check). */
export type FollowupsSay = { key: string; params?: Record<string, string | number> } | { words: { it: string; en: string } }

export function FollowupsMessages({ children, also = [] }: { children?: ReactNode; also?: readonly string[] }) {
  return <WithMessages namespaces={[FOLLOWUPS_NS, ...also]}>{children}</WithMessages>
}

export function useFollowupsWords() {
  const t = useT(FOLLOWUPS_NS)
  const lang: 'it' | 'en' = useLocale() === 'it' ? 'it' : 'en'
  const say = useCallback((words: FollowupsSay | null | undefined): string => (!words ? '' : 'words' in words ? words.words[lang] || words.words.en : t(words.key, words.params)), [t, lang])
  return { t, say, lang }
}

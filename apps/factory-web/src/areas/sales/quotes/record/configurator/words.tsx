'use client'

import { useCallback, type ReactNode } from 'react'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { CONFIGURATOR_NS, langOf, wordsIn, type Say } from './model'

/** This step's catalogue (the line drawer, the order's line dialog and the Options page's bench speak it). */
export function ConfiguratorMessages({ children }: { children?: ReactNode }) {
  return <WithMessages namespaces={[CONFIGURATOR_NS]}>{children}</WithMessages>
}

/** The catalogue's translator and `say` for a Say (this catalogue's key, or { it, en } words in the page's language). */
export function useConfiguratorWords() {
  const t = useT(CONFIGURATOR_NS)
  const lang = langOf(useLocale())
  const say = useCallback((words: Say | null | undefined): string => (!words ? '' : 'words' in words ? wordsIn(words.words, lang) : t(words.key, words.params)), [t, lang])
  return { t, say, lang }
}

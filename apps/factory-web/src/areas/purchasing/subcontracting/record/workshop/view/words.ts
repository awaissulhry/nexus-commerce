'use client'

import { useT } from '../../../../../../lib/i18n/provider'
import { say, type Words } from '../../../model'
import { scrapReasonKey, STANDARD_SCRAP } from '../model'

/** The panel's own words (`subcontract-workshop`), with nested `@key` parameters. */
export function useWords() {
  const t = useT('subcontract-workshop')
  return { t, sayWords: (value: Words) => say(t, value) }
}

/** A scrap reason's words: ours for the standard codes, else the code as given. */
export function useScrapWords() {
  const { t } = useWords()
  return (code: string | null) => (code === null ? '' : (STANDARD_SCRAP as readonly string[]).includes(code) ? t(scrapReasonKey(code)) : code)
}

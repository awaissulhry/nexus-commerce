'use client'

import { useMemo } from 'react'
import { CATALOGUE, createTranslator, type Translate } from '../i18n/messages'
import { useLocale } from '../i18n/provider'
import { NS } from './intake'

/**
 * The `safety-reports` words where a host's catalogue provider does not hold them (B-W2b-357: the PPE register's ⋯ › Accident
 * log is drawn inside the register's own words): straight from the catalogue in the page's language.
 */
export function useSafetyWords(): Translate {
  const locale = useLocale()
  return useMemo(() => createTranslator(locale, CATALOGUE[locale]?.[NS] ?? {}), [locale])
}

/** The register header's ⋯ › Accident log (design compliance.register page.h "Accident log (W2b)"): its address, held without the right. */
export interface AccidentLogLink {
  readonly href: string
  /** The person may not read product-safety reports (sales.safety.view): the item says so. */
  readonly held: boolean
}

export const accidentLogLink = (prefix: string, permissions: readonly string[]): AccidentLogLink => ({ href: `${prefix}/compliance/register/accidents`, held: !permissions.includes('sales.safety.view') })

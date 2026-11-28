'use client'

import { useMemo, type ReactElement } from 'react'
import Link from 'next/link'
import { ArrowUpRight } from 'lucide-react'
import { catalogueFor, createTranslator } from '../../../../lib/i18n/messages'
import { useLocale, useReader } from '../../../../lib/i18n/provider'
import { STRUCTURE_NS, structureHref } from '../model'

/**
 * owb-ss8 (8.2; the brief's "the team window under People ONLY to open the new shared profile") — "Open the profile" of a team in
 * People › Factory structure (`?unit=<team id>`), for a page that does not load the structure's catalogue (Employees › Teams' window):
 * its one word is read straight from the catalogue, as the window shell reads its own.
 */
export function OpenProfileLink({ prefix, unitId }: { prefix: string; unitId: string }): ReactElement {
  const locale = useLocale()
  const reader = useReader()
  const t = useMemo(() => createTranslator(locale, catalogueFor(locale, STRUCTURE_NS, reader)), [locale, reader])
  return (
    <Link className="nds-btn sm" href={structureHref(`${prefix}/people/structure`, { unit: unitId })}>
      <ArrowUpRight size={14} aria-hidden />
      {t('profile.open')}
    </Link>
  )
}

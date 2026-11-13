'use client'

import { useId } from 'react'
import { Tag } from '@nexus/ui/primitives'
import { Combobox } from '../../../../../lib/i18n/ds-parts'
import type { PartyOption, ProfileRow } from '../../api'
import { useExtras } from '../../photos/words'
import { rangeTone, rangeWords } from '../model'

/**
 * The made-to-measure list's own parts (B-W2b-371, XF2:03): the row's certified range (Inside · Outside with its points · Not
 * checked, in words with its tone, never colour alone) and the customer filter (design Rows ▾ "By customer": a customer of those
 * the person reads, typed to narrow; "All customers" clears it). Fetches nothing.
 */
export function RangeCell({ range }: { range: ProfileRow['range'] }) {
  const { t, say } = useExtras()
  return (
    <span title={t('list.range.hint')}>
      <Tag tone={rangeTone(range)}>{say(rangeWords(range))}</Tag>
    </span>
  )
}

export function CustomerFilter({ customers, value, onChange }: { customers: readonly PartyOption[] | null; value: string | null; onChange: (partyId: string | null) => void }) {
  const { t } = useExtras()
  const labelId = useId()
  if (!customers) return null
  return (
    <span className="fw-mtx-customer">
      <span id={labelId} className="fw-mtx-hidden">
        {t('list.customer.label')}
      </span>
      <Combobox
        labelledBy={labelId}
        options={[{ value: '', label: t('list.customer.all') }, ...customers.map((party) => ({ value: party.id, label: `${party.legalName} · ${party.code}` }))]}
        value={value ?? ''}
        onChange={(next) => onChange(next || null)}
        placeholder={t('list.customer.placeholder')}
      />
    </span>
  )
}

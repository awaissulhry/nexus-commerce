'use client'

import { useCallback } from 'react'
import { Users } from 'lucide-react'
import { EmptyState } from '@nexus/ui/components'
import { Select } from '@nexus/ui/primitives'
import { useProductionWords } from '../../../../../lib/production/words'
import { customerText, filterChoices, type CustomerFilterState, type RowCustomer } from '../model'

/**
 * F-PR-02 — the Production pages' ONE customer filter (06-tree A.0; L27 "Customer filter"): a DS Select in the page's toolbar —
 * "All customers" (or "All my customers" for a person limited to some), then the customers the API gave for this page. A
 * customer the address names that is not among them reads "Not in your customers" (nothing says another customer exists).
 * Words from the `production` catalogue (`customer.*`), read straight from it like the other production parts.
 */
export function CustomerFilter({ state, onPick }: { state: CustomerFilterState; onPick?: (party: string | null) => void }) {
  const { t } = useProductionWords()
  // A person who reaches one customer only and is narrowed to none needs no filter: every row is theirs already.
  if (state.options !== null && state.options.length <= 1 && state.everyCustomer === false && !state.party) return null
  return (
    <Select size="sm" aria-label={t('customer.filter')} value={state.party ?? ''} onChange={(event) => onPick?.(event.target.value || null)} disabled={state.options === null && !state.party}>
      {filterChoices(state).map((choice) => (
        <option key={choice.value || 'all'} value={choice.value}>
          {choice.key ? t(`customer.${choice.key}`) : choice.label}
        </option>
      ))}
    </Select>
  )
}

/** A Customer cell's words: the customer (name or code), "Mixed customers (made before the rule)", or "—". */
export function useCustomerCell(names: boolean): (row: RowCustomer) => string {
  const { t } = useProductionWords()
  return useCallback(
    (row: RowCustomer) => {
      const said = customerText(row, names)
      return said === null ? '—' : said.mixed ? t('customer.mixed') : said.text
    },
    [t, names],
  )
}

/**
 * The honest words where a view adds up every customer and the person reaches only some (403 EVERY_PARTY, B-PR-07): never an
 * empty table that pretends there is nothing.
 */
export function EveryCustomerNotice({ compact = false }: { compact?: boolean }) {
  const { t } = useProductionWords()
  if (compact) return <p className="fw-pr-hint">{t('customer.every')}</p>
  return <EmptyState icon={<Users size={20} aria-hidden />} title={t('customer.everyTitle')} description={t('customer.every')} />
}

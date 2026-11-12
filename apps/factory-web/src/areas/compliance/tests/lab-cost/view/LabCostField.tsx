'use client'

import type { ColDef } from '@nexus/ui/grid'
import { Field } from '@nexus/ui/components'
import { Input, Select } from '@nexus/ui/primitives'
import type { Locale } from '../../../../../lib/i18n/locales'
import { useT } from '../../../../../lib/i18n/provider'
import { LAB_COST_NAMESPACE, LAB_CURRENCIES, lotCostWords, type LabCostDraft, type LabCostSum } from '../lab-cost'

/**
 * The lab's price typed with a result (B-W2b-288, FU2:03; money.cost): an amount and its currency, optional. The Record test
 * result dialog draws it only for a person with the cost grain; a wrong amount says so here and holds Save.
 */
export function LabCostField({ value, onChange, problem }: { value: LabCostDraft; onChange: (next: LabCostDraft) => void; problem: string | null }) {
  const w = useT(LAB_COST_NAMESPACE)
  return (
    <Field label={w('labCost.field')} hint={w('labCost.fieldHint')} error={problem ? w(problem) : undefined}>
      <span className="fw-q-cell-row">
        <Input inputMode="decimal" value={value.text} aria-label={w('labCost.amount')} placeholder="0,00" maxLength={14} onChange={(event) => onChange({ ...value, text: event.target.value })} />
        <Select value={value.currency} aria-label={w('labCost.currency')} onChange={(event) => onChange({ ...value, currency: event.target.value })}>
          {LAB_CURRENCIES.map((code) => (
            <option key={code} value={code}>
              {code}
            </option>
          ))}
        </Select>
      </span>
    </Field>
  )
}

/** The Lot tests list's "Lab cost" column (the sum of the lot's lab prices per currency; "—" without one). */
export function labCostColumn<Row extends { readonly labCost?: readonly LabCostSum[] | undefined }>(header: string, locale: Locale): ColDef<Row> {
  return { colId: 'labCost', headerName: header, sortable: false, flex: 0.9, minWidth: 130, type: 'rightAligned', valueGetter: (params) => (params.data ? (lotCostWords(params.data.labCost, locale) ?? '—') : '') }
}

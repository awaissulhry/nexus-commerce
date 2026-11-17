'use client'

import { useId } from 'react'
import { Lock, X } from 'lucide-react'
import { Button, Input, Select } from '@nexus/ui/primitives'
import { useT } from '../../../i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import { AMOUNT_CURRENCIES, amountProblem } from '../amount'
import { HELPERS_NS } from './MentionInput'
import '../helpers.css'

/**
 * B-TH-236 (B-TH-049, T8-F04; picture 6 "the amount field for a money reader and the same box without it"): the price in its own
 * field on an office note — the amount, its currency, and the line that says who reads it (people who see prices; never the
 * customer, a link or the floor). Drawn only for a person holding the price grain; × takes it off. Draws its value only.
 */
export interface AmountFieldProps {
  value: string
  currency: string
  forFloor: boolean
  onChange: (next: { amount: string; currency: string }) => void
  onRemove: () => void
}

export function AmountField(props: AmountFieldProps) {
  return (
    <WithMessages namespaces={[HELPERS_NS]}>
      <Field {...props} />
    </WithMessages>
  )
}

function Field({ value, currency, forFloor, onChange, onRemove }: AmountFieldProps) {
  const t = useT(HELPERS_NS)
  const id = useId()
  const problem = amountProblem(value, { forFloor })
  return (
    <div className="fw-rtm-amount" role="group" aria-labelledby={`${id}-label`}>
      <span id={`${id}-label`} className="fw-rtm-amount-label">
        <Lock size={12} aria-hidden /> {t('amount.label')}
      </span>
      <Input
        size="sm"
        fieldClassName="fw-rtm-amount-value"
        value={value}
        inputMode="decimal"
        autoComplete="off"
        placeholder={t('amount.placeholder')}
        aria-label={t('amount.label')}
        aria-invalid={problem ? true : undefined}
        aria-describedby={`${id}-hint`}
        onChange={(event) => onChange({ amount: event.target.value, currency })}
      />
      <Select size="sm" value={currency} aria-label={t('amount.currency')} onChange={(event) => onChange({ amount: value, currency: event.target.value })}>
        {AMOUNT_CURRENCIES.map((code) => (
          <option key={code} value={code}>
            {code}
          </option>
        ))}
      </Select>
      <Button size="sm" variant="quiet" aria-label={t('amount.remove')} onClick={onRemove}>
        <X size={13} aria-hidden />
      </Button>
      <p id={`${id}-hint`} className={`fw-rtm-amount-hint${problem ? ' is-problem' : ''}`}>
        {problem ? t(problem.key, problem.params) : t('amount.hint')}
      </p>
    </div>
  )
}

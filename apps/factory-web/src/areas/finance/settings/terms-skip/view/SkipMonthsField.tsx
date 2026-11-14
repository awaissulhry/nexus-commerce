'use client'

import { Checkbox } from '@nexus/ui/primitives'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { DEPTH, DEPTH_NAMESPACES } from '../../../invoices/test-mode/depth'
import { conventionsText, monthOf, MONTHS, skipProblem, toggleMonth } from '../model'
import '../skip.css'

export interface SkipMonthsModel {
  fromEndOfMonth: boolean
  skipMonths: number[]
  readOnly: boolean
}

/**
 * The terms dialog's Italian due-date conventions (design finance.settings sec:terms "skip August (W2b)"; FIN-076): the
 * days counted from the end of the event's month ("30 gg f.m."), and the months no instalment falls due in ("escluso
 * agosto": the due day moves to the same day of the next month not skipped, the end of the month when it was one) — the
 * rule waits for the accountant (said), the words the documents print below, live. At most 11 months.
 */
export function SkipMonthsField({ model, onChange }: { model: SkipMonthsModel; onChange?: (patch: Partial<Pick<SkipMonthsModel, 'fromEndOfMonth' | 'skipMonths'>>) => void }) {
  return (
    <WithMessages namespaces={DEPTH_NAMESPACES}>
      <Field model={model} onChange={onChange} />
    </WithMessages>
  )
}

function Field({ model, onChange }: { model: SkipMonthsModel; onChange?: (patch: Partial<Pick<SkipMonthsModel, 'fromEndOfMonth' | 'skipMonths'>>) => void }) {
  const w = useT(DEPTH)
  const locale = useLocale()
  const problem = skipProblem(model.skipMonths)
  const words = conventionsText(model, locale)
  return (
    <fieldset className="fw-fin-choices">
      <legend className="fw-fin-legend">{w('skip.legend')}</legend>
      <Checkbox checked={model.fromEndOfMonth} disabled={model.readOnly} onChange={(event) => onChange?.({ fromEndOfMonth: event.target.checked })} label={w('skip.fromEndOfMonth')} />
      <span className="fw-fin-hint">{w('skip.monthsLabel')}</span>
      <div className="fw-skip-months" role="group" aria-label={w('skip.monthsLabel')}>
        {MONTHS.map((month) => (
          <Checkbox key={month} checked={model.skipMonths.includes(month)} disabled={model.readOnly} onChange={(event) => onChange?.({ skipMonths: toggleMonth(model.skipMonths, month, event.target.checked) })} label={monthOf(month, locale)} />
        ))}
      </div>
      {problem && (
        <p className="fw-fin-hint" role="alert">
          {w(problem)}
        </p>
      )}
      <p className="fw-fin-hint">{words ? w('skip.printed', { words }) : w('skip.none')}</p>
      <p className="fw-fin-hint">{w('skip.rule')}</p>
    </fieldset>
  )
}

'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { newIdempotencyKey } from '../../../../../lib/api/client'
import { formatDate } from '../../../../../lib/i18n/format'
import { useLocale } from '../../../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../../../lib/session/context'
import { useCoalesced, useLive } from '../../../_shared/hooks'
import { applyCalc, createCalc, listCalcs, listOverheadRules, prefill, removeCalc, type CalcView, type OverheadRuleView, type PrefillView } from './api'
import { calcBody, cpmAbilitiesOf, cpmProblem, cpmReadProblem, cpmTouched, monthLast, monthStart, type CalcDraft } from './model'
import { CalculatorCard, type CalcDialog, type CalculatorModel } from './view/CalculatorCard'

type Read<T> = { status: 'loading' } | { status: 'ready'; value: T } | { status: 'error'; problem: string }

/** Today in the site's zone (Europe/Rome), YYYY-MM-DD: an applied rate starts today or later. */
const siteToday = (): string => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())

/**
 * Finance › Settings › Costing › cost per minute and overhead (B-W2b-430), the container Finance settings slots for the company
 * shown: reads the company's calculations and the overhead rules in force, reads a department's minutes for a period on ask
 * (the prefill), keeps a calculation (with the prefill's minutes basis), applies one as the department's labour rate from a
 * day, removes one while not applied — each with an Idempotency-Key and the row's version — and reads again on a live change.
 */
export function CostPerMinute({ companyId }: { companyId: string }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const locale = useLocale()
  const can = useMemo(() => cpmAbilitiesOf(session.permissions), [session.permissions])
  const [calcs, setCalcs] = useState<Read<readonly CalcView[]>>({ status: 'loading' })
  const [rules, setRules] = useState<Read<readonly OverheadRuleView[]>>({ status: 'loading' })
  const [dialog, setDialog] = useState<CalcDialog | null>(null)
  const [prefilled, setPrefilled] = useState<Read<PrefillView> | null>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [notice, setNotice] = useState<CalculatorModel['notice']>(null)
  const attempt = useRef<string | null>(null)
  const today = siteToday()

  const read = useCallback(async () => {
    if (!can.view) return
    await Promise.all([
      listCalcs(api, companyId)
        .then((value) => setCalcs({ status: 'ready', value }))
        .catch((error: unknown) => setCalcs({ status: 'error', problem: cpmReadProblem(error) })),
      listOverheadRules(api, companyId)
        .then((value) => setRules({ status: 'ready', value }))
        .catch((error: unknown) => setRules({ status: 'error', problem: cpmReadProblem(error) })),
    ])
  }, [api, can.view, companyId])

  useEffect(() => {
    setCalcs({ status: 'loading' })
    setRules({ status: 'loading' })
    void read()
  }, [read])
  const reread = useCoalesced(() => void read(), 800)
  useLive(
    (change) => {
      if (cpmTouched(change)) reread()
    },
    () => reread(),
    can.view,
  )

  const write = async (work: (key: string) => Promise<unknown>, done: CalculatorModel['notice']) => {
    if (busy) return
    attempt.current ??= newIdempotencyKey()
    const key = attempt.current
    setBusy(true)
    setProblem(null)
    try {
      await work(key)
      attempt.current = null
      setDialog(null)
      setPrefilled(null)
      setNotice(done)
      await read()
    } catch (error) {
      setProblem(cpmProblem(error))
    } finally {
      setBusy(false)
    }
  }

  const currency = prefilled?.status === 'ready' ? prefilled.value.currency : calcs.status === 'ready' ? (calcs.value[0]?.currency ?? null) : null
  const model: CalculatorModel = { can, today, currency, calcs, rules, dialog, prefill: prefilled, busy, problem, notice }

  return (
    <CalculatorCard
      model={model}
      actions={{
        onDialog: (next) => {
          attempt.current = null
          setProblem(null)
          setPrefilled(null)
          setDialog(next)
        },
        onPrefill: (draft: CalcDraft) => {
          setPrefilled({ status: 'loading' })
          prefill(api, { companyId, workCentreKind: draft.workCentreKind, ...(draft.workCentreId ? { workCentreId: draft.workCentreId } : {}), periodStart: monthStart(draft.fromMonth), periodEnd: monthLast(draft.toMonth) })
            .then((value) => setPrefilled({ status: 'ready', value }))
            .catch((error: unknown) => setPrefilled({ status: 'error', problem: cpmProblem(error) }))
        },
        onCreate: (draft) => void write((key) => createCalc(api, calcBody(draft, companyId, prefilled?.status === 'ready' ? prefilled.value : null), key), { key: 'cpm.notice.kept' }),
        onApply: (calc, input) =>
          void write(
            (key) =>
              applyCalc(
                api,
                calc,
                { validFrom: input.validFrom, ...(input.efficiency.trim() ? { plannedEfficiencyPct: input.efficiency.trim().replace(',', '.') } : {}), ...(input.note.trim() ? { note: input.note.trim() } : {}) },
                key,
              ),
            { key: 'cpm.notice.applied', params: { from: formatDate(`${input.validFrom}T12:00:00Z`, { locale }) } },
          ),
        onRemove: (calc) => void write(() => removeCalc(api, calc), { key: 'cpm.notice.removed' }),
        onRetry: () => {
          setCalcs({ status: 'loading' })
          void read()
        },
        onDismissNotice: () => setNotice(null),
      }}
    />
  )
}

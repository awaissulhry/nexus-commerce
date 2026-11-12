'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocale } from '../../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { romeToday } from '../../costing/model'
import { downloadText, useLive } from '../../_shared/hooks'
import { getCreditLimits, getCustomers, setCreditLimit, type CustomerOption, type LimitRow, type LimitView } from './api'
import { creditCanOf, creditCsv, creditLiveTouches, readProblem } from './model'
import { CreditLimitsView, type CreditLimitsModel } from './view/CreditLimitsView'
import type { ChangeState } from './view/ChangeLimitDialog'

const SLOW_MS = 1000
const SEARCH_MS = 300

/**
 * Finance › Receivables & credit › Credit limits (SCR-151 sec:credit; B-W2b-304): reads `GET /sales/credit/limits` for the
 * address's company (the view and the search; 100 a page with Show more), opens "Change limit" on a row or "Set a limit"
 * (the company's customers read then, `GET /parties?role=CUSTOMER`), saves with `PUT /sales/credit/limits/:party/:company`
 * (its reason; the held orders checked again by the API), exports the chosen rows. Live: credit checks, limits, payments,
 * issued invoices and order moves count behind "N updates · Show". Without sales.credit.view it asks the API nothing.
 */
export function CreditLimits({ prefix }: { prefix: string }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const locale = useLocale()
  const can = useMemo(() => creditCanOf(session.permissions), [session.permissions])
  const companyId = session.company?.id ?? null
  const companyCode = session.company?.code ?? ''
  const [view, setView] = useState<LimitView>('ALL')
  const [q, setQ] = useState<string | null>(null)
  const [state, setState] = useState<Pick<CreditLimitsModel, 'limits' | 'rows' | 'problem' | 'slow'>>({ limits: null, rows: null, problem: null, slow: false })
  const [updates, setUpdates] = useState(0)
  const [change, setChange] = useState<ChangeState | null>(null)
  const [customers, setCustomers] = useState<CustomerOption[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<CreditLimitsModel['notice']>(null)
  // The address asked last, by value (a re-render must not drop the answer of the same question).
  const asked = useRef({ view, q, key: `${view}|${q ?? ''}` })
  asked.current = { view, q, key: `${view}|${q ?? ''}` }

  const load = useCallback(async () => {
    if (!can.view) return
    const target = asked.current
    const slow = setTimeout(() => setState((current) => (current.rows || current.problem ? current : { ...current, slow: true })), SLOW_MS)
    try {
      const limits = await getCreditLimits(api, { companyId, view: target.view, q: target.q })
      if (asked.current.key !== target.key) return
      setState({ limits, rows: limits.rows, problem: null, slow: false })
      setUpdates(0)
    } catch (error) {
      if (asked.current.key === target.key) setState({ limits: null, rows: null, problem: readProblem(error), slow: false })
    } finally {
      clearTimeout(slow)
    }
  }, [api, can.view, companyId])

  useEffect(() => {
    void load()
  }, [load, view, q])

  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const onSearch = (text: string) => {
    if (searchTimer.current) clearTimeout(searchTimer.current)
    searchTimer.current = setTimeout(() => setQ(text.trim() === '' ? null : text.trim()), SEARCH_MS)
  }

  const live = useLive(
    (event) => {
      if (creditLiveTouches(event)) setUpdates((count) => count + 1)
    },
    () => void load(),
    can.view,
  )
  void live

  const more = async () => {
    const next = state.limits?.next
    if (next === null || next === undefined) return
    try {
      const page = await getCreditLimits(api, { companyId, view, q, cursor: next })
      setState((current) => ({ ...current, limits: page, rows: [...(current.rows ?? []), ...page.rows] }))
    } catch (error) {
      setNotice({ tone: 'danger', key: readProblem(error) })
    }
  }

  const openChange = (row: LimitRow | null) => {
    setChange({ row, problem: null })
    if (row === null && customers === null) {
      getCustomers(api, companyId)
        .then(setCustomers)
        .catch(() => setCustomers([]))
    }
  }

  const submit: NonNullable<Parameters<typeof CreditLimitsView>[0]['actions']>['onSubmitChange'] = async (input) => {
    setBusy(true)
    try {
      const answer = await setCreditLimit(api, input.partyId, input.companyId, { ...(input.version !== undefined ? { version: input.version } : {}), amount: input.amount, currency: input.currency, reason: input.reason })
      const name = answer.row?.party.name ?? change?.row?.party.name ?? ''
      setChange(null)
      setNotice(answer.rechecked > 0 ? { tone: 'success', key: answer.rechecked === 1 ? 'change.doneRechecked_one' : 'change.doneRechecked_other', params: { name, count: answer.rechecked } } : { tone: 'success', key: 'change.done', params: { name } })
      await load()
      return true
    } catch (error) {
      setChange((current) => (current ? { ...current, problem: readProblem(error) } : current))
      if (readProblem(error) === 'problem.conflict') await load()
      return false
    } finally {
      setBusy(false)
    }
  }

  const exportRows = (rows: readonly LimitRow[], header: (column: string) => string, fileName: string) => downloadText(`${fileName}.csv`, creditCsv(rows, header, locale))

  const model: CreditLimitsModel = {
    prefix,
    can,
    today: romeToday(),
    view,
    q,
    limits: state.limits,
    rows: state.rows,
    problem: state.problem,
    slow: state.slow,
    updates,
    change,
    customers,
    companyId,
    companyCode,
    notice,
    busy,
  }
  return (
    <CreditLimitsView
      model={model}
      actions={{
        onView: (next) => setView(next),
        onSearch,
        onRetry: () => void load(),
        onMore: () => void more(),
        onShowUpdates: () => void load(),
        onOpenChange: openChange,
        onCloseChange: () => setChange(null),
        onSubmitChange: submit,
        onExport: exportRows,
        onDismissNotice: () => setNotice(null),
      }}
    />
  )
}

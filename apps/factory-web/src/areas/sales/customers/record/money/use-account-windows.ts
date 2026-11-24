'use client'

import { useCallback, useMemo, useRef, useState } from 'react'
import { useToast } from '@nexus/ui/components'
import { useT } from '../../../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../../../lib/session/context'
import { getStatement, sendStatement } from '../../../../finance/receivables/api'
import { setCreditLimit, type CustomerOption, type LimitRow } from '../../../../finance/receivables/credit/api'
import { readProblem as creditProblem } from '../../../../finance/receivables/credit/model'
import type { ChangeInput, ChangeState } from '../../../../finance/receivables/credit/view/ChangeLimitDialog'
import { readProblem as receivablesProblem, receivablesCanOf, statementPdfHref, statementQueryOf, type ReceivablesCan, type StatementRef } from '../../../../finance/receivables/model'
import type { StatementState } from '../../../../finance/receivables/view/StatementDialog'
import { CM } from './model'

/**
 * F-CM-301 / F-CM-302 (customer page › MONEY tab, cm-w3; 13-backend §4.2; 18-lead-settles Z8, Z9, Z12) — the small drivers of two of
 * Finance's own windows opened IN PLACE on the customer's tab (never copied, never edited):
 *
 *   Change limit… / Set a limit…   Finance's ONE editor (ChangeLimitDialog): with a limit the S2 row (its version); without one the
 *                                  window's own picker shows this one customer. setCreditLimit, Finance's command; no fresh code.
 *   Statement… / Send statement…   Finance's StatementDialog: this customer in the page's company and currency; the period read again
 *                                  when changed; Print opens Finance's PDF; Send is Finance's own command (receivables.statements.send).
 *
 * Done → one toast and the tab's burst.
 */
export interface LimitWindow {
  readonly state: ChangeState | null
  readonly customers: readonly CustomerOption[]
  readonly busy: boolean
  readonly onOpen: (row: LimitRow | null) => void
  readonly onSubmit: (input: ChangeInput) => Promise<boolean>
  readonly onClose: () => void
}

export interface StatementWindow {
  readonly state: StatementState | null
  readonly can: ReceivablesCan
  readonly busy: boolean
  readonly onOpen: (sending: boolean) => void
  readonly onPeriod: (period: { from: string | null; to: string | null }) => void
  readonly onPrint: () => void
  readonly onSend: (message: string) => Promise<boolean>
  readonly onCurrency: (currency: string) => void
  readonly onRetry: () => void
  readonly onClose: () => void
}

export function useAccountWindows(input: {
  readonly prefix: string
  readonly party: { readonly id: string; readonly code: string; readonly legalName: string; readonly tradeName: string | null; readonly currency: string }
  readonly onBurst: () => void
}): { readonly limit: LimitWindow; readonly statement: StatementWindow } {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const t = useT(CM)
  const { toast } = useToast()
  const companyId = session.company?.id ?? null
  const { party, onBurst, prefix } = input

  // ---- Change limit… / Set a limit… ----
  const [limitState, setLimitState] = useState<ChangeState | null>(null)
  const [limitBusy, setLimitBusy] = useState(false)
  // Without a limit the window's own picker shows this one customer (the window as it is: 13-backend §4.2).
  const customers = useMemo<readonly CustomerOption[]>(() => [{ id: party.id, code: party.code, legalName: party.legalName, tradeName: party.tradeName, currency: party.currency, companyId }], [party.id, party.code, party.legalName, party.tradeName, party.currency, companyId])
  const limit: LimitWindow = {
    state: limitState,
    customers,
    busy: limitBusy,
    onOpen: (row) => setLimitState({ row, problem: null, ...(row ? {} : { draft: { amountText: '', currency: party.currency, clear: false, reason: '', partyId: party.id } }) }),
    onSubmit: async (change) => {
      setLimitBusy(true)
      try {
        await setCreditLimit(api, change.partyId, change.companyId, { ...(change.version !== undefined ? { version: change.version } : {}), amount: change.amount, currency: change.currency, reason: change.reason })
        setLimitState(null)
        toast(t('cm.done.limit'), 'success')
        onBurst()
        return true
      } catch (error) {
        setLimitState((current) => (current ? { ...current, problem: creditProblem(error) } : current))
        return false
      } finally {
        setLimitBusy(false)
      }
    },
    onClose: () => setLimitState(null),
  }

  // ---- Statement… / Send statement… ----
  const can = useMemo(() => receivablesCanOf(session.permissions), [session.permissions])
  const [statement, setStatement] = useState<StatementState | null>(null)
  const [statementBusy, setStatementBusy] = useState(false)
  const turn = useRef(0)
  const read = useCallback(
    (ref: StatementRef, period: { from: string | null; to: string | null }, sending: boolean) => {
      const mine = ++turn.current
      setStatement({ ref, period, value: null, problem: null, sending })
      getStatement(api, ref.partyId, statementQueryOf(ref, period, null))
        .then((value) => mine === turn.current && setStatement((current) => (current ? { ...current, value, problem: null } : current)))
        .catch((error: unknown) => mine === turn.current && setStatement((current) => (current ? { ...current, value: null, problem: receivablesProblem(error) } : current)))
    },
    [api],
  )
  const statementWindow: StatementWindow = {
    state: statement,
    can,
    busy: statementBusy,
    onOpen: (sending) => {
      if (!companyId) return
      read({ partyId: party.id, companyId, currency: party.currency }, { from: null, to: null }, sending)
    },
    onPeriod: (period) => statement && read(statement.ref, period, statement.sending ?? false),
    onPrint: () => {
      if (statement) window.open(statementPdfHref(prefix, [statement.ref], statement.period), '_blank', 'noopener')
    },
    onSend: async (message) => {
      if (!statement) return false
      setStatementBusy(true)
      try {
        await sendStatement(api, statement.ref.partyId, { ...statementQueryOf(statement.ref, statement.period, null), message })
        setStatement(null)
        toast(t('cm.done.statement'), 'success')
        onBurst()
        return true
      } catch (error) {
        setStatement((current) => (current ? { ...current, sendProblem: receivablesProblem(error) } : current))
        return false
      } finally {
        setStatementBusy(false)
      }
    },
    onCurrency: (currency) => statement && read({ ...statement.ref, currency }, statement.period, statement.sending ?? false),
    onRetry: () => statement && read(statement.ref, statement.period, statement.sending ?? false),
    onClose: () => setStatement(null),
  }
  return { limit, statement: statementWindow }
}

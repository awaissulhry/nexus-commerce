'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { useT } from '../../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { downloadText, useLive } from '../../_shared/hooks'
import { readProblem, romeToday } from '../../_shared/model'
import { csvOf, PAY_DEPTH, payProblem, scoped, type PayProblem, type Phrase } from '../../payments/riba/depth'
import { changeStop, liftStop, listStops, STOP_REFUSALS, type ReminderStop, type StopState } from './api'
import { stopsCanOf, stopsTouched } from './model'
import { StopsSection, type StopDialog } from './view/StopsSection'

/**
 * Reminder stops' container (B-W2b-425 on B-W2b-402's API; Finance › Receivables, under Reminders): reads the company's stops
 * by state (receivables.view), changes one's last day or note, lifts one with why (receivables.reminders.manage; one write
 * each with an Idempotency-Key and the stop's version), exports the chosen rows. Live: a stop or a reminder moved counts
 * behind "N updates · Show". Without receivables.view it asks nothing.
 */
export function ReminderStops({ prefix }: { prefix: string }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const p = useT(PAY_DEPTH)
  const can = useMemo(() => stopsCanOf(session.permissions), [session.permissions])
  const companyId = session.company?.id ?? undefined
  const [state, setState] = useState<StopState>('holding')
  const [stops, setStops] = useState<ReminderStop[] | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [updates, setUpdates] = useState(0)
  const [dialog, setDialog] = useState<StopDialog | null>(null)
  const [busy, setBusy] = useState(false)
  const [writeProblem, setWriteProblem] = useState<PayProblem | null>(null)
  const [notice, setNotice] = useState<Phrase | null>(null)
  const asked = useRef(state)
  asked.current = state

  const read = useCallback(async () => {
    if (!can.view) return
    const target = asked.current
    try {
      const value = await listStops(api, { companyId, state: target, limit: 500 })
      if (asked.current !== target) return
      setStops(value)
      setProblem(null)
      setUpdates(0)
    } catch (error) {
      if (asked.current === target) setProblem(readProblem(error))
    }
  }, [api, can.view, companyId])
  useEffect(() => {
    setStops(null)
    void read()
  }, [read, state])
  useLive(
    (change) => {
      if (stopsTouched(change)) setUpdates((count) => count + 1)
    },
    () => void read(),
    can.view,
  )

  const run = async (work: () => Promise<unknown>, words: Phrase) => {
    if (busy) return
    setBusy(true)
    setWriteProblem(null)
    try {
      await work()
      setDialog(null)
      setNotice(words)
      await read()
    } catch (error) {
      setWriteProblem(payProblem(error, 'stop', STOP_REFUSALS, ['stop']))
      void read()
    } finally {
      setBusy(false)
    }
  }

  if (!can.view) return null
  return (
    <StopsSection
      model={{ prefix, today: romeToday(), can, state, stops, problem, updates, dialog, busy, writeProblem, notice }}
      actions={{
        onState: setState,
        onRetry: () => void read(),
        onShowUpdates: () => void read(),
        onDismissNotice: () => setNotice(null),
        onDialog: (next) => {
          setDialog(next)
          setWriteProblem(null)
        },
        onLift: (stop, reason) => {
          const key = newIdempotencyKey()
          void run(() => liftStop(api, stop, reason || null, key), { key: scoped('stops.notice.lifted') })
        },
        onChange: (stop, input) => {
          const key = newIdempotencyKey()
          void run(() => changeStop(api, stop, input, key), { key: scoped('stops.notice.changed') })
        },
        onExport: (ids) => {
          const picked = (stops ?? []).filter((row) => ids.includes(row.id))
          const header = [p('stops.csv.customer'), p('stops.csv.invoice'), p('stops.csv.reason'), p('stops.csv.until'), p('stops.csv.state'), p('stops.csv.note')]
          const rows = picked.map((row) => [row.customer.name, row.invoice.number ?? '', p(`stops.reason.${row.reason}`), row.until ?? '', p(`stops.state.${row.state}`), row.note ?? ''])
          downloadText(`reminder-stops-${romeToday()}.csv`, csvOf(header, rows))
        },
      }}
    />
  )
}

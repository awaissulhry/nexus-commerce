'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { isStepUpCancelled, useCoalesced, useLive, useStepUp } from '../../_shared/hooks'
import { readProblem, romeToday } from '../../_shared/model'
import { payProblem, scoped, type PayProblem, type Phrase } from '../../payments/riba/depth'
import { PayStepUp } from '../../payments/riba/view/PayStepUp'
import type { Reminder } from '../api'
import { addStop, customerTrust, liftStop, listStops, setTrust, STOP_REFUSALS, type CustomerTrust, type ReminderStop } from './api'
import { stopsCanOf, stopsTouched } from './model'
import { ReminderDepthView } from './view/ReminderDepthView'

/**
 * The stops and the trusted level inside a reminder (B-W2b-425 on B-W2b-402's API): reads the stops in force on the
 * customer's invoices of this reminder and the customer's trusted level; records a stop (receivables.reminders.manage),
 * lifts one, and sets the level (receivables.reminders.trust, the Owner's; a fresh code first for a level). After a move the
 * reminder is read again (its held reasons change). Live: a stop or a trusted level of the customer reads it again.
 */
export function ReminderDepth({ reminder, onChanged }: { reminder: Reminder; onChanged: () => void }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const can = useMemo(() => stopsCanOf(session.permissions), [session.permissions])
  const [stops, setStops] = useState<ReminderStop[] | null>(null)
  const [stopsProblem, setStopsProblem] = useState<string | null>(null)
  const [trust, setTrustState] = useState<CustomerTrust | null>(null)
  const [trustProblem, setTrustProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<PayProblem | null>(null)
  const [notice, setNotice] = useState<Phrase | null>(null)
  const { stepUp, guard, ensureFresh, submitStepUp, cancelStepUp } = useStepUp(api)
  const invoiceIds = reminder.invoices.map((invoice) => invoice.id).join(',')

  const read = useCallback(async () => {
    const ids = new Set(invoiceIds.split(','))
    try {
      setStops((await listStops(api, { partyId: reminder.customer.id })).filter((stop) => ids.has(stop.invoice.id)))
      setStopsProblem(null)
    } catch (error) {
      setStopsProblem(readProblem(error))
    }
    try {
      setTrustState(await customerTrust(api, reminder.customer.id))
      setTrustProblem(null)
    } catch (error) {
      setTrustProblem(readProblem(error))
    }
  }, [api, reminder.customer.id, invoiceIds])
  useEffect(() => {
    void read()
  }, [read])
  const reread = useCoalesced(() => void read(), 700)
  useLive(
    (change) => {
      if (stopsTouched(change) && Object.values(change.fields).includes(reminder.customer.id)) reread()
    },
    () => reread(),
    can.view,
  )

  const run = async (work: () => Promise<unknown>, words: Phrase) => {
    if (busy) return
    setBusy(true)
    setProblem(null)
    try {
      await work()
      setNotice(words)
      await read()
      onChanged()
    } catch (error) {
      if (isStepUpCancelled(error)) return
      setProblem(payProblem(error, 'stop', STOP_REFUSALS, ['stop']))
      void read()
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <ReminderDepthView
        model={{ today: romeToday(), can, reminder: { status: reminder.status, invoices: reminder.invoices, trusted: reminder.trusted ?? null }, stops, stopsProblem, trust, trustProblem, busy, problem, notice }}
        actions={{
          onRetry: () => void read(),
          onDismissNotice: () => setNotice(null),
          onAddStop: (draft) => {
            const key = newIdempotencyKey()
            void run(() => addStop(api, { invoiceId: draft.invoiceId, reason: draft.reason, until: draft.until || null, note: draft.note.trim() || null }, key), { key: scoped('stops.notice.added') })
          },
          onLift: (stop) => {
            const key = newIdempotencyKey()
            void run(() => liftStop(api, stop, null, key), { key: scoped('stops.notice.lifted') })
          },
          onSetLevel: (level) => {
            const current = trust
            if (!current) return
            const key = newIdempotencyKey()
            void run(async () => {
              if (level !== null) await ensureFresh(scoped('stepUp.trust'))
              setTrustState(await guard(scoped('stepUp.trust'), () => setTrust(api, current, level, key)))
            }, level === null ? { key: scoped('trust.notice.cleared') } : { key: scoped('trust.notice.set'), params: { level } })
          },
        }}
      />
      <PayStepUp stepUp={stepUp} onSubmit={(code) => void submitStepUp(code)} onCancel={cancelStepUp} />
    </>
  )
}

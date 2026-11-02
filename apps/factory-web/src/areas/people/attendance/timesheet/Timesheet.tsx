'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { isApiError } from '../../../../lib/api/errors'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { companyPrefix } from '../../../../lib/session/session'
import type { Loaded } from '../../_shared/parts'
import { approveAsHr, approveAsLead, readTimesheet, sendBackTimesheet, type TimesheetRecord } from '../api'
import { attendanceCan, isGateClosed, problemOf, readProblem, type Words } from '../model'
import { TimesheetView, type TimesheetDialog } from './view/TimesheetView'

/**
 * `/w/<company>/people/attendance/timesheets/<id>` (design tab:timesheet): a person's month in a new tab, printed from the
 * browser. A lead reads each day's state and no hours (`figuresShown` false, B-W2b-42); HR reads the hours. The approvals of the
 * record live here, one at a time.
 */
export function Timesheet({ timesheetId }: { timesheetId: string }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const can = useMemo(() => attendanceCan(session.permissions), [session.permissions])
  const [loaded, setLoaded] = useState<Loaded<TimesheetRecord>>({ status: 'loading' })
  const [gateShut, setGateShut] = useState(false)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<Words | null>(null)
  const [dialog, setDialog] = useState<TimesheetDialog | null>(null)

  const read = useCallback(async () => {
    try {
      setLoaded({ status: 'ready', value: await readTimesheet(api, timesheetId) })
    } catch (error) {
      if (isGateClosed(error)) setGateShut(true)
      setLoaded(isApiError(error) && error.kind === 'not_found' ? { status: 'notFound' } : isApiError(error) && error.kind === 'forbidden' ? { status: 'forbidden' } : { status: 'error', problem: readProblem(error) })
    }
  }, [api, timesheetId])
  useEffect(() => {
    void read()
  }, [read])

  const value = loaded.status === 'ready' ? loaded.value : null
  const approve = (write: typeof approveAsLead) => {
    if (!value || busy) return
    setBusy(true)
    setProblem(null)
    write(api, value.id, value.version)
      .then((next) => setLoaded({ status: 'ready', value: next }))
      .catch((error: unknown) => {
        setProblem(problemOf(error, 'timesheet'))
        void read()
      })
      .finally(() => setBusy(false))
  }

  return (
    <TimesheetView
      model={{ prefix: companyPrefix(session.company?.code ?? ''), can, loaded, gateShut, busy, problem, dialog, at: new Date().toISOString(), person: session.user.displayName }}
      actions={{
        onRetry: () => void read(),
        onLead: () => approve(approveAsLead),
        onHr: () => approve(approveAsHr),
        onSendBack: () => setDialog({ reason: '', busy: false, problem: null }),
        onReason: (reason) => setDialog((was) => (was ? { ...was, reason, problem: null } : was)),
        onSave: () => {
          if (!value || !dialog || dialog.busy) return
          setDialog({ ...dialog, busy: true })
          sendBackTimesheet(api, value.id, { version: value.version, reason: dialog.reason.trim() })
            .then((next) => {
              setLoaded({ status: 'ready', value: next })
              setDialog(null)
            })
            .catch((error: unknown) => setDialog((was) => (was ? { ...was, busy: false, problem: problemOf(error, 'timesheet') } : was)))
        },
        onCancel: () => setDialog(null),
      }}
    />
  )
}

'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { companyPrefix } from '../../../../lib/session/session'
import { openStatement, readEmployeePublications, readEmployeeStatements } from '../api'
import { hasRight, pieceCan, problemWords } from '../model'
import type { Read } from '../view-model'
import { EmployeePayView, type EmployeePayModel } from './view/EmployeePayView'

/** The container of the employee record's Pay tab (slot `pay` of EmployeeRecordView, so the record's view stays pure). */
export function EmployeePay({ employeeId }: { employeeId: string }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const can = useMemo(() => pieceCan(session.permissions), [session.permissions])
  const right = hasRight(can)
  const [statements, setStatements] = useState<EmployeePayModel['statements']>(right ? { status: 'loading' } : null)
  const [publications, setPublications] = useState<EmployeePayModel['publications']>(can.view ? { status: 'loading' } : null)
  const [opened, setOpened] = useState<Read<Awaited<ReturnType<typeof openStatement>>> | null>(null)
  const read = useCallback(() => {
    if (right) readEmployeeStatements(api, employeeId).then((value) => setStatements({ status: 'ready', value }), (error) => setStatements({ status: 'failed', problem: problemWords(error) }))
    if (can.view) readEmployeePublications(api, employeeId).then((value) => setPublications({ status: 'ready', value }), (error) => setPublications({ status: 'failed', problem: problemWords(error) }))
  }, [api, employeeId, right, can.view])
  useEffect(read, [read])
  return (
    <EmployeePayView
      model={{ prefix: companyPrefix(session.company?.code ?? ''), employeeId, right, rates: can.view, statements, publications, opened }}
      actions={{
        onRetry: read,
        onOpen: (id) => {
          setOpened({ status: 'loading' })
          openStatement(api, id).then((value) => setOpened({ status: 'ready', value }), (error) => setOpened({ status: 'failed', problem: problemWords(error) }))
        },
      }}
    />
  )
}

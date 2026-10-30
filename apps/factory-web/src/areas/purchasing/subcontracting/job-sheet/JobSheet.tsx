'use client'

import { useEffect, useState } from 'react'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { getOrder, type SubcontractOrder } from '../api'
import { readWords } from '../record/record-model'
import { JobSheetView } from './view/JobSheetView'

/**
 * `/w/<company>/purchasing/subcontracting/<id>/job-sheet` (design tab:job-sheet): the order read once and drawn for
 * paper. Opened in a new tab from the record's ⋯ Print job sheet and from Documents.
 */
export function JobSheet({ orderId }: { orderId: string }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const [order, setOrder] = useState<{ value: SubcontractOrder | null; problem: string | null }>({ value: null, problem: null })
  const [readAt, setReadAt] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    getOrder(api, orderId)
      .then((value) => {
        if (!live) return
        setOrder({ value, problem: null })
        setReadAt(new Date().toISOString())
      })
      .catch((error: unknown) => live && setOrder({ value: null, problem: readWords(error) }))
    return () => {
      live = false
    }
  }, [api, orderId])
  return <JobSheetView model={{ company: session.company?.name ?? '', person: session.user.displayName, readAt, order, timeZone: 'Europe/Rome' }} />
}

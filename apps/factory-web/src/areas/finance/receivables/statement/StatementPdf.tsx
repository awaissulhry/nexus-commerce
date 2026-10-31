'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { getStatement, statementPdf } from '../api'
import { readProblem, receivablesCanOf, statementPdfAddressOf, statementQueryOf } from '../model'
import { StatementPdfView, type StatementPdfEntry } from './view/StatementPdfView'

/**
 * `/w/<company>/finance/receivables/statement?for=<party>:<company>:<currency>,…&from=&to=` (SCR-151 tab:statement-pdf):
 * each statement named, read as a PDF (`GET /receivables/customers/:partyId/statement/pdf`, made on request, stored
 * nowhere) and its customer's name (the statement's read), at most 10 at once ("Print N statements" from By customer).
 */
export function StatementPdf() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const params = useSearchParams()
  const address = useMemo(() => statementPdfAddressOf(params), [params])
  const can = useMemo(() => receivablesCanOf(session.permissions), [session.permissions])
  const [entries, setEntries] = useState<StatementPdfEntry[]>(() => address.refs.map((ref) => ({ ref, name: null, pdf: null, problem: null })))

  const read = useCallback(
    async (index: number) => {
      const ref = address.refs[index]
      if (!ref) return
      const query = statementQueryOf(ref, { from: address.from, to: address.to }, null)
      setEntries((current) => current.map((entry, at) => (at === index ? { ...entry, pdf: null, problem: null } : entry)))
      try {
        const [statement, pdf] = await Promise.all([getStatement(api, ref.partyId, query), statementPdf(api, ref.partyId, query)])
        setEntries((current) => current.map((entry, at) => (at === index ? { ...entry, name: statement.customer.name, pdf, problem: null } : entry)))
      } catch (error) {
        setEntries((current) => current.map((entry, at) => (at === index ? { ...entry, problem: readProblem(error) } : entry)))
      }
    },
    [api, address],
  )

  useEffect(() => {
    setEntries(
      address.refs.map((ref) => ({
        ref,
        name: null,
        pdf: null,
        problem: null,
      })),
    )
    if (!can.view || !can.price) return
    address.refs.forEach((_, index) => void read(index))
  }, [address, can.view, can.price, read])

  return <StatementPdfView model={{ can, from: address.from, to: address.to, entries }} onRetry={(index) => void read(index)} />
}

'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { statementPdf } from '../api'
import { hasRight, pieceCan, problemWords, type Words } from '../model'
import { StatementPdfView } from './view/StatementPdfView'

/** `/w/<company>/people/piecerates/statement/<id>` (SCR-158 tab:statement-pdf): read once per opening of the tab (each is recorded). */
export function StatementPdf({ statementId }: { statementId: string }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const allowed = useMemo(() => hasRight(pieceCan(session.permissions)), [session.permissions])
  const [pdf, setPdf] = useState<Uint8Array | null>(null)
  const [problem, setProblem] = useState<Words | null>(null)
  const asked = useRef<string | null>(null)
  const read = useCallback(() => {
    setProblem(null)
    statementPdf(api, statementId).then(setPdf, (error) => setProblem(problemWords(error)))
  }, [api, statementId])
  useEffect(() => {
    // Strict mode runs an effect twice in development: one opening is one recorded opening.
    if (!allowed || asked.current === statementId) return
    asked.current = statementId
    read()
  }, [allowed, statementId, read])
  return <StatementPdfView model={{ allowed, pdf, problem }} onRetry={read} />
}

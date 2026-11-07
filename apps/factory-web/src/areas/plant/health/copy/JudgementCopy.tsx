'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { copyBytes } from '../api'
import { copyKindOf, healthCan, readProblemOf } from '../model'
import type { JudgementCopyModel } from '../view-model'
import { JudgementCopyView } from './view/JudgementCopyView'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * `/w/<company>/plant/health/copy?judgement=<id>&file=<id>` (SCR-212-copy, design plant.health/tab:copy "Judgement copy (PDF)",
 * from a judgement's window): the doctor's copy, read ONCE — POST …/copy/:fileId/open writes its COPY view first, then the
 * presigned GET is read into this tab's memory (never browser storage) and drawn: a PDF in the DS PdfViewer, a picture as is.
 */
export function JudgementCopy() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const params = useSearchParams()
  const can = useMemo(() => healthCan(session.permissions), [session.permissions])
  const judgementId = params.get('judgement') ?? ''
  const fileId = params.get('file') ?? ''
  const [model, setModel] = useState<JudgementCopyModel>({ canView: can.view, kind: null, bytes: null, problem: null, at: null })

  // ONE recorded opening per tab: a second run of the effect (React's development double run) opens nothing more.
  const started = useRef<string | null>(null)
  useEffect(() => {
    if (!can.view) return
    if (!UUID.test(judgementId) || !UUID.test(fileId)) {
      setModel({ canView: true, kind: null, bytes: null, problem: 'problem.notFound', at: null })
      return
    }
    const want = `${judgementId}|${fileId}`
    if (started.current === want) return
    started.current = want
    setModel({ canView: true, kind: null, bytes: null, problem: null, at: null })
    copyBytes(api, judgementId, fileId).then(
      (bytes) => started.current === want && setModel({ canView: true, kind: copyKindOf(bytes), bytes, problem: null, at: new Date().toISOString() }),
      (error: unknown) => started.current === want && setModel({ canView: true, kind: null, bytes: null, problem: readProblemOf(error), at: null }),
    )
  }, [api, can.view, judgementId, fileId])

  return <JudgementCopyView model={{ ...model, canView: can.view }} />
}

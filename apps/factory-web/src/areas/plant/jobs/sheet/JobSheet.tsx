'use client'

import { useEffect, useMemo, useState } from 'react'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { companyPrefix } from '../../../../lib/session/session'
import { getJob, type JobRecord } from '../../_shared/api'
import { readProblem } from '../../_shared/model'
import { JobSheetView } from './view/JobSheetView'

/** `/w/<company>/plant/jobs/<id>/sheet` (SCR-149 tab:job-sheet): the job read once, drawn for paper with its QR. */
export function JobSheet({ jobId }: { jobId: string }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const prefix = companyPrefix(session.company?.code ?? '')
  const [at] = useState(() => new Date().toISOString())
  const [origin, setOrigin] = useState('')
  useEffect(() => setOrigin(window.location.origin), [])
  const [job, setJob] = useState<{ value: JobRecord | null; problem: string | null }>({ value: null, problem: null })
  useEffect(() => {
    let live = true
    getJob(api, jobId)
      .then((value) => live && setJob({ value, problem: null }))
      .catch((error: unknown) => live && setJob({ value: null, problem: readProblem(error) }))
    return () => {
      live = false
    }
  }, [api, jobId])
  const model = useMemo(() => ({ person: session.user.displayName, at, address: `${origin}${prefix}/plant/jobs/${encodeURIComponent(jobId)}`, job }), [session.user.displayName, at, origin, prefix, jobId, job])
  return <JobSheetView model={model} />
}

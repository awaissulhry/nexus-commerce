'use client'

import { useCallback, useEffect, useState } from 'react'
import { WithMessages } from '../../../record-panels/i18n'
import { usePortalApi, usePortalBand, usePortalFrame } from '../../shell/frame'
import { NotInAccessHere } from '../orders/parts'
import { fetchJob, type Job } from './api'
import { jobHref, NS } from './model'
import { SheetView } from './view/SheetView'
import { useJobWords } from './words'

/** `/p/<party>/jobs/<id>/sheet` — the job sheet for the bench (B-W2b-181; a new tab from the job's ⋯ and Documents). */
export function SupplierJobSheetPage({ id }: { id: string }) {
  return (
    <WithMessages namespaces={[NS, 'ds-words']}>
      <SheetContainer id={id} />
    </WithMessages>
  )
}

function SheetContainer({ id }: { id: string }) {
  const frame = usePortalFrame()
  const api = usePortalApi()
  const { t } = useJobWords()
  const allowed = frame.me.permissions.includes('portal.jobs.view')
  const [job, setJob] = useState<Job | null>(null)
  const [state, setState] = useState<'loading' | 'error' | 'ready'>('loading')
  const load = useCallback(async () => {
    try {
      setJob((await fetchJob(api, id)).job)
      setState('ready')
    } catch {
      setState('error')
    }
  }, [api, id])
  useEffect(() => {
    if (allowed) void load()
  }, [allowed, load])
  usePortalBand({ title: job ? t('sheet.title', { number: job.number }) : t('sheet.titleLoading'), back: { href: jobHref(frame.prefix, id, 'documents'), label: job?.number ?? t('list.title') } })
  if (!allowed) return <NotInAccessHere />
  return <SheetView model={{ state, job }} onRetry={() => void load()} />
}

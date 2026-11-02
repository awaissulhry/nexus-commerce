'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname } from 'next/navigation'
import { useLocale } from '../../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { WithMessages } from '../../../../record-panels/i18n'
import { useLive } from '../../../_shared/buying/hooks'
import { downloadStored } from '../../../finance/accounting/download'
import { liveMatches } from '../../../quality/_shared/hooks'
import type { Loaded, Notice } from '../../_shared/parts'
import { exportValues, getExport, openFile, withdrawLink, type ExportLink, type ExportRecord } from '../api'
import { fileHeld, NAMESPACE, payrollCan, payrollProblem } from '../model'
import { useExportDialogs } from '../use-export-dialogs'
import { PREVIEW_IDLE, type PreviewState } from '../view-model'
import { PastExportView, type PastExportActions } from './view/PastExportView'

const OWN_MS = 5000

/**
 * `/w/<company>/people/payroll/<id>` (SCR-159-record, the design's tab:past; ⌘-click a row): one file: its checks as they stood, its
 * seal and files, its links with their downloads, what it changed against the one before. Its numbers open on the click and are
 * recorded, and live in this page's state alone. Live: a download or a withdrawn link reads it again.
 */
export function PastExport({ exportId }: { exportId: string }) {
  return (
    <WithMessages namespaces={[NAMESPACE]}>
      <Page exportId={exportId} />
    </WithMessages>
  )
}

function Page({ exportId }: { exportId: string }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const pathname = usePathname()
  const locale = useLocale()
  const prefix = pathname.replace(/\/people\/payroll\/.*$/, '')
  const can = useMemo(() => payrollCan(session.permissions), [session.permissions])
  const companyId = session.company?.id ?? null
  const [loaded, setLoaded] = useState<Loaded<ExportRecord>>({ status: 'loading' })
  const [values, setValues] = useState<PreviewState>(PREVIEW_IDLE)
  const [onlyChanged, setOnlyChanged] = useState(false)
  const [withdrawing, setWithdrawing] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [asOf, setAsOf] = useState<string | null>(null)
  const ownUntil = useRef(0)

  const read = useCallback(async () => {
    if (!can.view) return
    try {
      setLoaded({ status: 'ready', value: await getExport(api, exportId) })
      setAsOf(new Date().toISOString())
    } catch (error) {
      const words = payrollProblem(error)
      setLoaded(words.key === 'problem.notFound' ? { status: 'notFound' } : words.key === 'problem.forbidden' ? { status: 'forbidden' } : { status: 'error', problem: words.key })
    }
  }, [api, can.view, exportId])

  useEffect(() => {
    void read()
  }, [read])

  const live = useLive(
    (change) => {
      if (liveMatches(change, ['payroll_export.'])) void read()
    },
    () => void read(),
    can.view,
  )

  const dialogs = useExportDialogs(api, { companyId, can, locale, own: () => (ownUntil.current = Date.now() + OWN_MS), onChanged: () => void read() })

  const actions: PastExportActions = {
    ...dialogs.actions,
    onRetry: () => void read(),
    onDismissNotice: () => setNotice(null),
    onReadValues: () => {
      setValues({ status: 'reading', value: null, problem: null })
      exportValues(api, exportId)
        .then((value) => setValues({ status: 'ready', value, problem: null }))
        .catch((error: unknown) => setValues({ status: 'error', value: null, problem: payrollProblem(error) }))
    },
    onOnlyChanged: setOnlyChanged,
    onDownload: (record, file) => {
      if (fileHeld(record, can)) return
      downloadStored(() => openFile(api, record.id, file.id), file.name).catch((error: unknown) => setNotice({ tone: 'danger', words: payrollProblem(error) }))
    },
    onWithdraw: (link: ExportLink) => {
      setWithdrawing(link.id)
      withdrawLink(api, exportId, link.id)
        .then(() => {
          setNotice({ tone: 'success', words: { key: 'record.withdrawn', params: { email: link.email ?? '—' } } })
          void read()
        })
        .catch((error: unknown) => setNotice({ tone: 'danger', words: payrollProblem(error) }))
        .finally(() => setWithdrawing(null))
    },
  }

  return <PastExportView model={{ prefix, can, loaded, live, asOf, values, onlyChanged, withdrawing, dialogs: dialogs.dialogs, notice }} actions={actions} />
}

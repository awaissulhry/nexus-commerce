'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { usePathname } from 'next/navigation'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { useCoalesced, useLive } from '../../_shared/hooks'
import { readProblem, writeProblem, type Phrase } from '../../_shared/model'
import { dismissInboxItem, inboxFileLink, inboxTouched, listInbox, reopenInboxItem, type InboxItem, type InboxList } from './api'
import { inboxAbilitiesOf, statusOfInboxRows, type InboxRows } from './model'
import { SdiInboxSection } from './view/SdiInboxSection'

/**
 * B-W2b-GB02 — the SDI inbox's container on Finance › Payables: the address's company; reads the rows chosen (GET
 * /payables/sdi/inbox), dismisses one with the reason and reopens one (one write each, an Idempotency-Key and the item's
 * version), opens the kept file in a new tab (a presigned link). Live: a pickup, a delivery recorded or an inbox move reads it
 * again.
 */
export function SdiInbox() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const pathname = usePathname()
  const prefix = pathname.replace(/\/finance\/payables(\/.*)?$/, '')
  const can = useMemo(() => inboxAbilitiesOf(session.permissions), [session.permissions])
  const companyId = session.company?.id ?? null
  const [rows, setRows] = useState<InboxRows>('open')
  const [list, setList] = useState<{ value: InboxList | null; problem: string | null }>({ value: null, problem: null })
  const [dismissing, setDismissing] = useState<InboxItem | null>(null)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<Phrase | null>(null)
  const [notice, setNotice] = useState<Phrase | null>(null)
  const [fileProblem, setFileProblem] = useState<string | null>(null)

  const read = useCallback(async () => {
    if (!can.view || !companyId) return
    try {
      setList({ value: await listInbox(api, companyId, statusOfInboxRows(rows)), problem: null })
    } catch (error) {
      setList({ value: null, problem: readProblem(error) })
    }
  }, [api, can.view, companyId, rows])
  useEffect(() => {
    void read()
  }, [read])
  const reread = useCoalesced(() => void read(), 900)
  useLive((change) => (inboxTouched(change) ? reread() : undefined), () => reread(), can.view)

  const write = async (work: () => Promise<InboxItem>, done: Phrase) => {
    if (busy) return
    setBusy(true)
    setFailure(null)
    try {
      await work()
      setDismissing(null)
      setNotice(done)
      void read()
    } catch (error) {
      const words = writeProblem(error)
      setFailure(words.params ? { key: words.key, params: words.params } : { key: words.key })
      if (words.reload) void read()
    } finally {
      setBusy(false)
    }
  }

  return (
    <SdiInboxSection
      model={{ prefix, can, rows, list, dismissing, reason, busy, writeProblem: failure, notice, fileProblem }}
      actions={{
        onRows: setRows,
        onDismiss: (item) => {
          setDismissing(item)
          setReason('')
          setFailure(null)
        },
        onReason: setReason,
        onConfirmDismiss: () => dismissing && void write(() => dismissInboxItem(api, dismissing, reason.trim(), newIdempotencyKey()), { key: 'notice.dismissed', params: { file: dismissing.fileName } }),
        onReopen: (item) => void write(() => reopenInboxItem(api, item, newIdempotencyKey()), { key: 'notice.reopened', params: { file: item.fileName } }),
        onOpenFile: (item) => {
          if (!item.xmlFileId) return
          setFileProblem(null)
          void inboxFileLink(api, item.xmlFileId)
            .then((url) => window.open(url, '_blank', 'noopener,noreferrer'))
            .catch((error) => setFileProblem(readProblem(error)))
        },
        onRetry: () => void read(),
        onDismissNotice: () => setNotice(null),
      }}
    />
  )
}

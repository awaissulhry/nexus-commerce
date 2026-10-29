'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { downloadLink } from '../../../record-panels/api'
import { useLiveChanges } from '../../../record-panels/live'
import { storeUrl } from '../../../record-panels/store'
import { answerProblem, assignMail, findRecords, getMail, listMail, readProblem, rejectMail, releaseMail } from './api'
import { isMailChange, type MailDetail, type MailFilter, type MailSummary, type MailToSortViewModel, type RecordCandidate } from './model'
import { MailToSortView } from './view/MailToSortView'

type Notice = NonNullable<MailToSortViewModel['notice']>

/**
 * `/w/<company>/home/mail-to-sort` (SCR-019): loads the mail to sort through the API client (email.triage over the
 * mail's company; the API filters), opens one, and sends the person's answer with the mail's version as read. The list
 * and the open mail are read again when the live stream says a mail was sorted (`email.inbound_sorted`), and after every
 * answer; an answer that met a mail moved meanwhile reads it again and says so (COL-078). `?open=<id>` opens one mail
 * (Today's mail rows link here).
 */
export function MailToSort() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const held = useMemo(() => new Set(session.permissions), [session.permissions])
  const [filter, setFilter] = useState<MailFilter>('all')
  const [mails, setMails] = useState<{ items: MailSummary[] | null; cursor: string | null; problem: string | null }>({ items: null, cursor: null, problem: null })
  const [open, setOpen] = useState<MailToSortViewModel['open']>(null)
  const [candidates, setCandidates] = useState<RecordCandidate[] | null>(null)
  const [candidatesProblem, setCandidatesProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [showPictures, setShowPictures] = useState(false)
  const filterRef = useRef(filter)
  filterRef.current = filter
  const openRef = useRef(open)
  openRef.current = open

  const loadList = useCallback(
    async (more = false, cursor: string | null = null) => {
      const wanted = filterRef.current
      try {
        const page = await listMail(api, wanted, more ? cursor : null)
        if (wanted !== filterRef.current) return
        setMails((current) => ({ items: more && current.items ? [...current.items, ...page.mails] : page.mails, cursor: page.nextCursor, problem: null }))
      } catch (error) {
        setMails((current) => ({ ...current, problem: readProblem(error) }))
      }
    },
    [api],
  )
  const loadDetail = useCallback(
    async (id: string) => {
      try {
        const detail = await getMail(api, id)
        if (openRef.current?.id === id) setOpen({ id, detail, problem: null })
      } catch (error) {
        if (openRef.current?.id === id) setOpen({ id, detail: null, problem: readProblem(error) })
      }
    },
    [api],
  )

  useEffect(() => {
    setMails({ items: null, cursor: null, problem: null })
    void loadList()
  }, [filter, loadList])

  // `?open=<mail id>` (Today opens a mail to sort here): that mail's review opens at once.
  const askedOpen = useSearchParams()?.get('open') ?? null
  useEffect(() => {
    if (!askedOpen) return
    setOpen({ id: askedOpen, detail: null, problem: null })
    void loadDetail(askedOpen)
  }, [askedOpen, loadDetail])

  useLiveChanges({
    onChange: (change) => {
      if (!isMailChange(change)) return
      void loadList()
      const current = openRef.current
      if (current && change.fields.inboundEmailId === current.id) void loadDetail(current.id)
    },
    onReconnect: () => {
      void loadList()
      if (openRef.current) void loadDetail(openRef.current.id)
    },
  })

  /** Runs one answer; on success the mail leaves the list (or moves place) and the detail closes. */
  const answer = async (mail: MailDetail, run: () => Promise<MailDetail>, done: (result: MailDetail) => Notice): Promise<boolean> => {
    setBusy(true)
    setNotice(null)
    try {
      const result = await run()
      setNotice(done(result))
      setOpen(null)
      void loadList()
      return true
    } catch (error) {
      const problem = answerProblem(error)
      setNotice({ key: problem.key, tone: problem.tone })
      if (problem.reload) {
        void loadList()
        void loadDetail(mail.id)
      }
      return false
    } finally {
      setBusy(false)
    }
  }

  // The records an assign may go to, for what was typed; the newest search wins (an older answer is dropped).
  const searchSeq = useRef(0)
  const searchRecords = (query: string) => {
    const mine = ++searchSeq.current
    setCandidatesProblem(null)
    findRecords(api, query)
      .then((found) => {
        if (mine === searchSeq.current) setCandidates(found)
      })
      .catch((error: unknown) => {
        if (mine === searchSeq.current) setCandidatesProblem(readProblem(error))
      })
  }

  const model: MailToSortViewModel = {
    filter,
    mails: { items: mails.items, more: mails.cursor !== null, problem: mails.problem },
    open,
    canWrite: held.has('threads.post'),
    canReadFiles: held.has('files.read'),
    assign: { candidates, problem: candidatesProblem },
    busy,
    notice,
    showPictures,
  }

  return (
    <MailToSortView
      model={model}
      actions={{
        onFilter: (next) => {
          setOpen(null)
          setFilter(next)
        },
        onOpen: (id) => {
          setShowPictures(false)
          setOpen({ id, detail: null, problem: null })
          void loadDetail(id)
        },
        onClose: () => setOpen(null),
        onMore: () => void loadList(true, mails.cursor),
        onRetry: () => {
          setMails({ items: null, cursor: null, problem: null })
          void loadList()
        },
        onAssignOpen: () => {
          setCandidates(null)
          searchRecords('')
        },
        onAssignSearch: searchRecords,
        onAssign: (mail, record) => answer(mail, () => assignMail(api, mail, record), () => ({ key: 'mailToSort.notice.assigned', tone: 'success' })),
        onRelease: (mail, reason) =>
          answer(
            mail,
            () => releaseMail(api, mail, reason),
            (result) => ({ key: result.status === 'MATCHED' ? 'mailToSort.notice.releasedThread' : 'mailToSort.notice.releasedList', tone: 'success' }),
          ),
        onReject: (mail, reason, note) => answer(mail, () => rejectMail(api, mail, reason, note), () => ({ key: `mailToSort.notice.rejected.${reason}`, tone: 'success' })),
        onDownload: (fileId) => {
          downloadLink(api, fileId)
            .then(({ download }) => {
              const anchor = document.createElement('a')
              anchor.href = storeUrl(download.url)
              anchor.rel = 'noopener'
              document.body.appendChild(anchor)
              anchor.click()
              anchor.remove()
            })
            .catch((error: unknown) => setNotice({ key: answerProblem(error).key, tone: 'danger' }))
        },
        onShowPictures: setShowPictures,
        onDismissNotice: () => setNotice(null),
      }}
    />
  )
}

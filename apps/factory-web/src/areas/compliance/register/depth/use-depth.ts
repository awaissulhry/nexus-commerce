'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { newIdempotencyKey, type ApiClient } from '../../../../lib/api/client'
import { isApiError } from '../../../../lib/api/errors'
import { isStepUpCancelled, liveMatches, useLive, useStepUp } from '../../../quality/_shared/hooks'
import { failedRead, problemKey, ready, reading, type Notice, type Read } from '../../../quality/_shared/model'
import {
  answerDistributorNotice,
  answerRequest,
  cancelDistributorNotice,
  cancelNotice,
  cancelRequest,
  draftDistributorNotices,
  draftNotice,
  draftRecall,
  editDistributorNotice,
  editNotice,
  failDistributorNotice,
  getNotice,
  getRecipients,
  getSurveillance,
  listMarkets,
  logRequest,
  markNoticeSent,
  noticePdfBytes,
  noticeReference,
  requestEvidence,
  sendDistributorNotices,
  uploadNoticeCopy,
  type AuthorityNotice,
  type MarketOption,
  type Recipients,
  type SendAnswer,
  type Surveillance,
} from './api'
import { dayInstant, depthCan, pickLanguage, readerChain, recallAddress, romeDay } from './model'
import type { DialogProblem } from './view/parts'
import type { DepthActions, DepthDialogKind, DepthModel, NoticeModalState } from './view/types'

/**
 * The register entry's W2b parts as one container hook (B-W2b-271 on B-W2b-260's API): reads the surveillance (notices,
 * requests, recalls, the distributors' counts) and the distributors' log; opens a dialog and reads what it needs (the
 * notice fresh with its PDF, the market profiles); runs ONE write at a time with the version read and its own
 * Idempotency-Key (kept for a retry of the same body); asks for a fresh code when the API answers 403 `stepUp` (marked
 * as sent, the distributors' send) and sends again; reads again on its live events. A refusal shows our title with the
 * API's lines under it; a version conflict reads again and says so.
 */

export interface DepthEntry {
  readonly id: string
  readonly companyId: string
  readonly reference: string
  readonly kind: string
  readonly status: 'OPEN' | 'CLOSED'
  readonly risk: 'NO' | 'ASSESSING' | 'YES'
  readonly styleId: string
  readonly styleCode: string
  readonly batchNumbers: readonly string[]
  readonly reportedAt: string
  readonly version: number
}

const LIVE = ['authority_notice.changed', 'recall.changed', 'recall.progress_changed', 'distributor_notice.changed', 'authority_request.changed']

/** The API's sentences of a refusal (data, under our title). */
export function issueLines(error: unknown): string[] {
  if (!isApiError(error)) return []
  return [...new Set(error.issues.map((issue) => issue.message ?? '').filter((line) => line.trim() !== ''))]
}

export function refusal(error: unknown, key: string): DialogProblem {
  const lines = issueLines(error)
  if (isApiError(error) && (error.kind === 'conflict' || error.kind === 'invalid') && lines.length > 0) return { key, lines }
  return { key: `quality:${problemKey(error)}`, lines: [] }
}

export function useDepth({
  api,
  permissions,
  entry,
  prefix,
  locale,
  onEntryChanged,
  navigate,
  recallId = null,
}: {
  api: ApiClient
  permissions: readonly string[]
  entry: DepthEntry
  prefix: string
  locale: string
  /** A write that changes W1's entry too (a notice sent fills its date; the last distributor told): read the entry again. */
  onEntryChanged: () => void
  navigate: (address: string) => void
  /** The recall's page: the notices drafted there tell of this recall. */
  recallId?: string | null
}): { model: DepthModel; actions: DepthActions; notice: Notice | null; dismissNotice: () => void; guard: <T>(sentence: string, work: () => Promise<T>) => Promise<T>; reload: () => void } {
  const can = useMemo(() => depthCan(permissions), [permissions])
  const [surveillance, setSurveillance] = useState<Read<Surveillance>>(reading())
  const [recipients, setRecipients] = useState<Read<Recipients> | null>(null)
  const [dialog, setDialog] = useState<DepthDialogKind | null>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<DialogProblem | null>(null)
  const [noticeModal, setNoticeModal] = useState<NoticeModalState | null>(null)
  const [markets, setMarkets] = useState<Read<readonly MarketOption[]> | null>(null)
  const [sendResults, setSendResults] = useState<SendAnswer | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const { stepUp, guard, submitStepUp, cancelStepUp } = useStepUp(api)
  const keys = useRef(new Map<string, string>())
  const keyFor = (name: string) => {
    const known = keys.current.get(name)
    if (known) return known
    const made = newIdempotencyKey()
    keys.current.set(name, made)
    return made
  }

  const load = useCallback(async () => {
    // The recall page knows its entry only once the recall is read.
    if (!entry.id) return
    try {
      setSurveillance(ready(await getSurveillance(api, entry.id)))
    } catch (error) {
      setSurveillance((current) => (current.value ? current : failedRead(problemKey(error))))
    }
    try {
      setRecipients(ready(await getRecipients(api, entry.id)))
    } catch (error) {
      setRecipients((current) => (current?.value ? current : failedRead(problemKey(error))))
    }
  }, [api, entry.id])

  useEffect(() => {
    void load()
  }, [load, entry.version])

  useLive(
    (change) => {
      if (!liveMatches(change, LIVE)) return
      if (change.fields.entryId !== undefined && change.fields.entryId !== entry.id) return
      void load()
    },
    () => void load(),
  )

  const readMarkets = useCallback(() => {
    if (markets !== null || !can.marketsView) return
    setMarkets(reading())
    listMarkets(api)
      .then((list) => setMarkets(ready(list)))
      .catch((error) => setMarkets(failedRead(problemKey(error))))
  }, [api, can.marketsView, markets])

  const readPdf = useCallback(
    async (noticeId: string, language: string | null) => {
      setNoticeModal((current) => (current ? { ...current, pdf: reading(), language } : current))
      try {
        const bytes = await noticePdfBytes(api, noticeId, language)
        setNoticeModal((current) => (current?.notice?.id === noticeId && current.language === language ? { ...current, pdf: ready(bytes) } : current))
      } catch (error) {
        setNoticeModal((current) => (current?.notice?.id === noticeId ? { ...current, pdf: failedRead(problemKey(error)) } : current))
      }
    },
    [api],
  )

  const showNotice = useCallback(
    (next: AuthorityNotice, language?: string | null) => {
      const chosen = language && Object.keys(next.words).includes(language) ? language : pickLanguage(Object.keys(next.words), readerChain(locale))
      setNoticeModal({ notice: next, pdf: reading(), language: chosen })
      void readPdf(next.id, chosen)
    },
    [locale, readPdf],
  )

  const openDialog = (next: DepthDialogKind | null) => {
    setProblem(null)
    keys.current.clear()
    setDialog(next)
    if (next === null) {
      setNoticeModal(null)
      return
    }
    if (next.kind === 'notice') {
      setNoticeModal(null)
      if (next.noticeId === null) readMarkets()
      else
        getNotice(api, next.noticeId)
          .then((read) => showNotice(read))
          .catch((error) => {
            setDialog(null)
            setNotice({ key: 'notice.readFailed', tone: 'warning', detail: issueLines(error) })
          })
    }
    if (next.kind === 'request') readMarkets()
  }

  /** One write: busy, the step-up when asked, the receipt; the dialog closes unless `keep`. */
  const run = async <T,>(work: () => Promise<T>, done: { key: string; params?: Record<string, string | number> } | null, refusedKey: string, after?: (value: T) => void, keep = false) => {
    setBusy(true)
    setProblem(null)
    try {
      const value = await work()
      keys.current.clear()
      after?.(value)
      if (!keep) {
        setDialog(null)
        setNoticeModal(null)
      }
      if (done) setNotice({ key: done.key, tone: 'success', params: done.params })
      void load()
    } catch (error) {
      if (isStepUpCancelled(error)) return
      if (isApiError(error) && error.kind === 'conflict' && issueLines(error).length === 0) {
        keys.current.clear()
        void load()
        setProblem({ key: 'dialog.conflict', lines: [] })
      } else setProblem(refusal(error, refusedKey))
    } finally {
      setBusy(false)
    }
  }

  const today = romeDay()
  const current = noticeModal?.notice ?? null

  const actions: DepthActions = {
    onDialog: openDialog,
    onRetry: () => {
      setSurveillance(reading())
      setRecipients(null)
      void load()
    },
    onDraftNotice: (form) =>
      void run(
        () => draftNotice(api, entry.id, { marketCode: form.marketCode, authorityName: form.authorityName, channel: form.channel, decision: form.decision }, keyFor('draftNotice')),
        { key: 'done.noticeDrafted' },
        'refused.notice',
        (made) => {
          setDialog({ kind: 'notice', noticeId: made.id })
          showNotice(made)
        },
        true,
      ),
    onSaveNotice: (edit) => {
      if (!current) return
      void run(() => editNotice(api, current.id, current.version, edit), { key: 'done.noticeSaved' }, 'refused.notice', (saved) => showNotice(saved, noticeModal?.language), true)
    },
    onNoticeLanguage: (language) => {
      if (!current) return
      setNoticeModal((state) => (state ? { ...state, language } : state))
      if (Object.keys(current.words).includes(language)) void readPdf(current.id, language)
    },
    onMarkSent: (form, copy) => {
      if (!current) return
      void run(
        async () => {
          const fileId = copy ? await uploadNoticeCopy(api, current, copy) : undefined
          const sentAt = dayInstant(form.day, today)
          return guard('stepUp.noticeSent', () =>
            markNoticeSent(api, current.id, current.version, { ...(sentAt ? { sentAt } : {}), ...(form.reference.trim() ? { reference: form.reference.trim() } : {}), ...(fileId ? { fileId } : {}) }, keyFor('sent')),
          )
        },
        { key: 'done.noticeSent', params: { authority: current.authorityName } },
        'refused.noticeSent',
        () => onEntryChanged(),
      )
    },
    onNoticeReference: ({ reference, copy }) => {
      if (!current) return
      void run(
        async () => {
          const fileId = copy ? await uploadNoticeCopy(api, current, copy) : undefined
          return noticeReference(api, current.id, current.version, { ...(reference ? { reference } : {}), ...(fileId ? { fileId } : {}) })
        },
        { key: 'done.noticeReference' },
        'refused.notice',
        () => onEntryChanged(),
      )
    },
    onCancelNotice: (reason) => {
      if (!current) return
      void run(() => cancelNotice(api, current.id, current.version, reason), { key: 'done.noticeCancelled' }, 'refused.notice')
    },
    onLogRequest: (form) => {
      const receivedAt = dayInstant(form.receivedOn || today, today) ?? new Date().toISOString()
      void run(
        () =>
          logRequest(
            api,
            {
              companyId: entry.companyId,
              authorityName: form.authorityName.trim(),
              marketCode: form.marketCode.trim(),
              ...(form.authorityReference.trim() ? { authorityReference: form.authorityReference.trim() } : {}),
              channel: form.channel,
              receivedAt,
              styleId: entry.styleId,
              ...(form.batchNumbers.length > 0 ? { batchNumbers: form.batchNumbers } : {}),
              request: form.request.trim(),
              dueOn: form.dueOn,
              registerEntryId: entry.id,
            },
            keyFor('logRequest'),
          ),
        { key: 'done.requestLogged' },
        'refused.request',
      )
    },
    onRequestEvidence: (requestId, language) => {
      const request = surveillance.value?.requests.find((item) => item.id === requestId)
      if (!request) return
      void run(() => requestEvidence(api, request.id, request.version, language), { key: 'done.evidenceAsked', params: { number: request.number } }, 'refused.request')
    },
    onAnswerRequest: (requestId, input) => {
      const request = surveillance.value?.requests.find((item) => item.id === requestId)
      if (!request) return
      const answeredAt = dayInstant(input.day, today)
      void run(() => answerRequest(api, request.id, request.version, { answerSummary: input.answerSummary, ...(answeredAt ? { answeredAt } : {}) }), { key: 'done.requestAnswered', params: { number: request.number } }, 'refused.request')
    },
    onCancelRequest: (requestId, reason) => {
      const request = surveillance.value?.requests.find((item) => item.id === requestId)
      if (!request) return
      void run(() => cancelRequest(api, request.id, request.version, reason), { key: 'done.requestCancelled', params: { number: request.number } }, 'refused.request')
    },
    onDraftDistributors: () =>
      void run(
        () => draftDistributorNotices(api, entry.id, recallId, keyFor('draftDistributors')),
        null,
        'refused.distributors',
        (answer) => setNotice({ key: answer.skipped.length > 0 ? 'done.distributorsDraftedSkipped' : 'done.distributorsDrafted', tone: answer.skipped.length > 0 ? 'warning' : 'success', params: { count: answer.notices.length, skipped: answer.skipped.length }, detail: answer.skipped.map((skip) => skip.reason) }),
        true,
      ),
    onSendDistributors: () => {
      const list = recipients?.value
      if (!list) return
      const ids = [...list.recipients.flatMap((recipient) => recipient.notices), ...list.others].filter((item) => item.status === 'DRAFT').map((item) => item.id)
      void run(
        () => guard('stepUp.distributorsSend', () => sendDistributorNotices(api, entry.id, [...new Set(ids)], keyFor('sendDistributors'))),
        null,
        'refused.distributors',
        (answer) => {
          setSendResults(answer)
          if (answer.distributorsInformed) onEntryChanged()
        },
      )
    },
    onEditDistributor: (noticeId, input) => {
      const item = findDistributor(recipients?.value ?? null, noticeId)
      if (!item) return
      void run(() => editDistributorNotice(api, item.id, item.version, { ...(item.channel === 'EMAIL' ? { subject: input.subject || null } : {}), message: input.message }), { key: 'done.distributorSaved', params: { party: item.party.name } }, 'refused.distributors')
    },
    onAnswerDistributor: (noticeId, input) => {
      const item = findDistributor(recipients?.value ?? null, noticeId)
      if (!item) return
      const answeredAt = dayInstant(input.day, today)
      void run(
        () => answerDistributorNotice(api, item.id, item.version, { answer: input.answer, ...(answeredAt ? { answeredAt } : {}), ...(input.byName ? { answeredByName: input.byName } : {}) }),
        { key: 'done.distributorAnswered', params: { party: item.party.name } },
        'refused.distributors',
      )
    },
    onFailDistributor: (noticeId, reason) => {
      const item = findDistributor(recipients?.value ?? null, noticeId)
      if (!item) return
      void run(() => failDistributorNotice(api, item.id, item.version, reason), { key: 'done.distributorFailed', params: { party: item.party.name } }, 'refused.distributors')
    },
    onCancelDistributor: (noticeId, reason) => {
      const item = findDistributor(recipients?.value ?? null, noticeId)
      if (!item) return
      void run(() => cancelDistributorNotice(api, item.id, item.version, reason), { key: 'done.distributorCancelled', params: { party: item.party.name } }, 'refused.distributors')
    },
    onStartRecall: (kind) =>
      void run(
        () => draftRecall(api, entry.id, kind, keyFor('draftRecall')),
        null,
        'refused.recall',
        (made) => navigate(`${recallAddress(prefix, made.id)}?drafted=1`),
      ),
    onSubmitStepUp: (code) => void submitStepUp(code),
    onCancelStepUp: cancelStepUp,
    onDismissResults: () => setSendResults(null),
  }

  const model: DepthModel = {
    prefix,
    can,
    entry: { id: entry.id, companyId: entry.companyId, reference: entry.reference, status: entry.status, risk: entry.risk, styleId: entry.styleId, batchNumbers: entry.batchNumbers, kind: entry.kind, reportedAt: entry.reportedAt, styleCode: entry.styleCode },
    surveillance,
    recipients,
    dialog,
    busy,
    problem,
    noticeModal,
    markets,
    sendResults,
    stepUp,
    today,
  }
  return { model, actions, notice, dismissNotice: () => setNotice(null), guard, reload: () => void load() }
}

function findDistributor(recipients: Recipients | null, noticeId: string) {
  if (!recipients) return null
  return [...recipients.recipients.flatMap((recipient) => recipient.notices), ...recipients.others].find((item) => item.id === noticeId) ?? null
}

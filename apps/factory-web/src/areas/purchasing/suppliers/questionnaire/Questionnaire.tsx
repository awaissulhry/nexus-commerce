'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { useOfficeApi } from '../../../../lib/session/context'
import { useLiveBus } from '../../../../shell/live/use-live'
import { fileBytes, publishStarter, readSupplierQuestionnaire, reviewAnswer, sendQuestionnaireLink } from './api'
import { EMPTY_REVIEW, refusalOf, reviewBodyOf, reviewProblem, sendBodyOf, sendFormOf, sendProblem, type QuestionnaireViewModel } from './model'
import { QuestionnaireView } from './view/QuestionnaireView'

const START: QuestionnaireViewModel = {
  data: null,
  problem: null,
  dialog: null,
  send: { form: { to: '', email: '', mode: 'mail', language: 'it', days: 30, note: '' }, busy: false, problem: null, field: null, result: null },
  review: { form: EMPTY_REVIEW, busy: false, problem: null, field: null },
  publishing: false,
  notice: null,
  opening: null,
}

/** Opens bytes in a new tab (a window opened at the click, so the browser lets it); a download where none opened. */
function showBytes(win: Window | null, bytes: Uint8Array, contentType: string, name: string) {
  const url = URL.createObjectURL(new Blob([bytes.slice().buffer as ArrayBuffer], { type: contentType }))
  if (win && !win.closed) win.location.replace(url)
  else {
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = name
    anchor.rel = 'noopener'
    anchor.click()
  }
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

/**
 * The supplier record's Questionnaire tab (`/w/<company>/purchasing/suppliers/<id>?tab=questionnaire`, mounted through the
 * party record's `questionnaire` slot; B-W2b-172): reads the supplier's questionnaire (`GET /purchasing/suppliers/:id/
 * questionnaire`), sends the link (ONE Idempotency-Key while the dialog is open: a retry never mails twice; a link given
 * to pass on is shown once, in memory only), reviews an answer (accepted, or questions back on the supplier's thread; the
 * answer's version read: a 409 reads again), publishes the starter questionnaire when the company has none, and opens the
 * answer's PDF and its documents in a new tab. Live: the questionnaire's events of this supplier read the tab again.
 */
export function Questionnaire({ partyId }: { partyId: string }) {
  const api = useOfficeApi()
  const [model, setModel] = useState<QuestionnaireViewModel>(START)
  const latest = useRef(model)
  latest.current = model
  const sendKey = useRef<string | null>(null)

  const load = useCallback(async () => {
    try {
      const data = await readSupplierQuestionnaire(api, partyId)
      setModel((current) => ({ ...current, data, problem: null }))
      return data
    } catch {
      setModel((current) => (current.data ? current : { ...current, problem: 'problem.read' }))
      return null
    }
  }, [api, partyId])

  useEffect(() => {
    void load()
  }, [load])

  useLiveBus({
    onChange: (change) => {
      if (change.type.startsWith('supplier_questionnaire.') && (change.fields.partyId === partyId || change.type === 'supplier_questionnaire.published')) void load()
    },
    onReconnect: () => void load(),
  })

  const onOpenFile = useCallback(
    (fileId: string, name: string, contentType: string) => {
      const win = window.open('', '_blank')
      setModel((now) => ({ ...now, opening: { fileId, failed: false } }))
      fileBytes(api, fileId)
        .then((bytes) => {
          showBytes(win, bytes, contentType || 'application/pdf', name || 'document.pdf')
          setModel((now) => ({ ...now, opening: null }))
        })
        .catch(() => {
          win?.close()
          setModel((now) => ({ ...now, opening: { fileId, failed: true } }))
        })
    },
    [api],
  )

  const onSendConfirm = useCallback(() => {
    const current = latest.current
    if (!current.data || current.send.busy) return
    const problem = sendProblem(current.send.form)
    if (problem) {
      setModel((now) => ({ ...now, send: { ...now.send, problem: problem.key, field: problem.field } }))
      document.getElementById(`fw-qn-${problem.field}`)?.focus()
      return
    }
    sendKey.current ??= newIdempotencyKey()
    setModel((now) => ({ ...now, send: { ...now.send, busy: true, problem: null, field: null } }))
    sendQuestionnaireLink(api, partyId, sendBodyOf(current.send.form), sendKey.current)
      .then((result) => {
        sendKey.current = null
        setModel((now) => ({ ...now, send: { ...now.send, busy: false, result }, notice: result.url ? null : { key: result.delivery === 'FAILED' ? 'notice.mailFailed' : 'notice.sent', tone: result.delivery === 'FAILED' ? 'warning' : 'success', params: { email: result.link.email ?? '' } } }))
        void load()
      })
      .catch((error: unknown) => {
        const refusal = refusalOf(error)
        setModel((now) => ({ ...now, send: { ...now.send, busy: false, problem: refusal.key, field: refusal.field } }))
        if (refusal.reload) void load()
      })
  }, [api, load, partyId])

  const onReviewConfirm = useCallback(() => {
    const current = latest.current
    const dialog = current.dialog
    const answer = dialog?.kind === 'review' ? current.data?.answers.find((entry) => entry.id === dialog.id) : undefined
    if (!answer || current.review.busy) return
    const problem = reviewProblem(current.review.form)
    if (problem) {
      setModel((now) => ({ ...now, review: { ...now.review, problem: problem.key, field: problem.field } }))
      return
    }
    setModel((now) => ({ ...now, review: { ...now.review, busy: true, problem: null, field: null } }))
    reviewAnswer(api, answer.id, reviewBodyOf(current.review.form, answer.version))
      .then((result) => {
        setModel((now) => ({ ...now, dialog: null, review: { ...START.review }, notice: { key: result.state === 'ACCEPTED' ? (result.documents > 0 ? 'notice.accepted' : 'notice.acceptedNone') : 'notice.questions', tone: 'success', params: { count: result.documents } } }))
        void load()
      })
      .catch((error: unknown) => {
        const refusal = refusalOf(error)
        setModel((now) => ({ ...now, review: { ...now.review, busy: false, problem: refusal.key, field: refusal.field } }))
        if (refusal.reload) void load()
      })
  }, [api, load])

  return (
    <QuestionnaireView
      model={model}
      actions={{
        onRetry: () => void load(),
        onSend: () => {
          sendKey.current = null
          setModel((now) => (now.data ? { ...now, dialog: { kind: 'send' }, send: { form: sendFormOf(now.data), busy: false, problem: null, field: null, result: null } } : now))
        },
        onSendForm: (edit) => {
          // A changed request is a new send: a new key.
          sendKey.current = null
          setModel((now) => ({ ...now, send: { ...now.send, form: { ...now.send.form, ...edit }, problem: null, field: null } }))
        },
        onSendConfirm,
        onCopy: (url) => void navigator.clipboard?.writeText(url).catch(() => undefined),
        onAnswer: (id) => setModel((now) => ({ ...now, dialog: { kind: 'answer', id } })),
        onReview: (id) => setModel((now) => ({ ...now, dialog: { kind: 'review', id }, review: { ...START.review } })),
        onReviewForm: (edit) => setModel((now) => ({ ...now, review: { ...now.review, form: { ...now.review.form, ...edit }, problem: null, field: null } })),
        onReviewConfirm,
        onClose: () => setModel((now) => (now.send.busy || now.review.busy ? now : { ...now, dialog: null, send: { ...now.send, result: null } })),
        onPublishStarter: () => {
          setModel((now) => ({ ...now, publishing: true }))
          publishStarter(api)
            .then((version) => {
              setModel((now) => ({ ...now, publishing: false, notice: { key: 'notice.published', tone: 'success', params: { revision: version.revision } } }))
              void load()
            })
            .catch((error: unknown) => setModel((now) => ({ ...now, publishing: false, notice: { key: refusalOf(error).key, tone: 'danger' } })))
        },
        onOpenFile,
        onDismissNotice: () => setModel((now) => ({ ...now, notice: null })),
      }}
    />
  )
}

'use client'

import { useCallback, useEffect, useReducer, useRef } from 'react'
import type { ApiClient } from '../../lib/api/client'
import { newIdempotencyKey } from '../../lib/api/client'
import { isApiError } from '../../lib/api/errors'
import { useLocale } from '../../lib/i18n/provider'
import { WithMessages } from '../../record-panels/i18n'
import type { LinkState } from '../../shell/links/link-state'
import { askNewOrderLink, confirmLinkOrder, declineLinkOrder, pickedPdf, readLinkOrder, uploadConfirmation, type AnswerEnd } from './api'
import { answerPreview, clean, confirmBody, dayIn, declineHeld, initialModel, pdfProblem, reduce, sendHeld, type Done, type Problem } from './model'
import { PoConfirmView } from './view/PoConfirmView'

/** A refused answer: this page's problem, and the link state it means when it is the link's (the one 404 of a dead link). */
function refusalOf(error: unknown): { problem: Problem | null; link?: LinkState; reread?: boolean } {
  if (!isApiError(error)) return { problem: 'internal' }
  switch (error.kind) {
    case 'not_found':
      return { problem: null, link: 'unavailable' }
    case 'conflict':
      // A newer version (the buyer changed or cancelled it, or another answer won): read it again; the page then says it.
      return { problem: 'changed', reread: true }
    case 'invalid':
      return { problem: 'invalid' }
    case 'rate_limited':
      return { problem: 'rateLimited' }
    case 'unavailable':
      return { problem: 'unavailableNow' }
    default:
      return { problem: 'internal' }
  }
}

/**
 * A PO_CONFIRM link, once it opened (the link landing did `POST /link/open`): reads the order as its supplier sees it
 * (`GET /link/purchase-order`, no price), keeps the answer being typed, uploads the supplier's PDF when one is chosen,
 * and sends the answer for the version shown (one Idempotency-Key per answer: a retry of the same press keeps it). The
 * link turns to "expired" when its time passes while the page is open. The token stays in the client's
 * `x-factory-link` header; nothing of it is in an address or in storage.
 */
export function PoConfirm({ api }: { api: ApiClient }) {
  return (
    <WithMessages namespaces={['po-confirm-link']}>
      <PoConfirmContainer api={api} />
    </WithMessages>
  )
}

function PoConfirmContainer({ api }: { api: ApiClient }) {
  const locale = useLocale()
  const [model, dispatch] = useReducer(reduce, undefined, () => initialModel(dayIn(new Date())))
  // One key per answer being sent: pressing again after a network failure sends the same answer again, never twice.
  const answerKey = useRef<{ body: string; key: string } | null>(null)
  const keyFor = (body: unknown) => {
    const text = JSON.stringify(body)
    if (answerKey.current?.body !== text) answerKey.current = { body: text, key: newIdempotencyKey() }
    return answerKey.current.key
  }

  const load = useCallback(async () => {
    try {
      dispatch({ type: 'read', page: await readLinkOrder(api) })
    } catch (error) {
      dispatch({ type: 'readFailed', link: isApiError(error) && error.kind === 'not_found' ? 'unavailable' : 'error' })
    }
  }, [api])

  useEffect(() => {
    void load()
  }, [load])

  // The link's time passing while the page is open turns it to "expired" at once (the client's clock against the expiry).
  const expiresAt = model.page?.expiresAt ?? null
  useEffect(() => {
    if (!expiresAt) return
    let timer: ReturnType<typeof setTimeout> | undefined
    // A timer runs at most ~24 days: a later expiry is checked again when it fires.
    const check = () => {
      const left = Date.parse(expiresAt) - Date.now()
      if (left <= 0) dispatch({ type: 'expired' })
      else timer = setTimeout(check, Math.min(left, 2_000_000_000))
    }
    check()
    return () => clearTimeout(timer)
  }, [expiresAt])

  const answered = (end: AnswerEnd, done: Omit<Done, 'outcome'>) => {
    answerKey.current = null
    dispatch({ type: 'answered', page: end, done: { ...done, outcome: end.outcome, fileName: end.confirmationFile?.originalName ?? done.fileName } })
  }
  const refused = (error: unknown) => {
    const refusal = refusalOf(error)
    dispatch({ type: 'refused', problem: refusal.problem, ...(refusal.link ? { link: refusal.link } : {}) })
    if (refusal.reread) void load()
  }

  const lineOf = (lineId: string) => model.page?.lines.find((line) => line.id === lineId)

  return (
    <PoConfirmView
      model={model}
      actions={{
        onField: (field, value) => dispatch({ type: 'field', field, value }),
        onOpenLine: (lineId) => {
          const line = lineOf(lineId)
          if (line) dispatch({ type: 'openLine', line, locale })
        },
        onResetLine: (lineId) => dispatch({ type: 'resetLine', lineId }),
        onResetAll: () => dispatch({ type: 'resetAll' }),
        onSheetKind: (kind) => {
          const line = model.sheet ? lineOf(model.sheet.lineId) : undefined
          if (line) dispatch({ type: 'sheetKind', line, kind, locale })
        },
        onSheetDraft: (draft) => dispatch({ type: 'sheetDraft', draft }),
        onSheetSave: () => {
          const line = model.sheet ? lineOf(model.sheet.lineId) : undefined
          if (line) dispatch({ type: 'sheetSave', line, locale })
        },
        onSheetClose: () => dispatch({ type: 'sheetClose' }),
        onSend: () => {
          const page = model.page
          if (!page) return
          const preview = answerPreview(page, model.answers, model.today, locale)
          if (!preview || sendHeld(model, preview)) return
          const body = confirmBody(model, preview, locale)
          dispatch({ type: 'sending' })
          confirmLinkOrder(api, body, keyFor(body))
            .then((end) => answered(end, { counts: preview.counts, fileName: model.upload.state === 'done' ? model.upload.name : null, supplierRef: clean(model.supplierRef) }))
            .catch(refused)
        },
        onDecline: (open) => dispatch({ type: 'declineOpen', open }),
        onDeclineDraft: (reason, note) => dispatch({ type: 'declineDraft', reason, note }),
        onDeclineSend: () => {
          const page = model.page
          if (!page) return
          if (declineHeld(model)) {
            dispatch({ type: 'declineTried' })
            return
          }
          const body = { version: page.order.version, reason: model.decline.reason, note: clean(model.decline.note), typedName: clean(model.typedName) }
          dispatch({ type: 'sending' })
          declineLinkOrder(api, body, keyFor(body))
            .then((end) => answered(end, { counts: null, fileName: null, supplierRef: null }))
            .catch(refused)
        },
        onPickFile: (file) => {
          const problem = pdfProblem(file)
          if (problem) {
            dispatch({ type: 'upload', upload: { state: 'rejected', name: file.name, problem } })
            return
          }
          dispatch({ type: 'upload', upload: { state: 'uploading', name: file.name, size: file.size } })
          pickedPdf(file)
            .then((picked) => uploadConfirmation(api, picked))
            .then((stored) =>
              dispatch({ type: 'upload', upload: stored.status === 'AVAILABLE' ? { state: 'done', id: stored.id, name: stored.originalName, size: stored.sizeBytes } : { state: 'quarantined', name: file.name } }),
            )
            .catch((error: unknown) => {
              if (isApiError(error) && error.kind === 'not_found') refused(error)
              else dispatch({ type: 'upload', upload: { state: 'failed', name: file.name } })
            })
        },
        onRemoveFile: () => dispatch({ type: 'upload', upload: { state: 'none' } }),
        onRetry: () => {
          dispatch({ type: 'readFailed', link: 'loading' })
          void load()
        },
        onNewLink: () => {
          askNewOrderLink(api)
            .then(() => dispatch({ type: 'newLinkAsked' }))
            // The one answer is 202 whatever the token; a failure to reach us says "try again" on the same button.
            .catch(() => dispatch({ type: 'refused', problem: 'unavailableNow' }))
        },
      }}
    />
  )
}


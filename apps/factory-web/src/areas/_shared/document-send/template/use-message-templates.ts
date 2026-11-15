'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ApiClient } from '../../../../lib/api/client'
import { isApiError } from '../../../../lib/api/errors'
import { useLiveBus } from '../../../../shell/live/use-live'
import { fillReply, listReplies, type ReplyRecordType } from './api'
import { NO_TEMPLATES, orderedReplies, type MessageTemplateModel } from './model'

/**
 * The send panel's message templates for a host (B-W2b-432): while the dialog is open (`input` not null, email.send:
 * `mayUse`) it lists the templates of the language on screen for the record's type (`GET /templates/replies`, again when the
 * language changes or a saved reply changes: saved_reply.changed); `pick` fills one with the record's values (`POST
 * …/:id/fill`) and hands the body to `onFill` for the message box, keeping what the person had written for `putBack`.
 */
export function useMessageTemplates(
  api: ApiClient,
  input: { recordType: ReplyRecordType; recordId: string; contactId: string | null; language: 'it' | 'en'; companyId?: string | null; mayUse: boolean; message: string } | null,
  onFill: (body: string) => void,
  locale: string,
): { model: MessageTemplateModel | null; pick: (replyId: string | null) => void; putBack: () => void } {
  const [state, setState] = useState<MessageTemplateModel>(NO_TEMPLATES)
  const [nonce, setNonce] = useState(0)
  const key = input && input.mayUse ? `${input.recordType}|${input.recordId}|${input.language}|${input.companyId ?? ''}` : null
  const latest = useRef({ input, onFill })
  latest.current = { input, onFill }

  useEffect(() => {
    const now = latest.current.input
    if (!key || !now) {
      setState(NO_TEMPLATES)
      return
    }
    const controller = new AbortController()
    setState((current) => ({ ...NO_TEMPLATES, status: 'loading', previous: current.previous }))
    listReplies(api, { language: now.language, recordType: now.recordType, companyId: now.companyId }, controller.signal).then(
      (replies) => setState((current) => ({ ...current, status: 'ready', replies: orderedReplies(replies, locale).map((reply) => ({ id: reply.id, name: reply.name, shared: reply.shared })) })),
      () => !controller.signal.aborted && setState((current) => ({ ...current, status: 'failed' })),
    )
    return () => controller.abort()
  }, [api, key, locale, nonce])

  useLiveBus({ onChange: (change) => change.type === 'saved_reply.changed' && setNonce((value) => value + 1) }, key !== null)

  const pick = useCallback(
    (replyId: string | null) => {
      const now = latest.current.input
      if (!now) return
      if (!replyId) {
        setState((current) => ({ ...current, pickedId: null, missing: [], problem: null }))
        return
      }
      const before = now.message
      setState((current) => ({ ...current, pickedId: replyId, filling: true, problem: null, missing: [] }))
      fillReply(api, replyId, { recordType: now.recordType, recordId: now.recordId, contactId: now.contactId }).then(
        (filled) => {
          latest.current.onFill(filled.body)
          setState((current) => ({ ...current, filling: false, missing: filled.missing, previous: before.trim() ? before : null }))
        },
        (error: unknown) => setState((current) => ({ ...current, filling: false, pickedId: null, problem: isApiError(error) && error.kind === 'forbidden' ? 'tpl.send.template.noRight' : isApiError(error) && error.kind === 'not_found' ? 'tpl.send.template.gone' : 'tpl.send.template.failed' })),
      )
    },
    [api],
  )

  const putBack = useCallback(() => {
    setState((current) => {
      if (current.previous !== null) latest.current.onFill(current.previous)
      return { ...current, previous: null, pickedId: null, missing: [] }
    })
  }, [])

  return { model: key ? state : null, pick, putBack }
}

'use client'

import { useEffect, useRef, useState } from 'react'
import { RecordThread } from '../../../../lib/record-thread/RecordThread'
// B-TH-234 (B-TH-046): saved replies for requests beside the box, filled from THIS request (its number, subject, wanted date, contact).
import type { SavedRepliesModel, SavedReplyLine } from '../../../../lib/record-thread/helpers/model'
import { SavedReplies } from '../../../../lib/record-thread/helpers/view/SavedReplies'
import { useLocale } from '../../../../lib/i18n/provider'
import { useOfficeApi } from '../../../../lib/session/context'
// B-TH-287 (B-TH-098): saved replies in the five languages written to a customer.
import { REPLY_LANGUAGES, replyLanguageOf } from '../../../../lib/record-thread/helpers/model'
import { fillThreadReply, listThreadReplies } from '../../../_shared/record-thread/api'
import { MessageRemindMe } from '../../../../shell/panels/remind-me/view/MessageRemindMe'
import { useRecordThread, type RecordThreadHost } from '../../../_shared/record-thread/use-record-thread'

/**
 * The request's thread in Incoming's reading pane and on its full page (B-TH-217, B-TH-219): RecordThread v1 through the office
 * container (areas/_shared/record-thread) — the box starts on Office note — with one thing of the request's own (B-TH-218): "Ask
 * for info" switches the box to "Reply to <customer>" with the question, and the send then goes through the request's own
 * POST …/ask-info (the request waits for the customer, Need info; their answer resumes it by itself, B-TH-013). On a request sent
 * from the portal the question goes to the customer's portal at once; on any other the send check runs first (the recipient
 * rule and "Send outside this customer", B-TH-004) and the mail goes from the request.
 */

export interface AskInfo {
  /** A new number each time Ask for info is pressed: the box switches to the reply with this question. */
  readonly token: number
  readonly question: string
  /** The request came from the portal: the question goes there (no address, no send check). */
  readonly portal: boolean
}

export interface AskSend {
  readonly body: string
  readonly subject: string
  readonly to: readonly string[]
  readonly sendOutside: boolean
}

export interface RequestThreadProps {
  readonly host: RecordThreadHost
  /** Ask for info pressed (null: never). */
  readonly ask?: AskInfo | null
  /** The question as it is sent: the container calls …/ask-info and answers whether it went (the box empties then). */
  readonly onAsk?: (send: AskSend) => Promise<boolean>
  /** B-TH-234: the customer's language (the request's `messageTo.language`): its saved replies first. */
  readonly replyLanguage?: string | null
}

export function RequestThread({ host, ask = null, onAsk, replyLanguage = null }: RequestThreadProps) {
  const thread = useRecordThread(host)
  const replies = useRequestReplies(host, thread, replyLanguage)
  const asking = useRef<AskInfo | null>(null)
  const seen = useRef(0)
  const latest = useRef(thread)
  latest.current = thread

  // Ask for info: the box becomes the reply to the customer with the question (the text kept if the person typed one already).
  useEffect(() => {
    if (!ask || ask.token === seen.current) return
    seen.current = ask.token
    asking.current = ask
    const typed = latest.current.model.composer.draft.body.trim()
    latest.current.actions.onDraft({ mode: 'reply', body: typed || ask.question, forFloor: false }, [])
  }, [ask])

  const send = async () => {
    const { model, actions } = latest.current
    const composer = model.composer
    const ok = await (onAsk?.({ body: composer.draft.body, subject: composer.subject, to: [...composer.to, ...composer.cc].map((one) => one.address), sendOutside: model.check?.outside ?? false }) ?? Promise.resolve(false))
    if (!ok) return
    asking.current = null
    actions.onCheckBack()
    actions.onDraft({ mode: 'note', body: '', forFloor: false }, [])
  }

  const askingNow = asking.current !== null && thread.model.composer.draft.mode === 'reply'
  const actions =
    askingNow
      ? {
          ...thread.actions,
          // A portal request: no address to check; any other: the send check first, then the request's own route.
          onSend: asking.current.portal ? () => void send() : thread.actions.onSend,
          onConfirm: () => void send(),
          onDraft: (...args: Parameters<typeof thread.actions.onDraft>) => {
            // Back to an Office note: the question is no longer asked.
            if (args[0].mode !== 'reply') asking.current = null
            thread.actions.onDraft(...args)
          },
        }
      : thread.actions
  // B-TH-289: the question of Ask for info goes through the request's own route (Need info: the request waits on the customer by its
  // state) — no follow-up tick there; any other reply keeps it.
  const model = askingNow ? { ...thread.model, composer: { ...thread.model.composer, followUp: null } } : thread.model
  return <RecordThread model={model} actions={actions} remind={(messageId) => <MessageRemindMe record={host.record} messageId={messageId} />} slots={replies ? { helpers: replies } : undefined} />
}

/**
 * B-TH-234 (B-TH-046, O-SAL-INQ-LIST.pane-thread-T01): Saved replies ▾ beside the request's box — the office's shared replies and the
 * person's own for requests (GET /templates/replies, record type Inquiry — B-TH-287: Italian, English, German, French and Spanish —, the
 * customer's language first). Picking
 * one fills the box from THIS request (POST …/fill: its number, what it is about, the wanted date, the customer's contact who wrote —
 * never another customer's); nothing is sent by picking, and the blanks the request could not fill are said under the box.
 */
function useRequestReplies(host: RecordThreadHost, thread: ReturnType<typeof useRecordThread>, language: string | null) {
  const api = useOfficeApi()
  const locale = useLocale()
  const mayReply = thread.base.held.has('email.send') || thread.base.held.has('threads.post')
  const first = replyLanguageOf(language) ?? (locale === 'en' ? 'en' : 'it')
  const [model, setModel] = useState<SavedRepliesModel>({ status: 'loading', replies: [], language: first })
  const [seq, setSeq] = useState(0)
  const companyId = host.record.companyId
  useEffect(() => {
    if (!mayReply) return
    const controller = new AbortController()
    setModel((now) => ({ ...now, status: 'loading', language: first }))
    Promise.all(REPLY_LANGUAGES.map((one) => listThreadReplies(api, { language: one, recordType: 'Inquiry', companyId }, controller.signal)))
      .then((lists) => {
        const lines: SavedReplyLine[] = lists.flat().flatMap((reply) => {
          const one = replyLanguageOf(reply.language)
          return one ? [{ id: reply.id, name: reply.name, language: one, shared: reply.shared }] : []
        })
        setModel((now) => ({ ...now, status: 'ready', replies: lines }))
      })
      .catch(() => !controller.signal.aborted && setModel((now) => ({ ...now, status: 'failed' })))
    return () => controller.abort()
  }, [api, companyId, mayReply, seq, first])
  const latest = useRef(thread)
  latest.current = thread
  if (!mayReply) return null
  const pick = (replyId: string) => {
    setModel((now) => ({ ...now, filling: true, missing: [] }))
    fillThreadReply(api, replyId, { type: 'Inquiry', id: host.record.id })
      .then((filled) => {
        const { model: now, actions } = latest.current
        const before = now.composer.draft.body.trim()
        actions.onDraft({ ...now.composer.draft, body: before ? `${now.composer.draft.body}\n\n${filled.body}` : filled.body }, now.composer.notes)
        setModel((one) => ({ ...one, filling: false, missing: filled.missing }))
      })
      .catch(() => setModel((one) => ({ ...one, filling: false, status: 'failed' })))
  }
  return <SavedReplies model={model} onPick={pick} onRetry={() => setSeq((value) => value + 1)} />
}

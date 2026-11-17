'use client'

import { useEffect, useRef } from 'react'
import { RecordThread } from '../../../../lib/record-thread/RecordThread'
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
}

export function RequestThread({ host, ask = null, onAsk }: RequestThreadProps) {
  const thread = useRecordThread(host)
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

  const actions =
    asking.current && thread.model.composer.draft.mode === 'reply'
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
  return <RecordThread model={thread.model} actions={actions} remind={(messageId) => <MessageRemindMe record={host.record} messageId={messageId} />} />
}

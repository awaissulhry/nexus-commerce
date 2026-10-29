'use client'

import { useCallback, useEffect, useState } from 'react'
import type { ApiClient } from '../../lib/api/client'
import { isApiError } from '../../lib/api/errors'
import { useT } from '../../lib/i18n/provider'
import { WithMessages } from '../../record-panels/i18n'
import { acceptLinkQuote, askNewLink, declineLinkQuote, documentBytes, readLinkQuote } from './api'
import { declineNote, type QuoteAcceptViewModel } from './model'
import { QuoteAcceptView } from './view/QuoteAcceptView'

/** A refused answer in this page's words (`quote-link`), and the link state it means when it is the link's. */
function answerProblem(error: unknown): { key: string; link?: QuoteAcceptViewModel['link'] } {
  if (!isApiError(error)) return { key: 'problem.internal' }
  if (error.kind === 'not_found') return { key: 'problem.unavailable', link: 'unavailable' }
  if (error.kind === 'forbidden') return { key: 'problem.wrongPerson' }
  if (error.kind === 'conflict') return { key: 'problem.changed' }
  if (error.kind === 'invalid') return { key: 'problem.invalid' }
  if (error.kind === 'rate_limited') return { key: 'problem.rateLimited' }
  if (error.kind === 'unavailable') return { key: 'problem.unavailableNow' }
  return { key: 'problem.internal' }
}

/**
 * A QUOTE_ACCEPT link, once it opened (the link landing did `POST /link/open`): reads the quote as it was sent
 * (`GET /link/quote`) and its PDF (`GET /link/quote/document`), and sends the customer's answer for the version
 * shown — accept (the typed name, the email when asked, the no-withdrawal statement), decline (a reason), or ask for a
 * new link. The token stays in the client's `x-factory-link` header; nothing of it is in an address or in storage.
 */
export function QuoteAccept({ api }: { api: ApiClient }) {
  return (
    <WithMessages namespaces={['quote-link']}>
      <QuoteAcceptContainer api={api} />
    </WithMessages>
  )
}

function QuoteAcceptContainer({ api }: { api: ApiClient }) {
  const t = useT('quote-link')
  const [model, setModel] = useState<QuoteAcceptViewModel>({ link: 'loading', quote: null, pdf: { src: null, problem: false }, answer: 'idle', problem: null, declineOpen: false, newLinkAsked: false })

  const load = useCallback(async () => {
    try {
      const quote = await readLinkQuote(api)
      setModel((current) => ({ ...current, link: 'valid', quote }))
      if (quote.quote.document) {
        documentBytes(api)
          .then((bytes) => setModel((current) => ({ ...current, pdf: { src: bytes, problem: false } })))
          .catch(() => setModel((current) => ({ ...current, pdf: { src: null, problem: true } })))
      }
    } catch (error) {
      setModel((current) => ({ ...current, link: isApiError(error) && error.kind === 'not_found' ? 'unavailable' : isApiError(error) && error.kind === 'forbidden' ? 'wrong_person' : 'error' }))
    }
  }, [api])

  useEffect(() => {
    void load()
  }, [load])

  const answered = (quote: Awaited<ReturnType<typeof readLinkQuote>>) => setModel((current) => ({ ...current, quote, answer: 'done', declineOpen: false, problem: null }))
  const refused = (error: unknown) => {
    const problem = answerProblem(error)
    setModel((current) => ({ ...current, answer: 'idle', problem: problem.key, ...(problem.link ? { link: problem.link } : {}) }))
    if (problem.key === 'problem.changed') void load()
  }

  return (
    <QuoteAcceptView
      model={model}
      actions={{
        onAccept: ({ name, email, noWithdrawal }) => {
          const quote = model.quote
          if (!quote) return
          setModel((current) => ({ ...current, answer: 'busy', problem: null }))
          acceptLinkQuote(api, { versionId: quote.quote.versionId, typedName: name, email: email ?? null, noWithdrawalAccepted: noWithdrawal })
            .then(answered)
            .catch(refused)
        },
        onDecline: (open) => setModel((current) => ({ ...current, declineOpen: open, problem: null })),
        onDeclineSend: ({ reason, note, name }) => {
          const quote = model.quote
          if (!quote) return
          setModel((current) => ({ ...current, answer: 'busy', problem: null }))
          declineLinkQuote(api, { versionId: quote.quote.versionId, typedName: name.trim() || null, note: declineNote(t(`decline.reasons.${reason}`), note) })
            .then(answered)
            .catch(refused)
        },
        onNewLink: () => {
          askNewLink(api, null)
            .then(() => setModel((current) => ({ ...current, newLinkAsked: true })))
            .catch(refused)
        },
        onCopy: (text) => {
          void navigator.clipboard?.writeText(text).catch(() => undefined)
        },
      }}
    />
  )
}

import type { ApiClient } from '../../../../lib/api/client'
import { approveQuote, askApproval, cancelQuote, rejectQuote, reopen, reviseQuote, sendNewLink, type QuoteDetail } from '../api'
import type { QuoteDialog, QuoteNotice } from './record-model'

/**
 * F-CQ-204 (customer page › Quotes & incoming, 13-backend §11 "Quote windows in place"; settle C1) — the acts of the quote's OWN small
 * windows (QuoteDialogs), ONE place: what each runs (one command at the version read) and the receipt it leaves. The quote page runs
 * them (QuoteRecord) and so does any list that opens the same window on a row (use-quote-dialog.ts): one path per job, never a copy.
 */
export interface QuoteAct {
  /** The command (at the quote's version); `tell` says an extra word the answer brings (a link whose mail failed). */
  readonly run: (api: ApiClient, quote: QuoteDetail, text: string, tell?: (notice: QuoteNotice) => void) => Promise<QuoteDetail>
  /** The receipt, from the quote as it was before (Make revision names the next one). */
  readonly done: (before: Pick<QuoteDetail, 'currentRevision'>) => QuoteNotice
}

const notice = (key: string): ((before: Pick<QuoteDetail, 'currentRevision'>) => QuoteNotice) => () => ({ key, tone: 'success' })

export const QUOTE_ACTS: Readonly<Record<QuoteDialog, QuoteAct>> = Object.freeze({
  ask: { run: (api, quote, text) => askApproval(api, quote, text), done: notice('notice.asked') },
  withdraw: { run: (api, quote, text) => reopen(api, quote, text), done: notice('notice.reopened') },
  approve: { run: (api, quote, text) => approveQuote(api, quote, text), done: notice('notice.approved') },
  reject: { run: (api, quote, text) => rejectQuote(api, quote, text), done: notice('notice.rejected') },
  cancel: { run: (api, quote, text) => cancelQuote(api, quote, text), done: notice('notice.cancelled') },
  revise: { run: (api, quote, text) => reviseQuote(api, quote, text), done: (before) => ({ key: 'notice.revised', tone: 'success', params: { next: before.currentRevision + 1 } }) },
  newLink: {
    run: async (api, quote, _text, tell) => {
      const answer = await sendNewLink(api, quote)
      if (answer.delivery === 'failed') tell?.({ key: 'notice.linkFailed', tone: 'danger' })
      return answer.quote
    },
    done: notice('notice.linkSent'),
  },
  // "Back to draft" from Approved: the same command as withdraw (the dialog's own words differ).
  reopen: { run: (api, quote, text) => reopen(api, quote, text), done: notice('notice.reopened') },
})

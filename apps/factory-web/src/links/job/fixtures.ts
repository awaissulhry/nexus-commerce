import { defineDesignScreen } from '../../lib/design/design-screen'
import type { LinkJobPage } from './api'
import { LINK_DRAFT, type LinkDraft } from './model'
import { JobLinkView, type JobLinkViewModel } from './view/JobLinkView'

/**
 * SCR-196 — Accept a job by link (design links.job: sec:job, sec:answer, sec:done, tab:instructions; B-W2b-181), MADE-UP
 * data only (Officina Demo offers job SC-2026-0012 to an invented stitching workshop): the job on one phone screen, accept
 * as asked, propose another day (held until the day and why are given), decline (a reason; "Other" needs words), the ends
 * (accepted, accepted with another day, declined) with and without our portal, a job answered already, a refusal, the
 * dead link (used, expired), loading and a failed read. Measure at 390 first.
 */

const HOUR = 3_600_000
const NOW = Math.floor(Date.now() / HOUR) * HOUR
const at = (hours: number) => new Date(NOW + hours * HOUR).toISOString()
const dayAt = (days: number) => at(days * 24).slice(0, 10)
const TODAY = dayAt(0)
const id = (n: number) => `0190f0e2-8196-7000-8000-${String(n).padStart(12, '0')}`
const SIZES = ['S', 'M', 'L', 'XL', 'XXL']
const cells = (colourway: string, pieces: readonly number[], base: number) => SIZES.map((size, index) => ({ workOrderSizeId: id(base + index), colourway, size, pieces: pieces[index]! }))

function page(over: { job?: Partial<LinkJobPage['job']>; portalOn?: boolean } = {}): LinkJobPage {
  return {
    job: {
      id: id(1),
      number: 'SC-2026-0012',
      state: 'TO_ANSWER',
      from: { companyName: 'Officina Demo' },
      workOrder: { number: 'WO-2026-0401', style: { code: 'GIA-204', name: 'Giacca Aria' } },
      orderDate: dayAt(-1),
      expectedBackDate: dayAt(12),
      note: 'Cuciture a vista doppie sul collo; filo in tinta.',
      answer: { acceptedAt: null, acceptedByName: null, proposedDate: null, proposedDateReason: null, declinedAt: null, declinedByName: null, dateDecision: null },
      operations: [
        { id: id(11), seq: 10, code: 'CUC', name: 'Cucitura', pieces: 120, sizes: [...cells('Nero', [8, 16, 16, 12, 8], 100), ...cells('Cuoio', [6, 14, 18, 14, 8], 110)], expectedBackDate: dayAt(12), note: null },
        { id: id(12), seq: 20, code: 'BOR', name: 'Bordatura', pieces: 120, sizes: [], expectedBackDate: dayAt(12), note: 'Bordo tinto a mano.' },
      ],
      kit: {
        sentOn: [],
        lines: [
          { seq: 10, item: { code: 'FOD-NY', name: 'Fodera nylon' }, colour: 'Nero', quantity: '84.0000', uom: 'M', status: 'PLANNED', ddt: null },
          { seq: 20, item: { code: 'ZIP-60', name: 'Zip 60 cm' }, colour: 'Nero', quantity: '120.0000', uom: 'PCS', status: 'PLANNED', ddt: null },
        ],
      },
      acts: { accept: false, decline: false, moveDate: false },
      version: 3,
      ...over.job,
    },
    link: { expiresAt: at(24 * 6), usesLeft: 1, live: true },
    portalOn: over.portalOn ?? true,
    locale: 'it',
  }
}

const base = (over: Partial<JobLinkViewModel> = {}): JobLinkViewModel => ({ link: 'valid', page: page(), draft: LINK_DRAFT, today: TODAY, answer: 'idle', end: null, problem: null, ...over })
const draft = (over: Partial<LinkDraft>): LinkDraft => ({ ...LINK_DRAFT, ...over })
const answeredJob = (over: Partial<LinkJobPage['job']['answer']>, state: LinkJobPage['job']['state'] = 'WAITING_KIT') =>
  page({ job: { state, answer: { ...page().job.answer, ...over }, acts: { accept: true, decline: true, moveDate: true } } })

export const designScreen = defineDesignScreen<JobLinkViewModel>({
  screen: 'SCR-196',
  title: 'Accept a job (links.job)',
  view: JobLinkView,
  cases: [
    { id: 'job', label: 'The job, accept as asked', model: base(), note: 'Everything to decide on one phone screen: operations, style, pieces per size, our kit, the due-back day, our notes; Print the job for the bench. No price.' },
    { id: 'move', label: 'Propose another day', model: base({ draft: draft({ mode: 'move' }) }), note: 'Held until the day and why are given.' },
    { id: 'move-ready', label: 'Another day, ready to send', model: base({ draft: draft({ mode: 'move', proposedDate: dayAt(16), reason: 'Due macchine ferme fino a lunedì.', typedName: 'Rosa' }) }) },
    { id: 'decline', label: 'Decline', model: base({ draft: draft({ mode: 'decline' }) }), note: 'Held until a reason is picked.' },
    { id: 'decline-other', label: 'Decline for another reason', model: base({ draft: draft({ mode: 'decline', declineReason: 'OTHER' }) }), note: '“Other” needs a few words.' },
    { id: 'sending', label: 'Sending', model: base({ answer: 'busy' }) },
    { id: 'refused', label: 'Refused: the job changed meanwhile', model: base({ problem: { key: 'problem.changed' } }) },
    { id: 'done-accepted', label: 'Accepted (the workshop has our portal)', model: base({ page: answeredJob({ acceptedAt: at(0), acceptedByName: 'Rosa' }), answer: 'done', end: { tone: 'success', title: { key: 'link.end.acceptedTitle' }, body: { key: 'end.acceptedKit', params: { date: dayAt(2) } } } }), note: '“Accepted — we send the kit on … with our DDT.” “Follow it under Jobs.”' },
    { id: 'done-moved', label: 'Accepted with another day', model: base({ page: answeredJob({ acceptedAt: at(0), acceptedByName: 'Rosa', proposedDate: dayAt(16) }), answer: 'done', end: { tone: 'success', title: { key: 'link.end.acceptedTitle' }, body: { key: 'end.acceptedMoved', params: { date: dayAt(16) } } } }) },
    { id: 'done-declined', label: 'Declined (no portal)', model: base({ page: { ...answeredJob({ declinedAt: at(0), declinedByName: 'Rosa' }, 'DECLINED'), portalOn: false }, answer: 'done', end: { tone: 'neutral', title: { key: 'link.end.declinedTitle' }, body: { key: 'link.end.declined' } } }) },
    { id: 'answered', label: 'Answered already', model: base({ page: answeredJob({ acceptedAt: at(-20), acceptedByName: 'Rosa', proposedDate: dayAt(16) }) }), note: 'The job takes no answer: why, in words; the button is not offered.' },
    { id: 'loading', label: 'Loading', model: base({ page: null }) },
    { id: 'error', label: 'The job could not be read', model: base({ page: null, problem: { key: 'problem.read' } }) },
    { id: 'used', label: 'The link was used', model: base({ link: 'used', page: null }) },
    { id: 'expired', label: 'The link expired', model: base({ link: 'expired', page: null }) },
  ],
})

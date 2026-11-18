import { defineDesignScreen } from '../../../lib/design/design-screen'
import { formatTime } from '../../../lib/i18n/format'
import type { Locale } from '../../../lib/i18n/locales'
import { CATALOGUE, createTranslator } from '../../../lib/i18n/messages'
import { BRAND_BETA } from '../../../lib/testing/two-brands'
import type { OpenItemsRead } from '../documents/api'
import type { ApprovalRead } from '../home/api'
import type { ApproveDialogModel } from '../home/view/ApproveDialog'
import { betaShellOf, PREFIX } from '../requests/design-data'
import type { WaitingApproval } from './api'
import { NS, waitingGroupsOf, waitingRowsOf, type TaskLink } from './model'
import { WaitingCase, type WaitingCaseBuilder } from './view/WaitingCase'
import type { WaitingViewModel } from './view/WaitingView'

/**
 * F-PR-16 (the browser walk; F-PR-14) — Portal › Home › Waiting for you (production plan §5; 06-tree B.3; 09-design (f)), read by
 * Brand Beta (brand B, the reader of every wall scan), MADE-UP data only: the groups (Production approvals, Order, Payment), one verb
 * per row, who asked, the due; a request a named colleague answers ("Waiting for Berta Becker"), a priced counter-offer for the buyer;
 * an answer in its Undo window; the answer dialog open; nothing waits; a failed read. Every number is the customer's own; nothing of
 * another customer.
 */

const say = (en: string, it: string) => ({ en, it })
const NOW = Date.parse('2026-11-18T09:00:00Z')
const AS_OF = '2026-11-18T09:00:00Z'
const id = (n: number) => `b2b2b2b2-0000-4000-8000-${String(700 + n).padStart(12, '0')}`
const STYLE = BRAND_BETA.numbers.style

function approval(n: number, kind: WaitingApproval['kind'], words: { en: string; it: string }, over: Partial<WaitingApproval> = {}): WaitingApproval {
  return { id: id(n), kind, words, question: 'Made-up: please look at it.', dueAt: '2026-11-21T16:00:00Z', status: 'OPEN', waitingFor: null, waitingForBuyer: false, ...over }
}

const FABRIC = approval(1, 'FABRIC', say(`Fabric · ${STYLE}`, `Tessuto · ${STYLE}`), { dueAt: '2026-11-18T15:00:00Z' })
const SAMPLE = approval(2, 'SAMPLE', say(`PP sample · ${STYLE}`, `Campione PP · ${STYLE}`), { waitingFor: BRAND_BETA.portalPerson.name })
const COUNTER = approval(3, 'COUNTER_OFFER', say('Our suggestion · Your order 3', 'La nostra proposta · Il vostro ordine 3'), { waitingForBuyer: true })
const REPROMISE = approval(4, 'REPROMISE', say('New date · Your order 4', 'Nuova data · Il vostro ordine 4'), { dueAt: '2026-11-16T16:00:00Z' })

// Who asked (the frame's task list): a person of the factory who wrote the request.
const task = (approvalId: string, over: Partial<TaskLink> = {}): TaskLink => ({ href: `${PREFIX}/open/ApprovalRequest/${approvalId}`, askedBy: 'Marta Verdi', due: { at: '2026-11-18T15:00:00Z', state: 'soon' }, ...over })

function payments(): OpenItemsRead {
  return {
    asOf: AS_OF,
    invoices: [],
    deposits: [{ depositRequestId: id(9), orderNumber: BRAND_BETA.customerRef, quoteDocument: null, dueDate: '2026-11-15', daysLate: 3, total: 120000, open: 120000, currency: 'EUR', payment: null, canPay: true }],
    byCurrency: [],
    counts: { invoices: 0, overdue: 0, deposits: 1 },
    card: { available: true, methods: ['CARD'], provider: 'PAYMENT_FAKE', mode: 'FAKE', reason: null },
    mayPay: true,
    live: { events: [] },
  }
}

function fabricPage(locale: Locale): ApprovalRead {
  return {
    request: {
      id: FABRIC.id,
      kind: 'FABRIC',
      label: FABRIC.words[locale],
      question: locale === 'it' ? 'Approvate il tessuto per la produzione?' : 'Do you approve the fabric for production?',
      from: { companyName: 'Pelletteria Esempio' },
      dueAt: FABRIC.dueAt,
      status: 'OPEN',
      answer: null,
      version: 1,
    },
    content: { facts: [{ label: locale === 'it' ? 'Modello' : 'Style', value: `${STYLE} Rider jacket` }], revisedOrder: null },
    files: [{ id: id(81), originalName: 'fabric-swatch.jpg', contentType: 'image/jpeg', sizeBytes: 320_000 }],
    may: { answer: true, withChanges: true },
    locale,
  }
}

function dialogOf(locale: Locale): ApproveDialogModel {
  return { requestId: FABRIC.id, state: 'ready', page: fabricPage(locale), position: { index: 1, count: 2 }, decision: null, comment: '', answer: 'idle', problem: null, field: null, held: null, file: null, now: NOW, pending: null }
}

function pageOf(locale: Locale, over: Partial<WaitingViewModel> = {}): WaitingViewModel {
  const rows = waitingRowsOf({ approvals: [FABRIC, SAMPLE, COUNTER, REPROMISE], tasks: [task(FABRIC.id), task(REPROMISE.id, { askedBy: null, due: { at: REPROMISE.dueAt, state: 'overdue' } })], payments: payments(), locale, prefix: PREFIX, now: NOW })
  return { state: 'ready', groups: waitingGroupsOf(rows), done: {}, notice: null, dialog: null, now: NOW, ...over }
}

function waitingCase(build: (locale: Locale) => Partial<WaitingViewModel> = () => ({})): WaitingCaseBuilder {
  return (locale) => {
    const t = createTranslator(locale, CATALOGUE[locale][NS] ?? {})
    return {
      shell: betaShellOf(locale, { title: t('page.title'), status: { label: t('page.updated', { time: formatTime(AS_OF, { locale }) }), tone: 'neutral' } }, '/waiting'),
      page: pageOf(locale, build(locale)),
      opens: { dialog: dialogOf(locale) },
    }
  }
}

export const designScreen = defineDesignScreen<WaitingCaseBuilder>({
  screen: 'SCR-183-waiting',
  title: 'Waiting for you (portal › Home, Brand Beta)',
  view: WaitingCase,
  cases: [
    {
      id: 'list',
      label: 'F-PR-14 · Waiting for you: Production approvals, Order, Payment; one verb per row',
      model: waitingCase(),
      note: 'Who asked and the due (overdue first); "Waiting for Berta Becker" (her named colleague answers), the priced counter-offer for the buyer; Review opens the answer dialog.',
    },
    { id: 'pending', label: 'F-PR-14 · An answer signed here: it goes to us in 10 seconds, Undo until then', model: waitingCase(() => ({ done: { [FABRIC.id]: { phase: 'pending', decision: 'APPROVED' } } })) },
    { id: 'dialog', label: 'F-PR-14 · Review: the answer dialog (Approve · Approve with changes · Refuse, the typed name)', model: waitingCase((locale) => ({ dialog: dialogOf(locale) })) },
    { id: 'empty', label: 'Nothing waits for you', model: waitingCase(() => ({ groups: [] })) },
    { id: 'error', label: 'The list could not be read (never drawn as empty)', model: waitingCase(() => ({ state: 'error', groups: [] })) },
  ],
})

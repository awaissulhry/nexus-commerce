import type { PartnerMessage } from '@nexus/ui/patterns/PartnerThread/index'
import { formatDateTime } from '../../../lib/i18n/format'
import type { Locale } from '../../../lib/i18n/locales'
import { BRAND_BETA } from '../../../lib/testing/two-brands'
import type { ThreadViewModel } from '../../shell/view/ThreadView'
import type { NewsEntry, PortalProject } from './api'

/**
 * The made-up world of a project in the portal (B-TH-253; PLAN §3.1): the reader is Brand Beta (lib/testing/two-brands, brand B),
 * so every case can be scanned for Brand Alpha (brand A) and must hold nothing of it (T00 at the screen level). The office's
 * project numbers are in the data, as the API sends them (PRJ-…), and must never be drawn. A supplier's project is a tannery's
 * (Conceria Prova): it never names a customer. Never a real company, person, address or number.
 */

const HOUR = 3_600_000
export const NOW = Math.floor(Date.now() / HOUR) * HOUR
export const at = (hours: number) => new Date(NOW + hours * HOUR).toISOString()
export const dayAt = (days: number) => at(days * 24).slice(0, 10)
const id = (n: number) => `b2b2b2b2-0000-4000-8000-${String(800 + n).padStart(12, '0')}`

export const PROJECT_ID = id(1)

/** Brand B's projects it was added to (open first, then by target date, as GET /portal/projects answers). */
export const BETA_PROJECTS: readonly PortalProject[] = [
  { id: PROJECT_ID, number: 'PRJ-26-012', name: 'Winter touring line', status: 'ACTIVE', targetDate: dayAt(45) },
  { id: id(2), number: 'PRJ-26-015', name: 'Club vests with embroidered names', status: 'ON_HOLD', targetDate: dayAt(70) },
  { id: id(3), number: 'PRJ-25-031', name: 'Rain jackets, spring range', status: 'CLOSED', targetDate: dayAt(-60) },
]

/** A supplier's project (a tannery the factory works with): no customer is ever named in it. */
export const SUPPLIER_PROJECT: PortalProject = { id: id(9), number: 'PRJ-26-019', name: 'New tanned leather for the touring line', status: 'ACTIVE', targetDate: dayAt(30) }

/** The news of brand B's own records linked to the project (only records its portal opens: its order, its round, its style). */
export function newsOf(): NewsEntry[] {
  return [
    { id: id(21), at: at(-3), recordType: 'SampleRound', recordId: id(31), theirRef: null, ourRef: 'Fit round 2', status: { from: 'IN_PROGRESS', to: 'SENT' }, folded: 1 },
    { id: id(22), at: at(-26), recordType: 'SalesOrder', recordId: BRAND_BETA.ids.order, theirRef: BRAND_BETA.customerRef, ourRef: '#12', status: { from: 'CONFIRMED', to: 'IN_PRODUCTION' }, folded: 3 },
    { id: id(23), at: at(-50), recordType: 'Style', recordId: id(33), theirRef: null, ourRef: BRAND_BETA.numbers.style, status: { from: 'DRAFT_INTERNAL', to: 'APPROVED' }, folded: 1 },
    { id: id(24), at: at(-80), recordType: 'Quote', recordId: id(34), theirRef: null, ourRef: '#3', status: { from: 'SOMETHING_ELSE', to: 'ANOTHER_CODE' }, folded: 1 },
  ]
}

const message = (n: number, side: 'company' | 'partner', body: string, hours: number, locale: Locale, name: string, mine: boolean): PartnerMessage => ({
  id: `pm${n}`,
  side,
  channel: 'portal',
  author: { name, mine },
  body,
  attachments: [],
  at: at(hours),
  atText: formatDateTime(at(hours), { locale }),
})

/** The project's conversation as brand B reads it: our shared messages and theirs, never an office note (the type has none). */
export function projectThreadOf(locale: Locale, over: { messages?: 'some' | 'none'; held?: string | null; accessLine?: string | null; companyName?: string; partner?: { name: string } } = {}): ThreadViewModel {
  const partner = over.partner ?? { name: BRAND_BETA.portalPerson.name }
  const messages: PartnerMessage[] =
    over.messages === 'none'
      ? []
      : [
          message(1, 'company', over.partner ? (locale === 'it' ? 'Benvenuti nel progetto: qui parliamo della pelle nuova.' : 'Welcome to the project: here we talk about the new leather.') : locale === 'it' ? 'Benvenuti nel progetto: qui parliamo dell’intera linea invernale, modello per modello.' : 'Welcome to the project: here we talk about the whole winter line, style by style.', -72, locale, 'Alex Demo', false),
          message(2, 'partner', over.partner ? (locale === 'it' ? 'Le pelli conciate nuove sono pronte per la prova.' : 'The newly tanned hides are ready for the trial.') : BRAND_BETA.message, -48, locale, partner.name, true),
          message(3, 'company', over.partner ? (locale === 'it' ? 'Le prove di taglio sono fissate per giovedì.' : 'The cutting trials are set for Thursday.') : locale === 'it' ? 'Il giro di prova 2 è partito oggi.' : 'Fit round 2 left today.', -3, locale, 'Alex Demo', false),
        ]
  const title = locale === 'it' ? 'Messaggi su questo progetto' : 'Messages about this project'
  return {
    state: 'ready',
    title,
    record: null,
    companyName: over.companyName ?? 'Pelletteria Esempio',
    messages,
    composer: { value: '', busy: false, heldReason: over.held ?? null, hint: over.held ? null : locale === 'it' ? 'Potete anche rispondere alle nostre e-mail.' : 'You can also answer our e-mails.', limit: 20_000 },
    loadMore: null,
    accessLine: over.accessLine ?? null,
    failed: null,
  }
}

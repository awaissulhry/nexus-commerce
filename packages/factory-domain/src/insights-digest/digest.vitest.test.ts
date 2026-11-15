import { describe, expect, it } from 'vitest'
import { FACTORY_PERMISSIONS } from '../auth/permissions/catalogue'
import { EVENT_CATALOGUE } from '../events/catalogue'
import { DIGEST_SECTIONS, SECTION_NEEDS, digestDueNow, digestHeld, digestKey, digestMail, insightsKey, nextSendAt, sectionsInOrder, settingProblems, type DigestContent, type DigestSectionContent } from './digest'
import { HOME_DIGEST_SWITCH } from './permissions'
import { databaseDigestRefusal } from './refusals'
import { REPORT_TITLE_KEYS, periodWords, reportMail, reportTitleIn } from './report-mail'

/** The owner digest's pure rules (B-W2b-435; ANA-032; follow-up DG1:01). */

const settings = { sendTime: '07:30', timeZone: 'Europe/Rome', weekdays: [1, 2, 3, 4, 5] }
const ready = (section: DigestSectionContent['section'], fields: Partial<DigestSectionContent> = {}): DigestSectionContent => ({ section, state: 'READY', count: 0, extra: null, percent: null, amount: null, items: [], ...fields })

describe('settings', () => {
  it('holds a time, a known clock, ascending weekdays, a language and at least one section', () => {
    expect(settingProblems({ ...settings, locale: 'it', sections: [...DIGEST_SECTIONS] })).toEqual([])
    const problems = settingProblems({ sendTime: '7:30', timeZone: 'Mars/Base', weekdays: [3, 1], locale: 'de', sections: [] }).map((problem) => problem.path)
    expect(problems).toEqual(['body/sendTime', 'body/timeZone', 'body/weekdays', 'body/locale', 'body/sections'])
    expect(settingProblems({ ...settings, locale: 'en', sections: ['ALERTS', 'ALERTS'] }).map((problem) => problem.path)).toEqual(['body/sections'])
    expect(sectionsInOrder(['APPROVALS', 'SHIPPED'])).toEqual(['SHIPPED', 'APPROVALS'])
    expect(digestKey('u1')).toBe('digest:u1')
    expect(insightsKey('c1')).toBe('insights:c1')
  })

  it('every section names what it reads; the switch is a declared permission', () => {
    for (const section of DIGEST_SECTIONS) for (const permission of SECTION_NEEDS[section]) expect(FACTORY_PERMISSIONS.isDeclared(permission), permission).toBe(true)
    expect(FACTORY_PERMISSIONS.get(HOME_DIGEST_SWITCH)?.risk).toBe('write')
    for (const type of ['digest.changed', 'digest.switch_changed', 'digest.sent', 'report_subscription.changed', 'report_subscription.sent', 'alert.route_added', 'alert.route_removed']) expect(EVENT_CATALOGUE.find(type, 1), type).toBeDefined()
  })
})

describe('when it goes out (07:30 site time, Monday to Friday)', () => {
  // Friday 13 Nov 2026, 06:00 UTC = 07:00 in Rome.
  const friday0700 = new Date('2026-11-13T06:00:00Z')
  const friday0745 = new Date('2026-11-13T06:45:00Z')

  it('is due once its time passed on its clock, on its weekdays, once a day', () => {
    expect(digestDueNow(settings, null, friday0700)).toBe(false)
    expect(digestDueNow(settings, null, friday0745)).toBe(true)
    expect(digestDueNow(settings, new Date('2026-11-13T06:31:00Z'), friday0745)).toBe(false)
    expect(digestDueNow(settings, new Date('2026-11-12T06:31:00Z'), friday0745)).toBe(true)
    // Saturday: not one of its days.
    expect(digestDueNow(settings, null, new Date('2026-11-14T08:00:00Z'))).toBe(false)
    // New York's 07:30 is 12:30 UTC.
    expect(digestDueNow({ ...settings, timeZone: 'America/New_York' }, null, new Date('2026-11-13T12:00:00Z'))).toBe(false)
    expect(digestDueNow({ ...settings, timeZone: 'America/New_York' }, null, new Date('2026-11-13T12:31:00Z'))).toBe(true)
  })

  it('says when it goes out next: later today, or the next of its days', () => {
    expect(nextSendAt(settings, friday0700, false)?.toISOString()).toBe('2026-11-13T06:30:00.000Z')
    // Sent today (or past its time): Monday.
    expect(nextSendAt(settings, friday0700, true)?.toISOString()).toBe('2026-11-16T06:30:00.000Z')
    expect(nextSendAt(settings, friday0745, false)?.toISOString()).toBe('2026-11-16T06:30:00.000Z')
    // The clocks change on 29 March 2026: 07:30 in Rome is 05:30 UTC from then on.
    expect(nextSendAt(settings, new Date('2026-03-27T08:00:00Z'), false)?.toISOString()).toBe('2026-03-30T05:30:00.000Z')
  })

  it('is held while it is off, or while no company it covers has its morning e-mail on', () => {
    expect(digestHeld(false, 2)).toBe('OFF')
    expect(digestHeld(true, 0)).toBe('MAIL_OFF')
    expect(digestHeld(true, 1)).toBeNull()
  })
})

describe('what it says', () => {
  const content: DigestContent = {
    day: '2026-11-12',
    today: '2026-11-13',
    companies: ['Officina Demo'],
    sections: [
      ready('SHIPPED', { count: 4, percent: '75.0', items: [{ label: 'SH-1', days: null, place: null, record: null }, { label: 'SH-2', days: null, place: null, record: null }] }),
      ready('LATE', { count: 1, items: [{ label: 'SO-12', days: 3, place: null, record: null }] }),
      ready('NEW_ORDERS', { count: 2, amount: { minor: 1240000, currency: 'EUR', grain: 'price' }, items: [{ label: 'SO-31', days: null, place: null, record: null }, { label: 'SO-32', days: null, place: null, record: null }] }),
      { ...ready('WIP_STUCK'), state: 'NO_ACCESS' },
      ready('ALERTS', { count: 0, extra: 0 }),
      { ...ready('APPROVALS'), state: 'FAILED' },
    ],
  }
  const links = { today: 'https://factory.example.com/w/DEMO/home/today', settings: 'https://factory.example.com/w/DEMO/home/reports#digest' }

  it('in Italian: one line per section, the money with its grain, the left-out sections, never a person', () => {
    const mail = digestMail(content, 'it', links)
    expect(mail.subject).toBe('Il riepilogo del mattino · venerdì 13 novembre')
    expect(mail.lines[0]).toBe('Ieri, giovedì 12 novembre · Officina Demo.')
    expect(mail.lines).toContain('• Spedito ieri: 4 spedizioni (75,0 % in tempo): SH-1, SH-2 e altri 2.')
    expect(mail.lines).toContain('• In ritardo: 1 ordine oltre la data promessa: SO-12 (3 giorni).')
    expect(mail.lines).toContain('• Nuovi ordini ieri: 2 ordini, per € 12.400,00: SO-31, SO-32.')
    expect(mail.lines).toContain('• Avvisi: nessuno aperto.')
    expect(mail.lines).toContain('• Approvazioni: non è stato possibile leggerlo questa volta.')
    expect(mail.lines).toContain('Lasciato fuori per i tuoi permessi: Lavorazioni ferme.')
    expect(mail.lines).toContain('Numeri per azienda, linea e ordine, mai per persona.')
    expect(mail.lines.at(-1)).toBe(`Cambia o ferma questa e-mail: ${links.settings}`)
  })

  it('in English, and a test says so; without the amount no money is written', () => {
    const mail = digestMail({ ...content, sections: [ready('NEW_ORDERS', { count: 1, items: [{ label: 'SO-31', days: null, place: null, record: null }] }), ready('WIP_STUCK', { count: 2, extra: 46, amount: { minor: 528000, currency: 'EUR', grain: 'cost' }, items: [{ label: 'WO-98', days: 5, place: 'L1', record: null }] })] }, 'en', links, true)
    expect(mail.subject).toBe('[Test] Your morning summary · Friday 13 November')
    expect(mail.lines).toContain('• New orders yesterday: 1 order: SO-31.')
    expect(mail.lines).toContain('• Work stuck for more than 2 days: 2 work orders, 46 garments waiting, €5,280.00 at cost: WO-98 (L1, 5 days) and 1 more.')
    expect(mail.lines.join('\n')).not.toMatch(/€.*New orders/)
  })
})

describe('the database refusals in words', () => {
  it('maps the digest, switch and route guards to their paths', () => {
    expect(databaseDigestRefusal("digest: digest 0190 goes out only while its company's morning e-mail is switched on")?.path).toBe('digest/MAIL_OFF')
    expect(databaseDigestRefusal('digest: digest 0190 goes out at a time of day HH:MM (07:30)')?.path).toBe('body/sendTime')
    expect(databaseDigestRefusal('insights: the settings of company 0190 are switched off, never deleted')?.path).toBe('switch/STATE')
    expect(databaseDigestRefusal("alerts: route 0190 never widens its rule's place: the rule looks at company x, the site is of another")?.path).toBe('route/WIDER')
    expect(databaseDigestRefusal('alerts: route 0190 names a line that does not exist (a customer: a party we sell to, or a brand)')?.path).toBe('route/PLACE')
    expect(databaseDigestRefusal('alerts: route 0190 is added or removed, never changed')?.path).toBe('route/KEPT')
    expect(databaseDigestRefusal('kpis: something else')).toBeNull()
  })
})

describe('a report by e-mail (DG1:01)', () => {
  it('says the report in the reader’s language, its filters, the rows and the first records', () => {
    expect(REPORT_TITLE_KEYS).toContain('sales.late-orders')
    expect(reportTitleIn('sales.late-orders', 'Late orders', 'it')).toBe('Ordini in ritardo')
    expect(reportTitleIn('area.unknown', 'Unknown', 'it')).toBe('Unknown')
    expect(periodWords('THIS_WEEK', 'it')).toBe('questa settimana')
    expect(periodWords('NOT_A_PERIOD', 'en')).toBeNull()
    const records = Array.from({ length: 12 }, (_, index) => `SO-${index + 1}`)
    const mail = reportMail({ title: 'Late orders', today: '2026-11-13', period: 'this week', site: 'A1', rows: 12, complete: true, records, leftOut: 1, link: 'https://x.example.com/r', settings: 'https://x.example.com/s' }, 'en')
    expect(mail.subject).toBe('Late orders · Friday 13 November')
    expect(mail.lines[0]).toBe('Late orders (this week, A1), Friday 13 November.')
    expect(mail.lines).toContain('Rows found: 12.')
    expect(mail.lines).toContain('First: SO-1, SO-2, SO-3, SO-4, SO-5, SO-6, SO-7, SO-8, SO-9, SO-10 and 2 more.')
    expect(mail.lines).toContain('Some columns are left out because of your rights: the report says which.')
    const none = reportMail({ title: 'Ordini in ritardo', today: '2026-11-13', period: null, site: null, rows: 0, complete: false, records: [], leftOut: 0, link: 'l', settings: 's' }, 'it')
    expect(none.lines).toContain('Nessuna riga con questi filtri.')
  })
})

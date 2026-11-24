import type { ComponentType } from 'react'
import { describe, expect, it } from 'vitest'
import { LOCALES, type Locale } from '../../../../../lib/i18n/locales'
import { leftKeys, renderView, textOf } from '../../../../../lib/record-thread/parts/testing'
import { designScreen } from '../fixtures'
import { CA_CASES, CA_PARTS } from './_demo/fixtures'

/**
 * F-CA T.1 / T.2 (customer page › PEOPLE & ADDRESSES tab, lane ca- ca-t; 15-steps T.1, T.2) — the gallery's `ca-*` cases of SCR-033: all
 * there, each drawing the People tab in both languages with no key and no placeholder left on screen, split per language and per part
 * (a long gallery test is split: the lessons list), and each state saying what it is, in English and in Italian. A window's case draws
 * the tab and the window's inside on a plain card: no Modal and no Menu open on the server render.
 */

const view = designScreen.view as ComponentType<{ model: unknown }>
const caseOf = (id: string) => designScreen.cases.find((item) => item.id === id)
const draw = (id: string, locale: Locale = 'en') => renderView(view, caseOf(id)!.model, locale)
const words = (id: string, locale: Locale = 'en') => textOf(draw(id, locale))
const CA_IDS = designScreen.cases.filter((item) => item.id.startsWith('ca-')).map((item) => item.id)
const EMAIL = /[\w.+-]+@[\w.-]+/g
/** The key prefixes the tab says words from (its own catalogue and the words it reuses): none may be left on screen. */
const KEYS = ['answer', 'chip', 'filter', 'people', 'gets', 'used', 'portal', 'privacy', 'row', 'held', 'bulk', 'addresses', 'address', 'check', 'refuse', 'done', 'part', 'riders', 'rider', 'team', 'archive', 'contactRole', 'addressKind', 'master', 'status', 'role', 'review', 'basis', 'problem', 'common']

describe('F-CA T.1: the People tab\'s gallery cases (SCR-033, ids ca-*)', () => {
  it('every case of 15-steps T.1 is there, once, and no other ca-* case', () => {
    expect([...CA_IDS].sort()).toEqual(Object.values(CA_PARTS).flat().sort())
    expect(new Set(CA_IDS).size).toBe(CA_IDS.length)
    expect(CA_CASES.map((item) => item.id).sort()).toEqual([...CA_IDS].sort())
  })

  for (const locale of LOCALES) {
    for (const [part, ids] of Object.entries(CA_PARTS)) {
      it(`${locale} · ${part}: each case draws the People tab with no key and no placeholder left on screen`, () => {
        for (const id of ids) {
          const html = draw(id, locale)
          expect(html, id).toContain('class="fw-pt fw-ca"')
          expect(leftKeys(html.replace(EMAIL, ''), KEYS), `${id} (${locale})`).toEqual([])
          expect(textOf(html).match(/\{[a-zA-Z]+\}/)?.[0] ?? null, `${id} (${locale}) placeholder`).toBeNull()
        }
      })
    }
  }

  it('the busy team draws every section, each at its address', () => {
    const html = draw('ca-busy')
    for (const id of ['answer', 'people', 'addresses', 'riders', 'personal-data']) expect(html, id).toContain(`id="${id}"`)
  })

  /** What each state says, in English and in Italian (the catalogues' own words, filled). */
  const STATES: ReadonlyArray<readonly [string, readonly string[], readonly string[]]> = [
    ['ca-new', ['Nobody and no address yet'], ['Ancora nessuno e nessun indirizzo']],
    ['ca-check', ['1 address waits for our check', 'Waits for our check', 'Refused on 19/10/2026 by Carlo Prova'], ['1 indirizzo attende il nostro controllo', 'Attende il nostro controllo', 'Rifiutato il 19/10/2026 da Carlo Prova']],
    ['ca-privacy', ['Lawful basis missing', 'Erased contact', 'Objected 03/10/2026'], ['Base giuridica mancante', 'Contatto cancellato', 'Opposizione 03/10/2026']],
    ['ca-seats', ['Seats full (5 of 5)', '1 invitation expired', '1 access ends within 14 days'], ['Posti esauriti (5 di 5)', '1 invito scaduto', '1 accesso scade entro 14 giorni']],
    ['ca-invoices', ['Nobody gets invoices', '2 registered offices'], ['Nessuno riceve le fatture', '2 sedi legali']],
    ['ca-rider', ['Team: Seed Customer One S.r.l. ›'], ['Squadra: Seed Customer One S.r.l. ›']],
    ['ca-many', ['Show 4 more people', 'Show 5 more riders', 'Show 1 more address'], ['Mostra altre 4 persone', 'Mostra altri 5 piloti', 'Mostra 1 altro indirizzo']],
    ['ca-chip-check', ['Showing the 1 address that waits for our check.'], ['È mostrato 1 indirizzo che attende il nostro controllo.']],
    ['ca-no-portal-right', ['portal access is not shown for your role'], ['l\'accesso al portale non è mostrato per il tuo ruolo']],
    ['ca-no-measurements-right', ['profiles are not shown: your role does not see measurement profiles'], ['i profili non sono mostrati: il tuo ruolo non vede i profili di misura']],
    ['ca-reading-privacy', ['Reading the personal data of the contacts…'], ['Lettura dei dati personali dei contatti…']],
    ['ca-reading-riders', ['Reading the riders and their profiles…'], ['Lettura dei piloti e dei loro profili…']],
    ['ca-failed-portal', ['Couldn\'t load the portal access'], ['Impossibile caricare l\'accesso al portale']],
    ['ca-failed-privacy', ['Couldn\'t load the personal data of the contacts'], ['Impossibile caricare i dati personali dei contatti']],
    ['ca-failed-profiles', ['Couldn\'t load the measurement profiles'], ['Impossibile caricare i profili di misura']],
    ['ca-failed-riders', ['Couldn\'t load the riders'], ['Impossibile caricare i piloti']],
    ['ca-failed-all', ['Couldn\'t load the portal access', 'Couldn\'t load the personal data of the contacts', 'Couldn\'t load the measurement profiles', 'Couldn\'t load the riders'], ['Impossibile caricare l\'accesso al portale', 'Impossibile caricare i piloti']],
  ]
  for (const locale of LOCALES) {
    it(`${locale} · each state says what it is`, () => {
      for (const [id, en, it_] of STATES) {
        const text = words(id, locale)
        for (const part of locale === 'en' ? en : it_) expect(text, `${id} (${locale})`).toContain(part)
      }
    })
  }

  it('a read still out or failed is never said as 0: the portal column waits, the usage lines are left out', () => {
    expect(words('ca-busy')).toContain('Sees prices')
    expect(words('ca-reading-portal')).not.toContain('Sees prices')
    expect(words('ca-failed-portal')).not.toContain('Sees prices')
    expect(words('ca-busy')).toContain('2 open quotes')
    for (const id of ['ca-failed-usage', 'ca-reading-all']) expect(words(id), id).not.toContain('2 open quotes')
  })

  it('an archived customer holds every change by its state, with its words', () => {
    expect(draw('ca-archived')).toContain('aria-description="Archived: reactivate it first"')
    expect(draw('ca-archived', 'it')).toContain('aria-description="Archiviato: prima riattivalo"')
    expect(draw('ca-busy')).not.toContain('aria-description="Archived: reactivate it first"')
  })

  it('the rooms: the tab is laid out in the room it has (343 / 865 / 1314 / 1794 px)', () => {
    for (const room of [343, 865, 1314, 1794]) expect(draw(`ca-room-${room}`), String(room)).toContain(`data-ca-room="${room}"`)
  })

  it('a window\'s case never opens a Modal or a Menu on the server render: the tab is there and the window\'s inside on a plain card', () => {
    const dialogs = (html: string) => html.split('role="dialog"').length
    const menus = (html: string) => html.split('role="menu"').length
    // Each window against its customer's own case (the same tab without the window).
    const base = (id: string) => CA_CASES.find((item) => CA_PARTS.picture.some((picture) => picture === item.id) && item.ca.customer === CA_CASES.find((entry) => entry.id === id)!.ca.customer)!.id
    for (const id of CA_PARTS.windows) {
      const html = draw(id)
      const page = draw(base(id))
      expect(dialogs(html), id).toBe(dialogs(page))
      expect(menus(html), id).toBe(menus(page))
      expect(html, id).toContain('id="people"')
      expect(html.length, id).toBeGreaterThan(page.length)
    }
  })

  /** Each window's inside: its title and what it says, in English and in Italian. */
  const WINDOWS: ReadonlyArray<readonly [string, readonly string[], readonly string[]]> = [
    ['ca-win-refuse', ['Refuse the delivery address', 'Ospitalità Monza'], ['Rifiuta l\'indirizzo di consegna', 'Ospitalità Monza']],
    ['ca-win-refuse-short', ['Say why the address is not accepted: the customer reads it.'], ['Di\' perché l\'indirizzo non è accettato: il cliente lo legge.']],
    ['ca-win-refuse-failed', ['Someone else changed this meanwhile.'], ['Qualcun altro l’ha cambiata nel frattempo.']],
    ['ca-win-rider', ['Add a rider to Seed Racing'], ['Aggiungi un pilota a Seed Racing']],
    ['ca-win-rider-found', ['Pilota Esempio', 'SEED-P03 · Bologna'], ['Pilota Esempio', 'SEED-P03 · Bologna']],
    ['ca-win-rider-made', ['Nuovo Pilota Seed was made, not yet under Seed Racing: Try again.'], ['Nuovo Pilota Seed è stato creato, ma non è ancora sotto Seed Racing: riprova.']],
    ['ca-win-team-move', ['Change the team of Pilota Seed', 'To Seed Corse Due'], ['Cambia la squadra di Pilota Seed', 'In Seed Corse Due']],
    ['ca-win-team-off', ['Pilota Seed stays a customer of its own, with its orders and measurements.'], ['Pilota Seed resta un cliente a sé, con i suoi ordini e le sue misure.']],
    ['ca-win-archive-contact', ['Archive Giada Seed?', 'Still signs in to the portal'], ['Archiviare Giada Seed?', 'Accede ancora al portale']],
    ['ca-win-archive-address', ['Archive “Officina”?', 'The default for deliveries: after this there is none', 'Named on 1 draft quote'], ['Archiviare “Officina”?', 'Il predefinito per le consegne', 'Indicato su 1 preventivo in bozza']],
  ]
  for (const locale of LOCALES) {
    it(`${locale} · each window's inside says what it is`, () => {
      for (const [id, en, it_] of WINDOWS) {
        const text = words(id, locale)
        for (const part of locale === 'en' ? en : it_) expect(text, `${id} (${locale})`).toContain(part)
      }
    })
  }
})


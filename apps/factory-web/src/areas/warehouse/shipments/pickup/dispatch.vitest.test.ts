import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { DAY_SHEET_REFUSALS as DOMAIN_DAY_SHEET_REFUSALS, DAY_SHEET_LOOKBACK_DAYS } from '@nexus/factory-domain/shipping/manifest/rules'
import { PICKUP_LIMITS, PICKUP_REFUSALS as DOMAIN_PICKUP_REFUSALS, PICKUP_STATUSES as DOMAIN_PICKUP_STATUSES, PICKUP_VIAS as DOMAIN_PICKUP_VIAS } from '@nexus/factory-domain/shipping/pickups/rules'
import { ApiError } from '../../../../lib/api/errors'
import { LOCALES } from '../../../../lib/i18n/locales'
import { CATALOGUE, messagesFor } from '../../../../lib/i18n/messages'
import { I18nProvider } from '../../../../lib/i18n/provider'
import { designScreen as contractsScreen } from '../../shipping/contracts/fixtures'
import { contractOrder, contractProblem, scopeWords } from '../../shipping/contracts/model'
import { designScreen as eoriScreen } from '../../shipping/eori/fixtures'
import { eoriProblem, saveHeld } from '../../shipping/eori/model'
import { designScreen as packagingScreen } from '../../shipping/packaging/fixtures'
import { defaultProblem, typeBody, typeFormOf, typeProblems } from '../../shipping/packaging/model'
import { designScreen as testModeScreen } from '../../shipping/test-mode/fixtures'
import { liveHeld, testHeld } from '../../shipping/test-mode/model'
import { ShipmentsListView } from '../list/view/ShipmentsListView'
import { endOfDaySchema, manifestSchema } from '../end-of-day/api'
import { designScreen as eodScreen, endOfDay } from '../end-of-day/fixtures'
import { designScreen as listScreen } from '../end-of-day/list/fixtures'
import { pickupable, pickupHeld, pickupSite } from '../end-of-day/list-model'
import { carrierState, closableDays, closeHeld, DAY_SHEET_REFUSALS, handOverOf, handOverRefusal, LOOKBACK_DAYS, outcomeWords, startChosen } from '../end-of-day/model'
import { designScreen as manifestScreen } from '../end-of-day/window/fixtures'
import { exportSchema } from '../export/api'
import { designScreen as exportScreen } from '../export/fixtures'
import { dialogProblem, exitClock, exitHeld, exportState, invoiceHeld, linkHeld, postalChoices } from '../export/model'
import { designScreen as paperScreen } from '../export/window/fixtures'
import { draftSchema } from './api'
import { designScreen as pickupScreen } from './fixtures'
import { bookBody, bookHeld, cardPickup, formOf, formProblems, moveHeld, PICKUP_MAX, PICKUP_REFUSALS, PICKUP_STATUSES, PICKUP_VIAS, pickupsByCarrier, viaHeld } from './model'
import { dispatchAbilitiesOf, DISPATCH_NS, wallOf } from './dispatch'

/** B-W2b-412 — pickups, the day's close, export and shipping settings on screen: the rules, the fixtures as API answers, every case in it and en. */

const caseOf = <M,>(screen: { cases: readonly { id: string; model: M }[] }, id: string): M => screen.cases.find((entry) => entry.id === id)!.model
const conflict = (code: string) => new ApiError('conflict', 409, 'conflict', 'refused', null, [{ path: `refusal/${code}`, message: 'x' }])

describe('the lists mirror the server-only domain modules', () => {
  it('pickups and day sheets say the same codes as factory-domain', () => {
    expect([...PICKUP_VIAS]).toEqual([...DOMAIN_PICKUP_VIAS])
    expect([...PICKUP_STATUSES]).toEqual([...DOMAIN_PICKUP_STATUSES])
    expect([...PICKUP_REFUSALS]).toEqual([...DOMAIN_PICKUP_REFUSALS])
    expect([...DAY_SHEET_REFUSALS]).toEqual([...DOMAIN_DAY_SHEET_REFUSALS])
    expect(LOOKBACK_DAYS).toBe(DAY_SHEET_LOOKBACK_DAYS)
    expect(PICKUP_MAX).toMatchObject({ count: PICKUP_LIMITS.count, note: PICKUP_LIMITS.note, words: PICKUP_LIMITS.words, reference: PICKUP_LIMITS.reference, weightKg: PICKUP_LIMITS.weightKg, aheadDays: PICKUP_LIMITS.aheadDays, pastSkewMs: PICKUP_LIMITS.pastSkewMs })
  })
})

describe('Book a pickup (SCR-650)', () => {
  const live = caseOf(pickupScreen, 'live')
  const draft = live.draft.state === 'ready' ? live.draft.value : null!

  it('the fixtures are answers the API may give', () => {
    for (const item of pickupScreen.cases) if (item.model.draft.state === 'ready') expect(() => draftSchema.parse(item.model.draft.state === 'ready' ? item.model.draft.value : null)).not.toThrow()
  })

  it('starts through Sendcloud when it may, else by phone; a held way says its code', () => {
    expect(formOf(draft).via).toBe('SENDCLOUD')
    const held = caseOf(pickupScreen, 'no-connection').draft
    if (held.state !== 'ready') throw new Error('not ready')
    expect(formOf(held.value).via).toBe('PHONE')
    expect(viaHeld(held.value, 'SENDCLOUD')?.key).toBe('pickup.refusal.NO_CONNECTION')
    expect(viaHeld(held.value, 'PHONE')).toBeNull()
  })

  it('says each problem by field: a phone booking needs its note, a round its days; nothing to collect', () => {
    const form = { ...formOf(draft), via: 'PHONE' as const, parcels: 0, pallets: 0, recurring: true }
    const problems = formProblems(form)
    expect(problems.note?.key).toBe('pickup.problem.note')
    expect(problems.weekdays?.key).toBe('pickup.problem.weekdays')
    expect(problems.parcels?.key).toBe('pickup.problem.nothing')
    expect(formProblems({ ...formOf(draft), readyAt: '2020-01-01T08:00:00.000Z' }).readyAt?.key).toBe('pickup.problem.readyPast')
    expect(formProblems({ ...formOf(draft), weightKg: '1,5' }).weightKg?.key).toBe('pickup.problem.weight')
    expect(bookHeld({ ...form, note: 'x', recurring: false, parcels: 1 }, draft, { bookPickups: false }, false)?.key).toBe('pickup.held.noRight')
    expect(bookHeld(form, draft, { bookPickups: true }, false)?.key).toBe('pickup.held.problems')
  })

  it('sends only what each way keeps: the weight to Sendcloud, the note, reference and round by phone', () => {
    const sendcloud = bookBody({ ...formOf(draft), weightKg: '23.4' }, draft)
    expect(sendcloud).toMatchObject({ via: 'SENDCLOUD', carrierCode: 'demo-express', parcels: 6, pallets: 0, weightKg: '23.4' })
    expect(sendcloud).not.toHaveProperty('note')
    expect(sendcloud).not.toHaveProperty('address')
    const phone = bookBody({ ...formOf(draft), via: 'PHONE', note: ' Desk ', reference: '', recurring: true, weekdays: ['THURSDAY', 'TUESDAY'] }, draft)
    expect(phone).toMatchObject({ via: 'PHONE', note: 'Desk', repeatWeekdays: ['TUESDAY', 'THURSDAY'] })
    expect(phone).not.toHaveProperty('weightKg')
    expect(phone).not.toHaveProperty('providerReference')
    const other = bookBody({ ...formOf(draft), otherAddress: true, address: { name: 'N', line1: 'L', postalCode: '1', city: 'C', province: '', country: 'it', phone: '' } }, draft)
    expect(other.address).toMatchObject({ country: 'IT', province: null, phone: null, line2: null, email: null })
  })

  it('the cut-off card says the day\'s pickups: a failure first; a call-off is not counted', () => {
    const rows = caseOf(pickupScreen, 'coming-today').draft
    if (rows.state !== 'ready') throw new Error('not ready')
    const byCarrier = pickupsByCarrier(rows.value.alreadyToday)
    expect(byCarrier.get('demo-express')?.map((row) => row.readyTime)).toEqual(['10:00', '16:00'])
    expect(cardPickup(byCarrier.get('demo-express'))?.words.key).toBe('pickup.card.manyWaiting')
    expect(cardPickup([{ ...rows.value.alreadyToday[1]!, status: 'FAILED' }])?.tone).toBe('danger')
    expect(cardPickup([{ ...rows.value.alreadyToday[1]!, status: 'CANCELLED' }])).toBeNull()
    expect(cardPickup([rows.value.alreadyToday[1]!])?.words).toEqual({ key: 'pickup.card.booked', params: { time: '10:00' } })
  })

  it('holds a move with the API\'s own code', () => {
    const rows = caseOf(pickupScreen, 'coming-today').draft
    if (rows.state !== 'ready') throw new Error('not ready')
    expect(moveHeld(rows.value.alreadyToday[1]!, 'CONFIRMED', { bookPickups: true }, false)?.key).toBe('pickup.refusal.NOT_REQUESTED')
    expect(moveHeld(rows.value.alreadyToday[0]!, 'CONFIRMED', { bookPickups: true }, false)).toBeNull()
  })

  it('reads an instant on the site\'s clock', () => {
    expect(wallOf('2026-11-15T15:30:00.000Z', 'Europe/Rome')).toEqual({ day: '2026-11-15', time: '16:30' })
  })
})

describe('the list (SCR-655): the site a pickup is for, what the selection row may do', () => {
  it('takes open carrier shipments; the queue\'s site when one picked is there', () => {
    const picked = [
      { id: 'a', number: 'A', status: 'PACKED', transportBy: 'CARRIER', siteId: 's2' },
      { id: 'b', number: 'B', status: 'SHIPPED', transportBy: 'CARRIER', siteId: 's1' },
      { id: 'c', number: 'C', status: 'DRAFT', transportBy: 'SENDER', siteId: 's1' },
    ]
    expect(pickupable(picked).map((row) => row.id)).toEqual(['a'])
    expect(pickupSite('s1', pickupable(picked))).toBe('s2')
    expect(pickupSite('s1', [])).toBe('s1')
    expect(pickupHeld({ siteId: 's1', can: { bookPickups: true } as never }, picked.slice(1))?.key).toBe('pickup.held.noneCarrier')
  })

  it('Mark handed over sends the packed ones with a DDT, leaves out the rest with why', () => {
    const plan = handOverOf([
      { id: 'a', number: 'A', status: 'PACKED', transportBy: 'SENDER', ddt: { id: 'd' } },
      { id: 'b', number: 'B', status: 'PACKED', transportBy: 'RECIPIENT' },
      { id: 'c', number: 'C', status: 'PACKED', transportBy: 'CARRIER', ddt: null },
      { id: 'd', number: 'D', status: 'DRAFT', transportBy: 'CARRIER' },
      { id: 'e', number: 'E', status: 'PACKED', transportBy: 'CARRIER' },
    ])
    expect(plan.go.map((row) => row.id)).toEqual(['a', 'e'])
    expect(plan.skipped.map((entry) => entry.why.key)).toEqual(['handOver.why.collects', 'handOver.why.noDdt', 'handOver.why.notPacked'])
    expect(handOverRefusal(conflict('INCOMPLETE')).key).toBe('handOver.why.collects')
    expect(handOverRefusal(new ApiError('conflict', 409, 'conflict', 'x')).key).toBe('handOver.why.notReady')
  })
})

describe('End of day (SCR-651, SCR-652)', () => {
  it('the fixtures are answers the API may give', () => {
    expect(() => endOfDaySchema.parse(endOfDay())).not.toThrow()
    const sheet = caseOf(manifestScreen, 'closed').read
    if (sheet.status !== 'ready') throw new Error('not ready')
    expect(() => manifestSchema.parse(sheet.value)).not.toThrow()
  })

  it('closes every carrier with something to close; holds the close with why', () => {
    const day = endOfDay()
    expect(startChosen(day)).toEqual(['demo-express', 'esempio'])
    expect(closeHeld(day, [], { manage: true }, false)?.key).toBe('eod.held.noneChosen')
    expect(closeHeld(day, ['esempio'], { manage: false }, false)?.key).toBe('eod.held.noRight')
    expect(closeHeld(day, ['esempio'], { manage: true }, false)).toBeNull()
    const closed = caseOf(eodScreen, 'all-closed').read
    if (closed.state !== 'ready') throw new Error('not ready')
    expect(closeHeld(closed.value, [], { manage: true }, false)?.key).toBe('eod.held.allClosed')
    expect(closed.value.carriers.map(carrierState)).toEqual(['closed', 'closedBySystem'])
  })

  it('says each outcome: printed, closed but not printed, refused by its code', () => {
    const outcomes = caseOf(eodScreen, 'refused').outcomes!
    expect(outcomeWords(outcomes[0]!).words.key).toBe('eod.refusal.DAY_CHANGED')
    expect(outcomeWords(outcomes[1]!)).toMatchObject({ tone: 'warning', words: { key: 'eod.outcome.notPrinted' } })
  })

  it('offers the site\'s today and the seven days before it', () => {
    expect(closableDays('2026-03-02')).toEqual(['2026-03-02', '2026-03-01', '2026-02-28', '2026-02-27', '2026-02-26', '2026-02-25', '2026-02-24', '2026-02-23'])
  })
})

describe('Export papers (SCR-653, SCR-654)', () => {
  const ready = (id: string) => {
    const read = caseOf(exportScreen, id).read
    if (read.state !== 'ready') throw new Error('not ready')
    return read.value
  }

  it('the fixtures are answers the API may give', () => {
    for (const item of exportScreen.cases) if (item.model.read.state === 'ready') expect(() => exportSchema.parse(item.model.read.state === 'ready' ? item.model.read.value : null)).not.toThrow()
  })

  it('names the state; holds each paper with the API\'s code, the right, the price grain', () => {
    expect(exportState(ready('domestic'))).toBe('notNeeded')
    expect(exportState(ready('no-papers'))).toBe('papers')
    expect(exportState(ready('papers'))).toBe('declare')
    expect(exportState(ready('overdue'))).toBe('overdue')
    const can = { customs: true, price: true }
    expect(invoiceHeld(ready('no-eori'), can, false)?.key).toBe('export.refusal.NO_EORI')
    expect(invoiceHeld(ready('papers'), { ...can, price: false }, false)?.key).toBe('export.held.noPrice')
    expect(invoiceHeld(ready('papers'), can, false)).toBeNull()
    expect(postalChoices(ready('papers'))).toEqual(['CN23'])
    expect(postalChoices(ready('cn22'))).toEqual(['CN22', 'CN23'])
  })

  it('the proof of exit waits for the MRN and the invoice; the clock counts down to the alert', () => {
    const can = { customs: true, uploadFiles: true }
    const sent = ready('pack-sent')
    expect(exitHeld(sent.declaration!, sent, can, false)?.key).toBe('export.refusal.NOT_FILED')
    const filed = ready('filed')
    expect(exitHeld(filed.declaration!, filed, can, false)).toBeNull()
    expect(exitClock(filed.declaration!)?.words).toEqual({ key: 'export.clock.left', params: { days: 27 } })
    expect(exitClock(ready('overdue').declaration!)?.tone).toBe('danger')
    expect(exitClock(ready('exited').declaration!)).toBeNull()
  })

  it('checks a dialog: the MRN pattern, the exit time, the reason in words', () => {
    const read = ready('filed')
    expect(dialogProblem({ kind: 'mrn', mrn: '26IT000000000DEMO1' }, read)).toBeNull()
    expect(dialogProblem({ kind: 'mrn', mrn: '26IT0' }, read)?.key).toBe('export.problem.mrn')
    expect(dialogProblem({ kind: 'exit', at: '2026-11-10T00:00:00.000Z', file: null, fileName: null }, read)?.key).toBe('export.refusal.EXIT_TIME')
    expect(dialogProblem({ kind: 'invoice', language: '', reason: 'OTHER', reasonText: ' ', notes: '' }, read)?.key).toBe('export.problem.reasonText')
    const pack = caseOf(exportScreen, 'pack-dialog').pack
    if (pack?.state !== 'ready') throw new Error('not ready')
    expect(linkHeld(pack.value, { customs: true, price: true }, false)?.key).toBe('export.packRefusal.SWITCH_OFF')
  })

  it('the paper window opens the newest or says it is older', () => {
    const older = caseOf(paperScreen, 'older').read
    expect(older.status === 'ready' && older.value.document.current).toBe(false)
  })
})

describe('Carriers & shipping (SCR-656 … SCR-659)', () => {
  it('test mode: going live is held by the API\'s code; back to test only when live', () => {
    const read = caseOf(testModeScreen, 'not-ready').sites
    if (read.state !== 'ready') throw new Error('not ready')
    expect(liveHeld(read.value[0]!, { settingsManage: true }, false)?.key).toBe('test.refusal.NO_CARRIER_ACCOUNT')
    expect(testHeld(read.value[0]!, { settingsManage: true }, false)?.key).toBe('test.refusal.ALREADY_TEST')
    expect(liveHeld(read.value[0]!, { settingsManage: false }, false)?.key).toBe('test.held.noRight')
  })

  it('EORI: normalised as the API keeps it; Save held when the same or not one', () => {
    const settings = caseOf(eoriScreen, 'set').settings
    if (settings.state !== 'ready') throw new Error('not ready')
    expect(eoriProblem('IT 0000-0000 002')).toBeNull()
    expect(eoriProblem('X!')?.key).toBe('eori.problem')
    expect(saveHeld(settings.value, 'it00000000001', { settingsManage: true }, false)?.key).toBe('eori.held.same')
    expect(saveHeld(settings.value, '', { settingsManage: true }, false)).toBeNull()
  })

  it('contracts: live first; the number and the carrier checked before sending', () => {
    const rows = caseOf(contractsScreen, 'list').contracts
    if (rows.state !== 'ready') throw new Error('not ready')
    expect(contractOrder(rows.value).map((row) => row.active)).toEqual([true, true, false])
    expect(scopeWords(rows.value[1]!)).toEqual({ key: 'contracts.scope.site', params: { site: 'A1' } })
    expect(contractProblem({ kind: 'add', carrierCode: 'brt', everySite: false, accountNumber: 'x', ownRatesOnly: false })?.key).toBe('contracts.problem.number')
    expect(contractProblem({ kind: 'number', contractId: 'c', accountNumber: 'DEMO-4321' })).toBeNull()
  })

  it('packaging: the domain\'s rules by field; the cost only with the cost grain', () => {
    const problems = typeProblems({ ...typeFormOf(null), name: '', length: '60', width: '40', tare: '2', maxWeight: '1' }, false)
    expect(Object.keys(problems).sort()).toEqual(['length', 'maxWeight', 'name'])
    expect(problems.name?.key).toBe('packaging.problem.name')
    expect(problems.maxWeight?.key).toBe('packaging.problem.maxWeight')
    const form = { ...typeFormOf(null, 'PALLET'), name: 'P', cost: '1,5', currency: 'eur' }
    expect(typeBody(form, false)).not.toHaveProperty('cost')
    expect(typeBody(form, true).cost).toEqual({ perUnit: '1.5', currency: 'EUR' })
    expect(typeBody({ ...typeFormOf(null), name: 'C' }, false).palletKind).toBeNull()
    expect(defaultProblem({ packagingTypeId: 't', styleId: '', sizeScaleId: '', fromSize: '', toSize: '' })?.key).toBe('packaging.problem.scope')
    expect(defaultProblem({ packagingTypeId: 't', styleId: 's', sizeScaleId: '', fromSize: '44', toSize: '50' })?.key).toBe('packaging.problem.runScale')
  })
})

// ---- every design case in it and en: no key left on screen -----------------------------------------------------------------

const TOP = [...new Set(Object.keys(CATALOGUE.en[DISPATCH_NS] ?? {}).map((key) => key.split('.')[0]!))]
const LEFT_KEY = new RegExp(`(?:^|[\\s>"(])(?:${TOP.join('|')})\\.[a-zA-Z]+(?:\\.[a-zA-Z_]+)*`)
const NAMESPACES = [DISPATCH_NS, 'warehouse-shipments-depth', 'shipments', 'lists', 'records', 'shell', 'ds-words']

describe('SCR-650 … SCR-659 draw every case in both languages', () => {
  const parts = [pickupScreen, eodScreen, manifestScreen, exportScreen, paperScreen, testModeScreen, packagingScreen, eoriScreen, contractsScreen] as const
  for (const locale of LOCALES) {
    it(`every case in ${locale}: no key left`, () => {
      const draw = (element: ReturnType<typeof createElement>) => renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, NAMESPACES) }, element))
      for (const screen of parts) {
        for (const item of screen.cases) {
          const html = draw(createElement(screen.view as never, { model: item.model }))
          expect(html.match(LEFT_KEY)?.[0] ?? null, `${screen.screen} ${item.id} (${locale})`).toBeNull()
        }
      }
      for (const item of listScreen.cases) {
        const html = draw(createElement(ShipmentsListView, { model: item.model.list }))
        expect(html.length, item.id).toBeGreaterThan(200)
        expect(html.match(LEFT_KEY)?.[0] ?? null, `SCR-655 ${item.id} (${locale})`).toBeNull()
      }
    })
  }
})

// ── B-W2b-F56, B-W2b-GF6 ──────────────────────────────────────────────────────────────────────────────────────────────
// The Owner's test server: the administrator (shipping.settings.view, no shipping.view) got 403 on the packaging reads.
// The Owner's decision (11-15): the packaging reads ask shipping.settings.view, the right the page opens with.
describe('Packaging is read with shipping.settings.view', () => {
  const NO_VIEW = { en: 'Your role does not see the packaging types and defaults.', it: 'Il tuo ruolo non vede i tipi di imballo e i predefiniti.' } as const
  // The lists' toolbars (the grid draws its rows in the browser only).
  const LISTS = { en: 'Add a type', it: 'Aggiungi un tipo' } as const
  const drawn = (can: ReturnType<typeof dispatchAbilitiesOf>, locale: (typeof LOCALES)[number]) =>
    renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, NAMESPACES) }, createElement(packagingScreen.view as never, { model: { ...caseOf(packagingScreen, 'types'), can } })))

  it('draws the types and defaults for the administrator template (the settings right, not shipments), its writes held', () => {
    const admin = dispatchAbilitiesOf(templateOf('admin')!.permissions)
    expect(admin).toMatchObject({ view: false, settingsView: true, packaging: false })
    for (const locale of LOCALES) {
      const html = drawn(admin, locale)
      expect(html).toContain(LISTS[locale])
      expect(html).not.toContain(NO_VIEW[locale])
      expect(html).toContain(locale === 'en' ? 'Your role cannot change packaging.' : 'Il tuo ruolo non può cambiare gli imballi.')
    }
  })

  it('holds a role that sees shipments but not the shipping settings (the planner template), in words, with no list', () => {
    const planner = dispatchAbilitiesOf(templateOf('planner')!.permissions)
    expect(planner).toMatchObject({ view: true, settingsView: false })
    for (const locale of LOCALES) {
      const html = drawn(planner, locale)
      expect(html).toContain(NO_VIEW[locale])
      expect(html).toContain(locale === 'en' ? 'the right to see the shipping settings' : 'il diritto di vedere le impostazioni di spedizione')
      expect(html).not.toContain(LISTS[locale])
    }
  })

  it('says in words that the role does not see packaging, and draws no list', () => {
    const item = packagingScreen.cases.find((entry) => entry.id === 'no-view')!
    for (const locale of LOCALES) {
      const html = renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, NAMESPACES) }, createElement(packagingScreen.view as never, { model: item.model })))
      expect(html).toContain(locale === 'en' ? 'Your role does not see the packaging types and defaults.' : 'Il tuo ruolo non vede i tipi di imballo e i predefiniti.')
      expect(html).not.toContain(locale === 'en' ? 'Add a type' : 'Aggiungi un tipo')
    }
  })
})
// ── end B-W2b-F56, B-W2b-GF6 ──────────────────────────────────────────────────────────────────────────────────────────

import { createElement, useEffect, useState } from 'react'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { brokenRules, emptyDraft, HOME_ADDRESS, linkDraftFor, type ListAddress } from './model'
import { canFor, CHECK_FLAGS, CHECK_INSIDE, CHECK_OFF, COMPANY_ID, CONTACTS, CUSTOMERS, FORM_POINTS, inShell, MANY_ROWS, ME, ME_PERSON, NOW, PEOPLE, PREFIX, ROWS, STYLE, STYLES, TEMPLATES, TEMPLATES_ONE_ON, TILES_DATA, TEMPLATE_ID, type RoleCase } from './demo/fixtures'
import type { LinkDialogModel, MeasurementsDialogModel, MtmListModel, QuoteDialogModel } from './view-model'
import { MtmListView } from './view/MtmListView'

/**
 * SCR-036 Sales › Made-to-measure — made-up data only (Demo riders and customers). Each case is a state the Owner reviews: the
 * list with its tiles and the off state (switched off per template, Owner 11-10), a tile pressed, the filters as chips, the
 * selection, New measurements (empty, filled with a value outside its range asked again, the rules flagged while typing, Esc
 * asking to keep or discard, refused at a field), Send a measurement link from the band (pick, held, the link shown once,
 * mailed, no privacy notice), Use in a new quote (a style inside the range; held while made-to-measure is off), the role cases
 * and every state of a list. In the browser the tiles, filters, selection and dialogs work for real.
 */

interface DesignModel {
  readonly role: RoleCase
  readonly model: MtmListModel
}

const at = (address: Partial<ListAddress>): ListAddress => ({ ...HOME_ADDRESS, ...address })
const list = (over: Partial<MtmListModel> = {}, role: RoleCase = 'owner'): DesignModel => ({
  role,
  model: {
    prefix: PREFIX,
    me: ME,
    companyId: COMPANY_ID,
    can: canFor(role),
    address: HOME_ADDRESS,
    rows: { items: ROWS, more: false, problem: null, matching: ROWS.length },
    tiles: TILES_DATA,
    tilesFailed: false,
    templates: TEMPLATES,
    asOf: NOW,
    live: 'live',
    updates: 0,
    notice: null,
    measurements: null,
    link: null,
    quote: null,
    ...over,
  },
})

const newDialog = (over: Partial<MeasurementsDialogModel> = {}): MeasurementsDialogModel => ({
  mode: 'new',
  customers: { items: CUSTOMERS, problem: null },
  customerQ: '',
  partyId: '',
  contacts: { items: [], problem: null },
  contactId: '',
  riderName: '',
  templates: { items: TEMPLATES, problem: null },
  garmentType: '',
  template: null,
  points: null,
  pointsProblem: null,
  draft: emptyDraft(NOW),
  people: PEOPLE,
  me: ME_PERSON,
  problems: {},
  flags: [],
  checking: false,
  styles: STYLES,
  styleId: '',
  suggested: null,
  busy: false,
  offline: false,
  notice: null,
  leaving: false,
  ...over,
})
const values = { neck: '41', chest: '141', waist: '88', back_length: '47', sleeve: '64', height: '181' }
const filled = newDialog({
  partyId: CUSTOMERS[0]!.id,
  contacts: { items: CONTACTS, problem: null },
  contactId: CONTACTS[0]!.id,
  riderName: CONTACTS[0]!.name,
  garmentType: 'JACKET',
  template: { id: TEMPLATE_ID, code: 'JACKET', name: 'Jacket', rulesOn: false },
  points: FORM_POINTS,
  draft: { ...emptyDraft(NOW), values, noticeRef: 'Privacy notice for riders v3', place: 'Showroom' },
})
const flagged = newDialog({ ...filled, template: { id: TEMPLATE_ID, code: 'JACKET', name: 'Jacket', rulesOn: true }, draft: { ...filled.draft, values: { ...values, chest: '104', waist: '126' } }, flags: brokenRules(CHECK_FLAGS), styleId: STYLES[0]!.id, suggested: { size: '56', how: 'NEAREST' } })

const linkDialog = (over: Partial<LinkDialogModel> = {}): LinkDialogModel => ({ choices: ROWS, profileId: '', riderName: '', garmentType: '', hasContact: false, pointCount: null, draft: linkDraftFor('it'), busy: false, offline: false, notice: null, sent: null, copied: false, ...over })
const picked = linkDialog({ profileId: ROWS[0]!.id, riderName: ROWS[0]!.riderName, garmentType: 'JACKET', hasContact: true, pointCount: 8 })

const quoteDialog = (over: Partial<QuoteDialogModel> = {}): QuoteDialogModel => ({ riderName: ROWS[0]!.riderName, customer: ROWS[0]!.customer.name, revision: 3, styles: { items: STYLES, problem: null }, style: STYLE, draft: { styleId: STYLE.id, colourwayId: STYLE.colourways[0]!.id, baseSize: '' }, check: CHECK_INSIDE, checking: false, busy: false, offline: false, notice: null, ...over })

function MtmDesign({ model: design }: { model: DesignModel }) {
  const [address, setAddress] = useState(design.model.address)
  const [measurements, setMeasurements] = useState(design.model.measurements)
  const [link, setLink] = useState(design.model.link)
  const [quote, setQuote] = useState(design.model.quote)
  useEffect(() => {
    setAddress(design.model.address)
    setMeasurements(design.model.measurements)
    setLink(design.model.link)
    setQuote(design.model.quote)
  }, [design])
  const items = design.model.rows.items && address.view !== design.model.address.view ? ROWS.filter((row) => (address.view === 'waiting' ? row.review.status === 'WAITING' : address.view === 'needMore' ? row.review.status === 'NEED_MORE' : address.view === 'confirmed' ? row.review.status === 'CONFIRMED' : address.view === 'old' ? row.old : true)) : design.model.rows.items
  const model: MtmListModel = { ...design.model, address, rows: { ...design.model.rows, items }, measurements, link, quote }
  return inShell(
    '/sales/made-to-measure',
    createElement(MtmListView, {
      model,
      actions: {
        onAddress: (patch) => setAddress((current) => ({ ...current, ...patch })),
        onClearFilters: () => setAddress(HOME_ADDRESS),
        onNew: () => setMeasurements(newDialog()),
        onLink: () => setLink(linkDialog()),
        onRowVerb: (_row, verb) => (verb === 'quote' ? setQuote(quoteDialog()) : undefined),
        measurements: {
          onCustomer: (partyId) => setMeasurements((now) => (now ? { ...now, partyId, contacts: { items: CONTACTS, problem: null }, contactId: CONTACTS[0]!.id } : now)),
          onRider: (patch) => setMeasurements((now) => (now ? { ...now, ...patch } : now)),
          onGarment: (code) => setMeasurements((now) => (now ? { ...now, garmentType: code, template: { id: TEMPLATE_ID, code, name: code, rulesOn: false }, points: FORM_POINTS } : now)),
          onDraft: (patch) => setMeasurements((now) => (now ? { ...now, draft: { ...now.draft, ...patch } } : now)),
          onValue: (code, value) => setMeasurements((now) => (now ? { ...now, draft: { ...now.draft, values: { ...now.draft.values, [code]: value } } } : now)),
          onConfirm: (code, checked) => setMeasurements((now) => (now ? { ...now, draft: { ...now.draft, confirmed: checked ? [...now.draft.confirmed, code] : now.draft.confirmed.filter((entry) => entry !== code) } } : now)),
          onClose: () => setMeasurements((now) => (now && Object.values(now.draft.values).some((value) => value) && !now.leaving ? { ...now, leaving: true } : null)),
          onKeep: () => setMeasurements((now) => (now ? { ...now, leaving: false } : now)),
          onDiscard: () => setMeasurements(null),
          onSave: () => setMeasurements(null),
        },
        link: {
          onPick: (profileId) => setLink((now) => (now ? { ...now, profileId, riderName: ROWS.find((row) => row.id === profileId)?.riderName ?? '', garmentType: 'JACKET', hasContact: true, pointCount: 8 } : now)),
          onDraft: (patch) => setLink((now) => (now ? { ...now, draft: { ...now.draft, ...patch } } : now)),
          onSend: () => setLink((now) => (now ? { ...now, sent: { link: { id: 'demo', profileId: now.profileId, expiresAt: '2026-11-27T09:42:00.000Z', email: 'rider.due@example.com', photos: now.draft.photos }, url: null, delivery: 'SENT' } } : now)),
          onClose: () => setLink(null),
        },
        quote: { onDraft: (patch) => setQuote((now) => (now ? { ...now, draft: { ...now.draft, ...patch } } : now)), onCreate: () => setQuote(null), onClose: () => setQuote(null) },
      },
    }),
    design.role,
  )
}

export const designScreen = defineDesignScreen<DesignModel>({
  screen: 'SCR-036',
  title: 'Made-to-measure',
  view: MtmDesign,
  cases: [
    { id: 'list', label: 'Owner: rider profiles, the tiles, made-to-measure off for every template (said with the way to start it)', model: list(), note: 'A tile is a saved row; "Outside the certified range" is per style ("—") and "Fittings this week" names a count only. Keys in the footer icon.' },
    { id: 'started-one', label: 'Made-to-measure started for JACKET only (the others stay off)', model: list({ templates: TEMPLATES_ONE_ON }) },
    { id: 'tile-waiting', label: 'Tile pressed: Waiting for factory review', model: list({ address: at({ view: 'waiting' }), rows: { items: ROWS.filter((row) => row.review.status === 'WAITING'), more: false, problem: null, matching: 2 } }) },
    { id: 'tile-need-more', label: 'Tile pressed: Need more from the rider', model: list({ address: at({ view: 'needMore' }), rows: { items: ROWS.filter((row) => row.review.status === 'NEED_MORE'), more: false, problem: null, matching: 1 } }) },
    { id: 'tile-old', label: 'Tile pressed: Older than 12 months (re-measure)', model: list({ address: at({ view: 'old' }), rows: { items: ROWS.filter((row) => row.old), more: false, problem: null, matching: 1 } }) },
    { id: 'filtered', label: 'Filters as chips: confirmed, garment type JACKET, a search', model: list({ address: at({ view: 'confirmed', garment: 'JACKET', q: 'Uno' }), rows: { items: ROWS.filter((row) => row.review.status === 'CONFIRMED' && row.garmentType === 'JACKET'), more: false, problem: null, matching: 2 } }) },
    { id: 'many', label: 'Many riders: Show more (48 of 120)', model: list({ rows: { items: MANY_ROWS, more: true, problem: null, matching: 120 } }) },
    { id: 'selection', label: 'Selection: Copy 2 riders', model: list({ selected: [ROWS[0]!.id, ROWS[1]!.id] }) },
    { id: 'live-updates', label: 'Live: a measurement link answered (a new revision waits for review) and 2 updates behind Show', model: list({ updates: 2, notice: { key: 'live.linkAnswered', tone: 'info' } }) },
    { id: 'keyboard', label: 'Keyboard: j / k on the rows, x selects, c opens New measurements; the keys in the footer icon', model: list({ focusRow: 1, keysOpen: true }) },
    { id: 'new', label: 'New measurements: customer, rider, garment type first (Save held with why)', model: list({ measurements: newDialog() }) },
    { id: 'new-filled', label: 'New measurements filled: chest 141 cm outside 70–130 cm asked again ("I checked it")', model: list({ measurements: filled }) },
    { id: 'new-flags', label: 'New measurements with the rules on: two rules broken while typing, the base size suggested against a style', model: list({ measurements: flagged }) },
    { id: 'new-leaving', label: 'Esc with measures typed: keep or discard', model: list({ measurements: { ...filled, leaving: true } }) },
    { id: 'new-refused', label: 'Save refused at its fields (said in our words)', model: list({ measurements: { ...filled, draft: { ...filled.draft, confirmed: ['chest'] }, problems: { takenAt: { key: 'form.problem.takenAtFuture' } }, notice: { key: 'form.problem.fix', params: { count: 1 }, tone: 'danger' } } }) },
    { id: 'new-offline', label: 'New measurements offline: what is typed stays, Save held', model: list({ measurements: { ...filled, offline: true }, live: 'offline' }) },
    { id: 'link', label: 'Send a measurement link from the band: pick the rider', model: list({ link: linkDialog() }) },
    { id: 'link-picked', label: 'Send a measurement link: rider picked, what the rider will see', model: list({ link: picked }) },
    { id: 'link-once', label: 'The link made without a mail: shown once to copy', model: list({ link: { ...picked, sent: { link: { id: 'demo', profileId: ROWS[0]!.id, expiresAt: '2026-11-27T09:42:00.000Z', email: null, photos: 'OPTIONAL' }, url: 'https://factory.example.com/l#token=demo-made-up-token', delivery: null } } }) },
    { id: 'link-mailed', label: 'The link mailed (FAKE locally)', model: list({ link: { ...picked, sent: { link: { id: 'demo', profileId: ROWS[0]!.id, expiresAt: '2026-11-27T09:42:00.000Z', email: 'rider.due@example.com', photos: 'REQUIRED' }, url: null, delivery: 'SENT' } } }) },
    { id: 'link-no-notice', label: 'Refused: the company has no public privacy notice in force', model: list({ link: { ...picked, notice: { key: 'link.problem.noNotice', tone: 'danger' } } }) },
    { id: 'quote', label: 'Use in a new quote: inside the certified range, base size 52 suggested', model: list({ quote: quoteDialog() }) },
    { id: 'quote-off', label: 'Use in a new quote: Create held — made-to-measure has not started for JACKET', model: list({ quote: quoteDialog({ check: CHECK_OFF }) }) },
    { id: 'quote-refused', label: 'The quote was made but the unit refused (link to the draft quote)', model: list({ quote: quoteDialog({ notice: { key: 'quote.problem.unitRefused', params: { number: 'QT-DEMO-0012' }, tone: 'danger', lines: [{ key: 'quote.problem.notStarted' }], link: { href: `${PREFIX}/sales/quotes/demo`, label: { key: 'quote.openQuote', params: { number: 'QT-DEMO-0012' } } } } }) }) },
    { id: 'sales', label: 'Sales: records, links, fittings, quotes', model: list({}, 'sales') },
    { id: 'production', label: 'Production manager: reviews; New measurements held with why', model: list({}, 'production') },
    { id: 'no-permission', label: 'Read only: no access to rider profiles (body data)', model: list({}, 'reader') },
    { id: 'warehouse', label: 'Warehouse: no permission', model: list({}, 'warehouse') },
    { id: 'offline', label: 'Offline: the last copy with its time; New measurements held', model: list({ live: 'offline' }) },
    { id: 'loading', label: 'Loading (tiles say —)', model: list({ rows: { items: null, more: false, problem: null, matching: null }, tiles: null, asOf: null, templates: null, live: 'connecting' }) },
    { id: 'error', label: "The API didn't answer (never an empty list; tiles say — and Couldn't count)", model: list({ rows: { items: null, more: false, problem: 'problem.unavailable', matching: null }, tiles: null, tilesFailed: true, asOf: null, live: 'offline' }) },
    { id: 'empty', label: 'First day: no rider profile yet', model: list({ rows: { items: [], more: false, problem: null, matching: 0 }, tiles: { waitingReview: 0, needMore: 0, older: 0, fittingsThisWeek: 0, outsideRange: null } }) },
    { id: 'filtered-empty', label: 'A filter with nothing in it (Clear filters)', model: list({ address: at({ view: 'needMore', garment: 'TROUSERS' }), rows: { items: [], more: false, problem: null, matching: 0 } }) },
  ],
})

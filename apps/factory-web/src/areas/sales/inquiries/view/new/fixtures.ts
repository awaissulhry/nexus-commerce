import { createElement, useEffect, useState } from 'react'
import { defineDesignScreen } from '../../../../../lib/design/design-screen'
import { EMPTY_COMPOSE } from '../../../../../lib/request-compose/model'
import { DEMO_COMPANIES } from '../../../../../shell/design-data'
import { canFor, COMPANY_ID, CONTACTS, CUSTOMERS, DEMO_PICTURES, inShell, listOf, MAIL_DRAFT, MAIL_TAKEN, ME, NOW, PANTS_DETAIL, PREFIX, STYLE_OPTIONS, type RoleCase } from '../../demo/fixtures'
import { HOME_ADDRESS, emptyLine } from '../../model'
import { emptyNewRequest, newRequestFromMail, withWho, type NewRequestDraft } from '../../new-request'
import { InquiriesView, type InquiriesModel } from '../InquiriesView'
import type { NewRequestModel } from '../NewRequestDialog'

/**
 * SCR-105-new — New request in the office (B-TH-221; threads plan TH-1c, O-SAL-INQ-LIST.band-F02; picture 12 was never drawn:
 * built to the approved compose of pictures 18–19 (the portal's New order, B-TH-220) and the thread pictures 2–5, the design kit
 * and the tree). Made-up data only. The window over Incoming: From (how it came; a customer of the reader's OR a prospect with
 * the lawful basis), the portal's compose (subject, message, files, "Add details": their PO, the day wanted, a delivery
 * address, and for the office the target price and the lines), "Give it to me", Create request; a full-screen sheet on a
 * phone. The cases: a customer's call, just opened, a prospect, a prospect who already is a customer, the lawful basis
 * missing, a person limited to one customer, no customer, the customers not read, a refused address, no request numbering,
 * offline, "Discard this request?", from a mail, a mail already made into one, a reader, the production manager.
 */

interface NewCase {
  readonly role: RoleCase
  readonly dialog: NewRequestModel
  readonly page?: Partial<InquiriesModel>
}

const SHIP_TO = [
  { id: '0190f0e2-5401-7000-8000-000000000001', label: 'Demo Moto Brand workshop, Via Esempio 12, 20121 Milano', waiting: false, isDefault: true },
  { id: '0190f0e2-5401-7000-8000-000000000002', label: 'Demo Moto Brand store, Via Prova 3, 40121 Bologna', waiting: true, isDefault: false },
]
const TODAY = NOW.slice(0, 10)

const base = (draft: NewRequestDraft, over: Partial<NewRequestModel> = {}): NewRequestModel => ({
  draft,
  mail: null,
  customers: { state: 'ready', items: CUSTOMERS, total: CUSTOMERS.length, limited: false },
  contacts: draft.who === 'customer' && draft.partyId ? { items: CONTACTS, problem: null } : null,
  shipTo: draft.who === 'customer' && draft.partyId ? { state: 'ready', choices: SHIP_TO } : { state: 'none', choices: [] },
  styles: { items: STYLE_OPTIONS, problem: null },
  details: { [PANTS_DETAIL.id]: { status: 'ready', value: PANTS_DETAIL } },
  files: [],
  detailsOpen: false,
  shown: {},
  tried: false,
  refused: {},
  busy: false,
  notice: null,
  offline: false,
  unnumbered: false,
  today: TODAY,
  leaving: false,
  ...over,
})

const CALL: NewRequestDraft = {
  ...withWho(emptyNewRequest(), 'customer', CUSTOMERS[0]!.id),
  contactId: CONTACTS[0]!.id,
  compose: { ...EMPTY_COMPOSE, subject: 'Rain trousers for the spring', message: 'Bea called: 60 rain trousers in navy for their spring range, S to XL.\nThey would like them before the shows in February and asked about 38 EUR a piece.', customerRef: 'DMB-PO-4521', wantedDate: '2027-02-15', shipToAddressId: SHIP_TO[0]!.id },
  lines: [{ ...emptyLine('demo-1'), styleId: STYLE_OPTIONS[1]!.id, styleLabel: `${STYLE_OPTIONS[1]!.code} · ${STYLE_OPTIONS[1]!.name}`, sizes: { S: 10, M: 20, L: 20, XL: 10 } }],
  targetPrice: '38',
  assignToMe: true,
}
const PROSPECT: NewRequestDraft = {
  ...withWho(emptyNewRequest(), 'prospect'),
  source: 'FAIR',
  prospect: { name: 'Gianni Esempio', company: 'Demo Moto Club', email: 'president@motoclub-demo.example.com', phone: '+39 000 1234567' },
  compose: { ...EMPTY_COMPOSE, message: 'Met at the fair: club jackets with an embroidered logo on the back, about 40, for the season opening in April.' },
  lines: [{ ...emptyLine('demo-2'), description: 'Club jacket with a logo on the back', quantity: '40' }],
}
const MATCH: NewRequestDraft = { ...PROSPECT, prospect: { name: 'Carla Demo', company: 'Demo Rider Shop', email: '', phone: '' } }
const FILES = [
  { key: 'f1', name: 'rain-trousers-photo.jpg', size: 412_000, problem: null },
  { key: 'f2', name: 'size-notes.pdf', size: 88_000, problem: null },
]

function NewDesign({ model }: { model: NewCase }) {
  const [dialog, setDialog] = useState<NewRequestModel | null>(model.dialog)
  useEffect(() => setDialog(model.dialog), [model])
  const patch = (next: (now: NewRequestModel) => Partial<NewRequestModel>) => setDialog((now) => (now ? { ...now, ...next(now) } : now))
  const page: InquiriesModel = {
    prefix: PREFIX,
    me: ME,
    companyId: COMPANY_ID,
    can: canFor(model.role),
    address: { ...HOME_ADDRESS, isNew: !model.dialog.mail, mail: model.dialog.mail?.id ?? null },
    list: listOf(),
    problem: null,
    customers: CUSTOMERS,
    asOf: NOW,
    live: model.dialog.offline ? 'offline' : 'live',
    updates: 0,
    notice: null,
    dismissed: [],
    limit: 200,
    newRequest: dialog,
    bulk: null,
    detail: null,
    companies: DEMO_COMPANIES.slice(0, 1).map((entry) => ({ id: entry.id, name: entry.name })),
    noticeFacts: {},
    demoPictures: DEMO_PICTURES,
    ...model.page,
  }
  const view = createElement(InquiriesView, {
    model: page,
    actions: {
      onNew: () => setDialog(base(emptyNewRequest())),
      newRequest: {
        onDraft: (next) => patch((now) => ({ draft: { ...now.draft, ...next }, leaving: false })),
        onCompose: (field, value) => patch((now) => ({ draft: { ...now.draft, compose: { ...now.draft.compose, [field]: value } } })),
        onLeaveField: (field) => patch((now) => ({ shown: { ...now.shown, [field]: true } })),
        onDetails: (detailsOpen) => patch(() => ({ detailsOpen })),
        onWho: (who) => patch((now) => {
          const draft = withWho(now.draft, who, who === 'customer' ? now.draft.partyId : null)
          return { draft, contacts: draft.partyId ? { items: CONTACTS, problem: null } : null, shipTo: draft.partyId ? { state: 'ready', choices: SHIP_TO } : { state: 'none', choices: [] } }
        }),
        onCustomer: (partyId) => patch((now) => ({ draft: withWho(now.draft, 'customer', partyId), contacts: partyId ? { items: CONTACTS, problem: null } : null, shipTo: partyId ? { state: 'ready', choices: SHIP_TO } : { state: 'none', choices: [] } })),
        onSubmit: () => setDialog(null),
        onClose: () => patch((now) => ({ leaving: !now.leaving })),
        onDiscard: () => setDialog(null),
        onKeepWriting: () => patch(() => ({ leaving: false })),
      },
    },
  })
  return inShell('/sales/incoming', view, model.role)
}

const at = (role: RoleCase, dialog: NewRequestModel, page?: Partial<InquiriesModel>): NewCase => ({ role, dialog, ...(page ? { page } : {}) })

export const designScreen = defineDesignScreen<NewCase>({
  screen: 'SCR-105-new',
  title: 'Incoming · New request',
  view: NewDesign,
  holdsPage: true,
  cases: [
    { id: 'call', label: 'A customer’s call: the customer and contact, subject and message, their PO, the day wanted and a delivery address, a line by size, a target price, two files, give it to me', model: at('owner', base(CALL, { files: FILES, detailsOpen: true })), note: 'c opens it from Incoming; ⌘↵ creates; Esc asks before it drops what was typed. The request lands in Incoming with the words as written as its first card.' },
    { id: 'empty', label: 'Just opened: held “Pick the customer, or record a prospect”', model: at('owner', base(emptyNewRequest())) },
    { id: 'prospect', label: 'A prospect met at a fair: company, name, e-mail, phone; the lawful basis (steps at their request) with why; a line in words', model: at('owner', base(PROSPECT, { detailsOpen: true })) },
    { id: 'prospect-match', label: 'A typed prospect is already one of your customers: “Use Demo Rider Shop” (no duplicate)', model: at('owner', base(MATCH)) },
    { id: 'prospect-basis', label: 'The lawful basis cleared and Create tried: held, the field says why', model: at('owner', base({ ...PROSPECT, lawfulBasis: null }, { tried: true })) },
    { id: 'limited', label: 'A person limited to one customer: the picker lists only that customer (“You make requests for 1 customer”)', model: at('sales', base(emptyNewRequest(), { customers: { state: 'ready', items: [CUSTOMERS[0]!], total: 1, limited: true } })) },
    { id: 'no-customers', label: 'No customer of this person at this company: record a prospect', model: at('sales', base(emptyNewRequest(), { customers: { state: 'ready', items: [], total: 0, limited: true } })) },
    { id: 'customers-failed', label: 'The customers could not be read (Try again)', model: at('owner', base(emptyNewRequest(), { customers: { state: 'error', items: [], total: 0, limited: false } })) },
    { id: 'refused', label: 'Refused by the factory: the delivery address is not this customer’s — the box says it, the text is kept', model: at('owner', base(CALL, { detailsOpen: true, refused: { shipToAddressId: 'problem.shipTo' }, notice: { key: 'problem.invalid', tone: 'danger' } })) },
    { id: 'unnumbered', label: 'This company numbers no request yet: Create waits (Admin › Numbering)', model: at('owner', base(CALL, { unnumbered: true })) },
    { id: 'offline', label: 'Offline: the text stays in the window, Create waits', model: at('owner', base(CALL, { offline: true })) },
    { id: 'leaving', label: 'Closing with typed text: “Discard this request?” (Keep writing first)', model: at('owner', base(CALL, { leaving: true })) },
    { id: 'from-mail', label: 'Make incoming request from a mail: the sender is a contact of the customer, the attachment as the tech pack', model: at('owner', base({ ...newRequestFromMail(MAIL_DRAFT), techPackFileIds: [MAIL_DRAFT.attachments[0]!.id] }, { mail: { id: MAIL_DRAFT.mail.id, draft: { status: 'ready', value: MAIL_DRAFT } } })) },
    { id: 'mail-taken', label: 'A mail already made into a request (Open it)', model: at('owner', base(newRequestFromMail(MAIL_TAKEN), { mail: { id: MAIL_TAKEN.mail.id, draft: { status: 'ready', value: MAIL_TAKEN } } })) },
    { id: 'reader', label: 'A reader: held “Needs the sales permission”', model: at('reader', base(emptyNewRequest(), { customers: { state: 'none', items: [], total: 0, limited: false } })) },
    { id: 'production', label: 'The production manager: reads Incoming, makes no request (held with the reason)', model: at('production', base(emptyNewRequest(), { customers: { state: 'none', items: [], total: 0, limited: false } })) },
  ],
})

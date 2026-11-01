import { createElement } from 'react'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { at, COMPANIES, inShell, NOW, panels, PREFIX } from '../shared/fixtures'
import { failed, loaded, loading } from '../shared/model'
import type { InboundDelivery, IntegrationAccount, IntegrationCall, SendingIdentity } from './api'
import type { MailDomainModel } from './mail/model'
import type { BlockedAddress, DeliveryCounts, DeliveryMail } from './delivery/api'
import type { DeliveryModel } from './delivery/model'
import type { ConnectionRecordModel, ConnectionsViewModel, Ledger } from './model'
import { ConnectionRecordView } from './record/view/ConnectionRecordView'
import { ConnectionsView } from './view/ConnectionsView'

/**
 * SCR-087 Connections & API and the Connection record, with made-up data the mail domain's fixtures (SCR-015) and the
 * tests share too: "Demo" companies, example.com domains, invented codes, labels and errors (never a real account).
 */

const uid = (n: number) => `0190f0e2-7a7a-7000-8000-${String(n).padStart(12, '0')}`
export const DEMO_NOW = NOW
const DEMO = COMPANIES[0]!
const ESEMPIO = COMPANIES[1]!

const NO_SECRET = { saved: false, savedAt: null, rotatedAt: null }
const LIMITS = { ratePerMinute: 60, burst: 10, timeoutMs: 10000, circuitFailureThreshold: 5, circuitCooldownSeconds: 60 }

function account(n: number, extra: Partial<IntegrationAccount> & Pick<IntegrationAccount, 'provider' | 'code' | 'label' | 'mode'>): IntegrationAccount {
  return {
    id: uid(n),
    companyId: null,
    status: 'ACTIVE',
    credentials: NO_SECRET,
    webhookSecret: NO_SECRET,
    settings: {},
    limits: LIMITS,
    lastOkAt: null,
    lastErrorAt: null,
    lastError: null,
    calls24h: { total: 0, failed: 0 },
    inboundWaiting: 0,
    inboundPath: null,
    version: 1,
    createdAt: at(2, 9),
    updatedAt: at(27, 16),
    ...extra,
  }
}

export const ACCOUNTS: IntegrationAccount[] = [
  account(1, {
    provider: 'SES',
    code: 'mail',
    label: 'Mail (fake)',
    mode: 'FAKE',
    settings: { region: 'eu-south-1' },
    lastOkAt: at(29, 9, 41),
    calls24h: { total: 37, failed: 0 },
    inboundPath: '/inbound/ses/0190f0e2-0000-7000-8000-000000000001/0190f0e2-7a7a-7000-8000-000000000001',
  }),
  account(2, {
    provider: 'R2',
    code: 'files',
    label: 'Files',
    mode: 'LIVE',
    settings: { region: 'eu' },
    credentials: { saved: true, savedAt: at(2, 9), rotatedAt: at(20, 8) },
    lastOkAt: at(29, 9, 30),
    calls24h: { total: 112, failed: 0 },
  }),
  account(3, {
    provider: 'SDI',
    code: 'sdi-demo',
    label: 'SDI Officina Demo (fake)',
    mode: 'FAKE',
    companyId: DEMO.id,
    lastOkAt: at(29, 8, 55),
    calls24h: { total: 12, failed: 1 },
    inboundWaiting: 2,
    inboundPath: '/inbound/sdi/0190f0e2-0000-7000-8000-000000000001/0190f0e2-7a7a-7000-8000-000000000003',
    webhookSecret: { saved: true, savedAt: at(3, 10), rotatedAt: null },
    version: 3,
  }),
  account(4, {
    provider: 'SENDCLOUD',
    code: 'sendcloud-demo',
    label: 'Carrier Officina Demo (test)',
    mode: 'SANDBOX',
    companyId: DEMO.id,
    lastOkAt: at(28, 17, 2),
    lastErrorAt: at(29, 9, 12),
    lastError: 'HTTP 503 from the test system: service temporarily unavailable',
    calls24h: { total: 9, failed: 4 },
    credentials: { saved: true, savedAt: at(28, 10), rotatedAt: null },
    webhookSecret: { saved: true, savedAt: at(28, 10), rotatedAt: null },
    inboundPath: '/inbound/sendcloud/0190f0e2-0000-7000-8000-000000000001/0190f0e2-7a7a-7000-8000-000000000004',
    version: 2,
  }),
  account(5, { provider: 'VIES', code: 'vies', label: 'VAT check (fake)', mode: 'FAKE', status: 'PAUSED', lastOkAt: at(27, 11, 4), version: 4 }),
]

/** B-W2b-24: a virus-scan account in test mode (made-up; none exists before the Owner's spend yes): read like any other. */
export const SCANNER: IntegrationAccount = account(6, { provider: 'CLAMAV', code: 'virus-scan', label: 'Virus scan (fake)', mode: 'FAKE', lastOkAt: at(27, 15, 2), calls24h: { total: 14, failed: 0 } })

export const LIVE_ONLY: IntegrationAccount[] = [ACCOUNTS[1]!, { ...ACCOUNTS[2]!, mode: 'LIVE', label: 'SDI Officina Demo', credentials: { saved: true, savedAt: at(5, 9), rotatedAt: null } }]

const call = (n: number, minute: number, extra: Partial<IntegrationCall>): IntegrationCall => ({
  id: uid(100 + n),
  startedAt: at(29, 9, minute),
  durationMs: 140 + n * 7,
  operation: 'shipping.buy_label',
  status: 'SUCCEEDED',
  reason: null,
  httpStatus: 200,
  attempts: 1,
  error: null,
  requestId: `req-demo-${n}`,
  ...extra,
})

export const CALLS: IntegrationCall[] = [
  call(1, 12, { status: 'FAILED', reason: 'provider_error', httpStatus: 503, attempts: 3, error: 'HTTP 503 from the test system: service temporarily unavailable', durationMs: 2210 }),
  call(2, 11, { status: 'REFUSED', reason: 'circuit_open', httpStatus: null, durationMs: 0 }),
  call(3, 10, { status: 'TIMED_OUT', reason: 'timeout', httpStatus: null, attempts: 2, durationMs: 10000 }),
  call(4, 5, { operation: 'shipping.tracking', httpStatus: 200 }),
  call(5, 2, { operation: 'shipping.tracking' }),
  call(6, 1, { status: 'FAILED', reason: 'provider_error', httpStatus: 422, error: 'Parcel weight is missing' }),
]

export const INBOUND: InboundDelivery[] = [
  { id: uid(201), receivedAt: at(29, 9, 20), eventType: 'parcel_status_changed', verified: true, status: 'RECEIVED', attempts: 0, processedAt: null, error: null, bodyBytes: 812 },
  { id: uid(202), receivedAt: at(29, 8, 50), eventType: 'parcel_status_changed', verified: true, status: 'PROCESSED', attempts: 1, processedAt: at(29, 8, 50), error: null, bodyBytes: 790 },
  { id: uid(203), receivedAt: at(29, 8, 10), eventType: 'parcel_status_changed', verified: true, status: 'FAILED', attempts: 3, processedAt: null, error: 'No parcel with this tracking number', bodyBytes: 801 },
  { id: uid(204), receivedAt: at(28, 23, 0), eventType: null, verified: false, status: 'REJECTED', attempts: 0, processedAt: null, error: 'Signature did not match', bodyBytes: 120 },
]

const identity = (n: number, extra: Partial<SendingIdentity> & Pick<SendingIdentity, 'domain' | 'companyId'>): SendingIdentity => ({
  id: uid(300 + n),
  kind: 'CONVERSATION',
  fromAddress: `noreply@${extra.domain}`,
  displayName: 'Officina Demo',
  displayNamePolicy: 'PERSON_VIA_COMPANY',
  replyDomain: `reply.${extra.domain}`,
  accountId: ACCOUNTS[0]!.id,
  sesIdentityArn: null,
  verificationStatus: 'SUCCESS',
  dkimStatus: 'SUCCESS',
  dkimRecords: ['abcd1234demo', 'efgh5678demo', 'ijkl9012demo'].map((token) => ({ type: 'CNAME' as const, name: `${token}._domainkey.${extra.domain}`, value: `${token}.dkim.amazonses.com` })),
  ready: true,
  lastCheckedAt: at(29, 9, 15),
  isDefault: true,
  status: 'ACTIVE',
  version: 2,
  createdAt: at(3, 10),
  ...extra,
})

export const IDENTITY_READY = identity(1, { domain: 'mail.officina-demo.example.com', companyId: DEMO.id })
export const IDENTITY_WAITING = identity(2, {
  domain: 'notify.officina-demo.example.com',
  companyId: DEMO.id,
  kind: 'NOTIFICATION',
  displayNamePolicy: 'COMPANY',
  verificationStatus: 'PENDING',
  dkimStatus: 'PENDING',
  ready: false,
  isDefault: true,
  lastCheckedAt: at(29, 9, 40),
})
export const IDENTITY_FAILED = identity(3, {
  domain: 'esempio.example.com',
  companyId: ESEMPIO.id,
  displayName: 'Laboratorio Esempio',
  verificationStatus: 'FAILED',
  dkimStatus: 'FAILED',
  ready: false,
  lastCheckedAt: at(28, 18),
})
export const IDENTITIES: SendingIdentity[] = [IDENTITY_READY, IDENTITY_WAITING, IDENTITY_FAILED]

export const MAIL_COMPANIES = COMPANIES.map((company) => ({ id: company.id, name: company.legalName }))
export const CHOICES = COMPANIES.map((company) => ({ id: company.id, code: company.code, name: company.legalName }))

// ---- the delivery log and blocked addresses (B-W2a-41) ----

const mail = (n: number, extra: Partial<DeliveryMail> & Pick<DeliveryMail, 'state' | 'status' | 'at'>): DeliveryMail => ({
  id: uid(400 + n),
  companyId: DEMO.id,
  kind: 'RECORD',
  templateKey: 'thread.message',
  record: null,
  to: [],
  recipients: 1,
  fullAddresses: true,
  queuedAt: extra.at,
  attempts: 1,
  problem: null,
  link: null,
  notifications: null,
  ...extra,
})

/** Made-up mail of the Demo companies: a quote, an order, invoices (one bounced), a document link, a digest, a sign-in. */
export const MAILS: DeliveryMail[] = [
  mail(1, { state: 'DELIVERED', status: 'DELIVERED', at: at(29, 9, 31), record: { type: 'Quote', id: uid(501), label: 'Q-2026-0042' }, to: ['acquisti@moto-esempio.example'], link: 'QUOTE_ACCEPT' }),
  mail(2, { state: 'PROBLEM', status: 'BOUNCED', at: at(29, 9, 12), record: { type: 'Invoice', id: uid(502), label: 'FT-2026-0041' }, to: ['amministrazione@vecchio-cliente.example'], problem: 'Permanent/General: mailbox unavailable' }),
  mail(3, { state: 'SENT', status: 'SENT', at: at(29, 8, 55), record: { type: 'PurchaseOrder', id: uid(503), label: 'PO-2026-00012' }, to: ['ordini@conceria-esempio.example', 'qualita@conceria-esempio.example'], recipients: 3, link: 'PO_CONFIRM' }),
  mail(4, { state: 'DELIVERED', status: 'DELIVERED', at: at(29, 8, 20), record: { type: 'Shipment', id: uid(504), label: 'SH-2026-0007' }, to: ['magazzino@moto-esempio.example'], link: 'DOCUMENT_VIEW' }),
  mail(5, { state: 'PROBLEM', status: 'COMPLAINED', at: at(28, 17, 40), record: { type: 'SalesOrder', id: uid(505), label: 'SO-2026-0031' }, to: ['info@negozio-esempio.example'], problem: 'abuse' }),
  mail(6, { state: 'FAILED', status: 'FAILED', at: at(28, 16, 5), record: { type: 'Invoice', id: uid(506), label: 'FT-2026-0039' }, to: ['amministrazione@vecchio-cliente.example'], attempts: 0, problem: 'suppressed: 1 recipient(s) bounced or complained before' }),
  mail(7, { state: 'DELIVERED', status: 'DELIVERED', at: at(28, 7, 0), kind: 'DIGEST', templateKey: 'notifications.digest', record: { type: 'User', id: uid(507), label: null }, to: ['lucia@officina-demo.example'], notifications: 6 }),
  mail(8, { state: 'WAITING', status: 'QUEUED', at: at(29, 9, 41), kind: 'SIGN_IN', templateKey: 'auth.invitation', record: { type: 'User', id: uid(508), label: null }, to: ['nuovo.collega@officina-demo.example'], attempts: 0 }),
]

const MASK = (address: string) => `${address[0]}•••${address.slice(address.indexOf('@'))}`
export const MAILS_MASKED: DeliveryMail[] = MAILS.map((item) => ({ ...item, fullAddresses: false, to: item.to.map(MASK) }))

export const DELIVERY_COUNTS: DeliveryCounts = { WAITING: 1, SENT: 12, DELIVERED: 214, PROBLEM: 2, FAILED: 1 }

const blockedRow = (n: number, extra: Partial<BlockedAddress> & Pick<BlockedAddress, 'address' | 'reason' | 'at'>): BlockedAddress => ({
  id: uid(600 + n),
  fullAddress: true,
  detail: null,
  mail: null,
  unblocked: null,
  version: 1,
  ...extra,
})

export const BLOCKED: BlockedAddress[] = [
  blockedRow(1, { address: 'amministrazione@vecchio-cliente.example', reason: 'BOUNCE', detail: 'Permanent/General', at: at(29, 9, 12), mail: { id: MAILS[1]!.id, companyId: DEMO.id, record: { type: 'Invoice', id: uid(502), label: 'FT-2026-0041' } } }),
  blockedRow(2, { address: 'info@negozio-esempio.example', reason: 'COMPLAINT', detail: 'abuse', at: at(28, 17, 40), mail: { id: MAILS[4]!.id, companyId: DEMO.id, record: { type: 'SalesOrder', id: uid(505), label: 'SO-2026-0031' } } }),
  blockedRow(3, { address: 'vecchia.casella@esempio.example', reason: 'MANUAL', detail: 'The customer asked for no more mail at this address', at: at(20, 11, 0) }),
]
export const UNBLOCKED: BlockedAddress[] = [
  blockedRow(4, { address: 'ufficio@riparato-esempio.example', reason: 'BOUNCE', detail: 'Permanent/General', at: at(14, 10, 0), version: 2, unblocked: { at: at(21, 15, 30), byId: uid(700), reason: 'The customer fixed their mailbox' } }),
]

const ledger0 = <T,>(items: readonly T[] | null, more: string | null = null, problem: string | null = null) => ({ items, problem, more })
export const deliveryModel = (over: Partial<DeliveryModel> = {}): DeliveryModel => ({
  mails: ledger0(MAILS, MAILS[MAILS.length - 1]!.id),
  counts: DELIVERY_COUNTS,
  blockedCount: BLOCKED.length,
  filter: null,
  blocked: ledger0(BLOCKED),
  blockedView: 'BLOCKED',
  canUnblock: true,
  ...over,
})

// ---- SCR-087 ----

type Case = { page: 'list'; model: ConnectionsViewModel } | { page: 'record'; model: ConnectionRecordModel; dock?: boolean }

/** Two running services, a paused one and a "Not connected" row (the second company has no SDI). */
const PICKED = [ACCOUNTS[0]!.id, ACCOUNTS[3]!.id, ACCOUNTS[4]!.id, `missing-SDI-${CHOICES[1]!.id}`]

const MAIL: MailDomainModel = { identities: loaded(IDENTITIES), companies: MAIL_COMPANIES, sesAccounts: ACCOUNTS.filter((item) => item.provider === 'SES'), can: { manage: true } }
const list = (over: Partial<ConnectionsViewModel> = {}): Case => ({
  page: 'list',
  model: { prefix: PREFIX, accounts: loaded(ACCOUNTS), companies: CHOICES, tile: null, query: '', asOf: NOW, now: NOW, can: { manage: true }, mail: MAIL, delivery: deliveryModel(), ...over },
})
const withDelivery = (over: Partial<DeliveryModel>, page: Partial<ConnectionsViewModel> = {}): Case => list({ ...page, delivery: deliveryModel(over) })
const ledger = <T,>(items: readonly T[] | null, more: string | null = null, problem: string | null = null): Ledger<T> => ({ items, problem, more })
const record = (index: number, over: Partial<ConnectionRecordModel> = {}, dock = false): Case => ({
  page: 'record',
  dock,
  model: {
    prefix: PREFIX,
    tab: 'overview',
    account: ACCOUNTS[index]!,
    companyName: ACCOUNTS[index]!.companyId ? (CHOICES.find((company) => company.id === ACCOUNTS[index]!.companyId)?.name ?? null) : null,
    can: { manage: true },
    calls: ledger(CALLS, CALLS[CALLS.length - 1]!.id),
    failedOnly: false,
    inbound: ledger(INBOUND),
    inboundStatus: null,
    now: NOW,
    ...over,
  },
})

function ConnectionsDesign({ model }: { model: Case }) {
  if (model.page === 'list') return inShell('/admin/connections', createElement(ConnectionsView, { model: model.model }))
  const account = model.model.account
  const panel = account ? panels({ type: 'IntegrationAccount', id: account.id, companyId: account.companyId }, account.label, 'history') : null
  return inShell(`/admin/connections/${account?.id ?? 'x'}`, createElement(ConnectionRecordView, { model: { ...model.model, dockOpen: model.dock }, panels: panel }))
}

export const designScreen = defineDesignScreen<Case>({
  screen: 'SCR-087',
  title: 'Connections & API, and the Connection record',
  view: ConnectionsDesign,
  cases: [
    {
      id: 'services',
      label: 'Every service, in words',
      model: list(),
      note: 'Fake and test services raise the TEST MODE note; the carrier is failing; VAT check is paused; the second company has no SDI and no carrier yet ("Not connected"). The mail domain (SCR-015) follows; c opens the catalogue.',
    },
    { id: 'tile-failing', label: 'Tile: failing', model: list({ tile: 'failing' }) },
    { id: 'tile-test', label: 'Tile: test mode', model: list({ tile: 'test' }) },
    { id: 'no-match', label: 'Search finds nothing', model: list({ query: 'payroll' }) },
    { id: 'live-only', label: 'Everything live: no test-mode note', model: list({ accounts: loaded(LIVE_ONLY), mail: { ...MAIL, identities: loaded([IDENTITY_READY]) } }) },
    { id: 'empty', label: 'No service connected yet', model: list({ accounts: loaded([]), mail: { ...MAIL, identities: loaded([]), sesAccounts: [] } }), note: 'Every service shows "Not connected"; the mail domain says to connect e-mail first.' },
    // B-W2b-24: the virus scanner and error tracking are listed only when an account exists (they wait for the Owner's spend yes).
    { id: 'scanner-account', label: 'A virus-scan account in test mode', model: list({ accounts: loaded([...ACCOUNTS, SCANNER]) }), note: 'B-W2b-24: CLAMAV / ERROR_TRACKING read without failing the page; no "Not connected" row for them (GATE-SPEND).' },
    { id: 'connect', label: 'Connect a service: the catalogue', model: list({ connect: true }), note: 'Honest: connecting from this page comes later (no route adds an account yet); Nexus support connects it, test mode first.' },
    { id: 'pause-confirm', label: 'Pause a service: confirm', model: list({ confirm: { accountId: ACCOUNTS[3]!.id, pause: true } }) },
    { id: 'resume-confirm', label: 'Resume a paused service', model: list({ confirm: { accountId: ACCOUNTS[4]!.id, pause: false } }) },
    { id: 'pause-refused', label: 'Pause: someone changed it meanwhile', model: list({ confirm: { accountId: ACCOUNTS[3]!.id, pause: true }, dialogProblem: 'problem.conflict' }) },
    {
      id: 'services-selected',
      label: 'Services selected: Pause and Resume say their reach',
      model: list({ selected: PICKED }),
      note: 'Pause 2 (the two running ones), Resume 1 (VAT check); the "Not connected" row is ticked but nothing applies to it.',
    },
    {
      id: 'pause-many',
      label: 'Pause 2 services: one confirm',
      model: list({ selected: PICKED, bulk: { pause: true, ids: PICKED } }),
      note: 'What changes once, the services by name, and each one left out with the reason (paused already, not connected).',
    },
    {
      id: 'paused-many',
      label: 'After pausing several: one notice',
      model: list({
        accounts: loaded(ACCOUNTS.map((item) => (item.id === ACCOUNTS[0]!.id ? { ...item, status: 'PAUSED' as const, version: 2 } : item))),
        selected: [ACCOUNTS[3]!.id],
        notice: { key: 'conn.bulk.pausedPartial', tone: 'warning', params: { count: 1, done: 1, refused: 1, total: 2 }, refusedIds: [{ id: ACCOUNTS[3]!.id, problem: 'problem.forbidden' }] },
      }),
      note: 'Each service is one call: what was paused, and each one refused with the reason.',
    },
    { id: 'paused-done', label: 'Paused: the receipt', model: list({ notice: { key: 'conn.done.paused', tone: 'success', params: { name: ACCOUNTS[3]!.label } } }) },
    { id: 'viewer', label: 'Someone who only reads', model: list({ can: { manage: false }, mail: { ...MAIL, can: { manage: false } } }), note: 'Pause and resume are held with the right they need; nothing else changes.' },
    { id: 'no-mail-right', label: 'Without the right to send mail', model: list({ mail: null }) },
    { id: 'no-companies', label: 'Without the right to see companies', model: list({ companies: null }), note: 'Company names are "—"; per-company "Not connected" rows are left out.' },
    { id: 'loading', label: 'Loading', model: list({ accounts: loading(), asOf: null, mail: { ...MAIL, identities: loading() }, delivery: deliveryModel({ mails: ledger0(null), counts: null, blockedCount: null, blocked: ledger0(null) }) }) },
    { id: 'error', label: 'The API did not answer', model: list({ accounts: failed('problem.unavailable'), asOf: null, mail: { ...MAIL, identities: failed('problem.unavailable') }, delivery: deliveryModel({ mails: ledger0(null, null, 'problem.unavailable'), counts: null, blocked: ledger0(null, null, 'problem.unavailable') }) }) },
    // B-W2a-41: the delivery log and blocked addresses (PLT-149).
    {
      id: 'delivery',
      label: 'Delivery log: every mail and where it is (admin, full addresses)',
      model: list(),
      note: 'Under the mail domain: the tiles count 30 days by state; a bounced invoice, a complaint and a mail refused because its address is blocked; the quote, PO and documents mails carried a link. Blocked addresses below with Unblock.',
    },
    { id: 'delivery-masked', label: 'Delivery log: someone who does not manage the mail', model: withDelivery({ mails: ledger0(MAILS_MASKED), blocked: ledger0(BLOCKED.map((row) => ({ ...row, fullAddress: false, address: MASK(row.address) }))), canUnblock: false }), note: 'Addresses masked (the domain stays); Unblock is held with the right it needs.' },
    { id: 'delivery-problems', label: 'Delivery log: bounced or complained', model: withDelivery({ filter: 'PROBLEM', mails: ledger0(MAILS.filter((item) => item.state === 'PROBLEM')) }) },
    { id: 'delivery-invoices', label: 'Delivery log: invoices (one bounced, one refused)', model: withDelivery({ filter: 'INVOICES', mails: ledger0(MAILS.filter((item) => item.record?.type === 'Invoice')) }) },
    { id: 'delivery-links', label: 'Delivery log: mail that carried a link', model: withDelivery({ filter: 'LINKS', mails: ledger0(MAILS.filter((item) => item.link !== null)) }) },
    { id: 'delivery-filter-empty', label: 'Delivery log: nothing matches the filter', model: withDelivery({ filter: 'FAILED', mails: ledger0([]) }) },
    { id: 'delivery-empty', label: 'Delivery log: no mail sent yet, nothing blocked', model: withDelivery({ mails: ledger0([]), counts: { WAITING: 0, SENT: 0, DELIVERED: 0, PROBLEM: 0, FAILED: 0 }, blockedCount: 0, blocked: ledger0([]) }) },
    { id: 'delivery-loading', label: 'Delivery log: loading', model: withDelivery({ mails: ledger0(null), counts: null, blockedCount: null, blocked: ledger0(null) }) },
    { id: 'delivery-error', label: 'Delivery log: the log did not load (the rest of the page works)', model: withDelivery({ mails: ledger0(null, null, 'problem.unavailable'), counts: null, blocked: ledger0(null, null, 'problem.unavailable') }) },
    { id: 'blocked-selected', label: 'Blocked addresses: two ticked', model: withDelivery({ selected: [BLOCKED[0]!.id, BLOCKED[2]!.id] }), note: 'Unblock 2 says its reach.' },
    {
      id: 'unblock-confirm',
      label: 'Unblock: one confirm with the reason',
      model: withDelivery({ selected: [BLOCKED[0]!.id, BLOCKED[1]!.id], confirm: [BLOCKED[0]!.id, BLOCKED[1]!.id] }),
      note: 'One address complained: the confirm warns before mail may reach it again. The reason is required.',
    },
    { id: 'unblock-held', label: 'Unblock held: the right is over every company', model: withDelivery({ canUnblock: false, selected: [BLOCKED[0]!.id] }) },
    {
      id: 'unblocked-done',
      label: 'After unblocking: one notice',
      model: withDelivery({
        blocked: ledger0(BLOCKED.slice(1)),
        blockedCount: 2,
        notice: { key: 'conn.blocked.unblockedPartial', tone: 'warning', params: { count: 1, done: 1, refused: 1, total: 2 }, refusedIds: [{ id: BLOCKED[1]!.id, problem: 'problem.conflict' }] },
      }),
    },
    { id: 'unblocked-view', label: 'Blocked addresses: the unblocked ones (the record)', model: withDelivery({ blockedView: 'UNBLOCKED', blocked: ledger0(UNBLOCKED) }) },
    { id: 'delivery-no-right', label: 'Without the right to read the delivery log', model: list({ delivery: null }), note: 'The section is absent (never a locked box).' },
    { id: 'record-overview', label: 'Connection: overview (SDI, fake)', model: record(2), note: 'Test held: no harmless ping exists on the adapters yet.' },
    { id: 'record-failing', label: 'Connection: failing (carrier, test)', model: record(3) },
    { id: 'record-paused', label: 'Connection: paused (VAT check)', model: record(4) },
    { id: 'record-live', label: 'Connection: live (files)', model: record(1) },
    { id: 'record-settings', label: 'Connection: settings & secrets', model: record(3, { tab: 'settings' }), note: 'Secrets are write-only: saved or not, when — never their value. Replace is held.' },
    { id: 'record-settings-none', label: 'Connection: settings, no secret saved', model: record(0, { tab: 'settings' }) },
    { id: 'record-calls', label: 'Connection: calls', model: record(3, { tab: 'calls' }) },
    { id: 'record-calls-failed', label: 'Connection: failed calls only', model: record(3, { tab: 'calls', failedOnly: true, calls: ledger(CALLS.filter((item) => item.status !== 'SUCCEEDED')) }) },
    { id: 'record-calls-empty', label: 'Connection: no call yet', model: record(4, { tab: 'calls', calls: ledger([]) }) },
    { id: 'record-calls-loading', label: 'Connection: calls loading', model: record(3, { tab: 'calls', calls: ledger(null) }) },
    { id: 'record-calls-error', label: 'Connection: calls did not load', model: record(3, { tab: 'calls', calls: ledger(null, null, 'problem.unavailable') }) },
    { id: 'record-inbound', label: 'Connection: received messages', model: record(3, { tab: 'inbound' }), note: 'Never a message body.' },
    { id: 'record-inbound-empty', label: 'Connection: nothing received', model: record(2, { tab: 'inbound', inbound: ledger([]) }) },
    { id: 'record-inbound-none', label: 'Connection: a service that sends nothing', model: record(1, { tab: 'inbound', inbound: ledger([]) }) },
    { id: 'record-activity', label: 'Connection: activity', model: record(3, { tab: 'activity' }) },
    { id: 'record-dock', label: 'Connection: history beside the overview (≥ 1280 px)', model: record(3, {}, true) },
    { id: 'record-pause', label: 'Connection: pause, confirm', model: record(3, { confirm: { accountId: ACCOUNTS[3]!.id, pause: true } }) },
    { id: 'record-viewer', label: 'Connection: someone who only reads', model: record(3, { can: { manage: false } }) },
    { id: 'record-not-found', label: 'Connection: not found', model: { page: 'record', model: { prefix: PREFIX, tab: 'overview', account: null, problem: 'problem.notFound', companyName: null, can: { manage: true }, calls: ledger(null), failedOnly: false, inbound: ledger(null), inboundStatus: null, now: NOW } } },
    { id: 'record-loading', label: 'Connection: loading', model: { page: 'record', model: { prefix: PREFIX, tab: 'overview', account: null, problem: null, companyName: null, can: { manage: true }, calls: ledger(null), failedOnly: false, inbound: ledger(null), inboundStatus: null, now: NOW } } },
  ],
})

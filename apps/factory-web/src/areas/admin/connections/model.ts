import { matches, type Loaded, type Notice, type StepUpModel } from '../shared/model'
import { reachOf, type BulkNotice, type Reach } from '../kit/bulk-model'
import type { AccountStatus, InboundDelivery, InboundStatus, IntegrationAccount, IntegrationCall, IntegrationMode, IntegrationProvider } from './api'
import type { MailDomainModel } from './mail/model'
import type { DeliveryModel } from './delivery/model'

/**
 * SCR-087 Connections & API (design 02 admin.connections; PLT-139, PLT-195, PLT-197, PLT-011): every rented pipe in
 * words for a non-technical owner — what it is for, whether it works, in which mode — and the kill switch. Pure: the
 * state words, the tiles, the rows (an account, or a service that is not connected yet), what we know of where data
 * lives, and the Connection record's tabs. The mail domain section is SCR-015 (mail/model.ts).
 *
 * W0 honest limits (API gaps, written on the screen): connecting a service and replacing a secret have no route yet
 * (Nexus support sets them up); "Test connection" needs a ping operation on each provider's adapter.
 */

/** The catalogue order of the services (design `connect`: e-mail, files, SDI, carrier, VAT check). */
export const PROVIDER_ORDER: readonly IntegrationProvider[] = ['SES', 'R2', 'SDI', 'SENDCLOUD', 'VIES']
/** One account per company (the SDI intermediary, the carrier); the others are tenant-wide (the environment's). */
export const PER_COMPANY: ReadonlySet<IntegrationProvider> = new Set(['SDI', 'SENDCLOUD'])
/** Services the design names for later waves (shown in the catalogue as "later"). */
export const LATER_SERVICES = ['payroll', 'edi', 'ai'] as const

export const CONNECTION_TILES = ['working', 'failing', 'test', 'paused', 'waiting'] as const
export type ConnectionTile = (typeof CONNECTION_TILES)[number]

/** What an account's state is, in words: the key of `conn.state.<key>` and the time it names. */
export type AccountState =
  | { key: 'working'; at: string; tone: 'success' }
  | { key: 'failing'; at: string; tone: 'danger' }
  | { key: 'notCalled'; tone: 'neutral' }
  | { key: 'paused'; tone: 'warning' }
  | { key: 'disabled'; tone: 'neutral' }

export function accountState(account: Pick<IntegrationAccount, 'status' | 'lastOkAt' | 'lastErrorAt'>): AccountState {
  if (account.status === 'PAUSED') return { key: 'paused', tone: 'warning' }
  if (account.status === 'DISABLED') return { key: 'disabled', tone: 'neutral' }
  const ok = account.lastOkAt ? Date.parse(account.lastOkAt) : null
  const error = account.lastErrorAt ? Date.parse(account.lastErrorAt) : null
  if (error !== null && (ok === null || error > ok)) return { key: 'failing', at: account.lastErrorAt!, tone: 'danger' }
  if (ok !== null) return { key: 'working', at: account.lastOkAt!, tone: 'success' }
  return { key: 'notCalled', tone: 'neutral' }
}

/** Test and Fake modes reach nobody: invoices, labels and mail stay inside (the design's TEST MODE). */
export const isTestMode = (mode: IntegrationMode) => mode !== 'LIVE'

export const MODE_TONE: Readonly<Record<IntegrationMode, 'success' | 'warning' | 'info'>> = { LIVE: 'success', SANDBOX: 'info', FAKE: 'warning' }

export function tileMatch(tile: ConnectionTile, account: IntegrationAccount): boolean {
  const state = accountState(account)
  if (tile === 'working') return state.key === 'working'
  if (tile === 'failing') return state.key === 'failing'
  if (tile === 'test') return account.status !== 'DISABLED' && isTestMode(account.mode)
  if (tile === 'paused') return account.status === 'PAUSED'
  return account.inboundWaiting > 0
}

export interface CompanyChoice {
  id: string
  code: string
  name: string
}

/** A row of the services list: an account, or a service a company (or the tenant) has no account for. */
export type ServiceRow = { kind: 'account'; id: string; account: IntegrationAccount } | { kind: 'missing'; id: string; provider: IntegrationProvider; companyId: string | null }

/**
 * The services list: the accounts (filtered by tile and search), then one "Not connected" row per service nobody
 * connected — per active company for SDI and the carrier (only when the companies were read), once for the tenant-wide
 * services. A tile shows accounts only.
 */
export function serviceRows(accounts: readonly IntegrationAccount[], companies: readonly CompanyChoice[] | null, tile: ConnectionTile | null, query: string, words: (provider: IntegrationProvider) => string): ServiceRow[] {
  const companyName = (id: string | null) => (id ? companies?.find((company) => company.id === id)?.name : null)
  const order = (provider: IntegrationProvider) => PROVIDER_ORDER.indexOf(provider)
  const live = accounts.filter((account) => account.status !== 'DISABLED')
  const rows: ServiceRow[] = live
    .filter((account) => (tile ? tileMatch(tile, account) : true))
    .filter((account) => matches(query, account.label, account.code, words(account.provider), companyName(account.companyId)))
    .sort((a, b) => order(a.provider) - order(b.provider) || a.code.localeCompare(b.code))
    .map((account) => ({ kind: 'account', id: account.id, account }))
  if (tile) return rows
  for (const provider of PROVIDER_ORDER) {
    const missing: Array<string | null> = []
    if (PER_COMPANY.has(provider)) {
      for (const company of companies ?? []) if (!live.some((account) => account.provider === provider && account.companyId === company.id)) missing.push(company.id)
    } else if (!live.some((account) => account.provider === provider)) missing.push(null)
    for (const companyId of missing) {
      if (!matches(query, words(provider), companyName(companyId))) continue
      rows.push({ kind: 'missing', id: `missing-${provider}-${companyId ?? 'all'}`, provider, companyId })
    }
  }
  return rows
}

/** "Where your data lives": per account, its service and the region its settings name (never a guessed one). */
export function residencyRows(accounts: readonly IntegrationAccount[]): Array<{ id: string; provider: IntegrationProvider; label: string; region: string | null; mode: IntegrationMode }> {
  return accounts
    .filter((account) => account.status !== 'DISABLED')
    .map((account) => {
      const region = account.settings.region
      return { id: account.id, provider: account.provider, label: account.label, region: typeof region === 'string' && region.trim() !== '' ? region : null, mode: account.mode }
    })
    .sort((a, b) => PROVIDER_ORDER.indexOf(a.provider) - PROVIDER_ORDER.indexOf(b.provider) || a.label.localeCompare(b.label))
}

/** A pause or resume confirm. */
export interface PauseConfirm {
  accountId: string
  pause: boolean
}

/** "Pause N" / "Resume N" (bulk) asked for these rows (ids of the services list). */
export interface BulkSwitch {
  pause: boolean
  ids: readonly string[]
}

/**
 * Which selected rows "Pause N" (pause: true) or "Resume N" applies to: connected services that are running, or paused;
 * a "Not connected" row is left out (nothing to pause), and so is one already in the asked state. Each is one
 * `POST /integrations/accounts/:id/pause|resume` with its version (no call switches many).
 */
export function switchReach(rows: readonly ServiceRow[], pause: boolean): Reach<ServiceRow & { kind: 'account' }> {
  const reach = reachOf(rows, (row) => {
    if (row.kind === 'missing') return 'conn.bulk.left.notConnected'
    if (pause) return row.account.status === 'ACTIVE' ? null : 'conn.bulk.left.paused'
    return row.account.status === 'PAUSED' ? null : 'conn.bulk.left.running'
  })
  return reach as Reach<ServiceRow & { kind: 'account' }>
}

export interface ConnectionsAbilities {
  /** integrations.manage: pause and resume. */
  manage: boolean
}

export interface ConnectionsViewModel {
  prefix: string
  accounts: Loaded<IntegrationAccount>
  /** The companies (GET /org/companies); null when not read (no companies.view): names and per-company rows absent. */
  companies: readonly CompanyChoice[] | null
  tile: ConnectionTile | null
  query: string
  asOf: string | null
  /** "Now", for "last OK 10:41" (today: the time; earlier: the day too). A fixture fixes it. */
  now: string
  can: ConnectionsAbilities
  /** The "Connect a service" catalogue is open. */
  connect?: boolean
  confirm?: PauseConfirm | null
  /** The rows ticked in the services list (ids of `serviceRows`). */
  selected?: readonly string[]
  /** The bulk pause or resume confirm, open. */
  bulk?: BulkSwitch | null
  busy?: boolean
  dialogProblem?: string | null
  notice?: BulkNotice | null
  /** The mail domain section (SCR-015); null: the person may not read sending identities (email.send). */
  mail: MailDomainModel | null
  /** The delivery log and blocked addresses (B-W2a-41); null or absent: the person may not read it (email.delivery.view). */
  delivery?: DeliveryModel | null
  stepUp?: StepUpModel
}

// ---- the Connection record ----

export const CONNECTION_TABS = ['overview', 'settings', 'calls', 'inbound', 'activity'] as const
export type ConnectionTab = (typeof CONNECTION_TABS)[number]

/** A ledger read page by page (newest first): null items while loading, `more` = the next page's anchor. */
export interface Ledger<T> extends Loaded<T> {
  more: string | null
  loadingMore?: boolean
}

export interface ConnectionRecordModel {
  prefix: string
  tab: ConnectionTab
  account: IntegrationAccount | null
  problem?: string | null
  /** The account's company name; null for a tenant-wide account (or unknown). */
  companyName: string | null
  can: ConnectionsAbilities
  calls: Ledger<IntegrationCall>
  failedOnly: boolean
  inbound: Ledger<InboundDelivery>
  inboundStatus: InboundStatus | null
  confirm?: PauseConfirm | null
  busy?: boolean
  dialogProblem?: string | null
  notice?: Notice | null
  dockOpen?: boolean
  now: string
}

/** The record's head status and the action it offers next (pause an active account, resume a paused one). */
export function nextSwitch(status: AccountStatus): 'pause' | 'resume' | null {
  if (status === 'ACTIVE') return 'pause'
  if (status === 'PAUSED') return 'resume'
  return null
}

/** Call states that count as failed in the ledger. */
export const FAILED_CALL: ReadonlySet<string> = new Set(['FAILED', 'TIMED_OUT', 'REFUSED'])

export const CALL_TONE: Readonly<Record<string, 'success' | 'danger' | 'warning' | 'neutral'>> = { SUCCEEDED: 'success', FAILED: 'danger', TIMED_OUT: 'warning', REFUSED: 'neutral' }
export const INBOUND_TONE: Readonly<Record<string, 'success' | 'danger' | 'warning' | 'neutral' | 'info'>> = { RECEIVED: 'info', PROCESSED: 'success', FAILED: 'danger', REJECTED: 'neutral' }

/** The gateway's refusal codes we have words for (`conn.reason.<code>`); others show the code itself. */
export const KNOWN_REASONS = ['account_paused', 'account_disabled', 'circuit_open', 'rate_limited', 'gateway_unavailable', 'fake_in_production', 'timeout', 'provider_error', 'network_error'] as const

/** The settings keys shown in words (others are shown as written). */
export const KNOWN_SETTINGS = ['region', 'configurationSet', 'awsAccountId', 'inboundBucket'] as const

/** The same calendar day in Rome (the default office zone): "10:41" reads as today. */
export function sameDay(a: string, b: string): boolean {
  const day = (value: string) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value))
  return day(a) === day(b)
}

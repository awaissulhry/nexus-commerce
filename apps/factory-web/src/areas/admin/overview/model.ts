import type { SetupStep } from '../shared/view/SetupChecklist'
import { adminHref } from '../shared/model'

/**
 * Admin › All settings (design 02 admin.overview; Owner O2: the "Get the factory ready" checklist ships in W0, read-only,
 * from real checks). Each step's state is a fact read from the API, not a tick box; this file turns the reads into the
 * steps (pure: the tests hold every state). What each step reads:
 *
 *   legal     GET /org/companies          every active company can issue invoices (platform/admin/org `invoicing`)
 *   sites     GET /org/companies          every active company has a site; every plant has a station
 *   mail      GET /email/identities       a sending domain is verified (`ready`)
 *   numbering GET /numbering/series       every active company has an invoice number series
 *   people    GET /auth/users             someone besides me is active or invited
 *   roles     GET /auth/roles             no ready-made role is out of date; no custom copy misses what its template gained
 *   tablets   GET /auth/floor/devices     a tablet is enrolled (active); one waiting for its tablet is "Waiting"
 *   printers  GET /print/printers         a printer is active
 *   sdi       GET /integrations/accounts  every active company has a live, active SDI connection (B-W0-28)
 *   privacy   GET /privacy/overview       every company's privacy duties are done
 *   stock     GET /imports                an opening-stock import was applied (importer inventory.opening, B-W1-35)
 */

/** One read for the checklist: still checking, done, failed (a message key), or not the person's to read. */
export type Read<T> = { state: 'checking' } | { state: 'ok'; value: T } | { state: 'failed'; problem: string } | { state: 'no-right'; need: string }

export interface OverviewFacts {
  me: string
  companies: Read<ReadonlyArray<{ id: string; code: string; legalName: string; status: string; invoicing: { ready: boolean; issues: readonly unknown[] }; sites: ReadonlyArray<{ id: string; companyId: string; name: string; kind: string; status: string; counts: { stations: number } }> }>>
  identities: Read<ReadonlyArray<{ domain: string; ready: boolean; status: string }>>
  series: Read<ReadonlyArray<{ companyId: string; kind: string; status: string }>>
  users: Read<ReadonlyArray<{ id: string; status: string }>>
  roles: Read<ReadonlyArray<{ system: boolean; outdated: boolean; templateAdds: { permissionsAdded: readonly string[]; grainsAdded: readonly string[] } }>>
  devices: Read<ReadonlyArray<{ status: string }>>
  printers: Read<ReadonlyArray<{ status: string }>>
  privacy: Read<ReadonlyArray<{ company: { id: string }; duties: ReadonlyArray<{ done: boolean }> }>>
  accounts: Read<ReadonlyArray<{ provider: string; companyId: string | null; mode: string; status: string }>>
  imports: Read<ReadonlyArray<{ importerKey: string; status: string }>>
}

export type ReadName = Exclude<keyof OverviewFacts, 'me'>

/** The opening-stock importer's key (factory-domain inventory/opening, B-W1-35). */
export const OPENING_STOCK = 'inventory.opening'

/** The right each read needs (the container reads only what the person holds). */
export const READ_RIGHTS: Readonly<Record<ReadName, string>> = {
  companies: 'companies.view',
  identities: 'email.send',
  series: 'numbering.view',
  users: 'users.view',
  roles: 'roles.view',
  devices: 'devices.view',
  printers: 'print.view',
  privacy: 'privacy.view',
  accounts: 'integrations.view',
  imports: 'imports.view',
}

export const STEP_IDS = ['legal', 'sites', 'mail', 'numbering', 'people', 'roles', 'tablets', 'printers', 'sdi', 'privacy', 'stock'] as const
export type StepId = (typeof STEP_IDS)[number]

/** Which read each step rests on (a retry reads it again). */
export const STEP_READ: Readonly<Record<StepId, ReadName | null>> = {
  legal: 'companies',
  sites: 'companies',
  mail: 'identities',
  numbering: 'series',
  people: 'users',
  roles: 'roles',
  tablets: 'devices',
  printers: 'printers',
  sdi: 'accounts',
  privacy: 'privacy',
  stock: 'imports',
}

const MINUTES: Readonly<Record<StepId, number>> = { legal: 5, sites: 10, mail: 15, numbering: 5, people: 5, roles: 10, tablets: 5, printers: 5, sdi: 15, privacy: 30, stock: 30 }

export interface OverviewViewModel {
  /** `/w/<company>`. */
  prefix: string
  steps: readonly SetupStep[]
  /** When the checks last ran. */
  checkedAt: string | null
  /** Every step done: the list folds away until "Show set-up". */
  showAll: boolean
}

/** A step whose read is not ready: checking, failed, or not the person's. */
function pending(id: StepId, read: Read<unknown>): Pick<SetupStep, 'state' | 'detail'> | null {
  if (read.state === 'checking') return { state: 'checking', detail: { key: 'overview.detail.checking' } }
  if (read.state === 'failed') return { state: 'failed', detail: { key: 'overview.detail.failed', need: read.problem } }
  if (read.state === 'no-right') return { state: 'unknown', detail: { key: 'overview.detail.noRight', need: `right.${read.need.replace(/\./g, '_')}` } }
  void id
  return null
}

/** The checklist's steps from what was read, in the design's order. `built` holds the office pages that exist. */
export function setupSteps(facts: OverviewFacts, prefix: string, built: ReadonlySet<string>): SetupStep[] {
  const href = (path: string, page = path.split('?')[0] ?? path) => (built.has(`/admin${page}`) ? adminHref(prefix, path) : undefined)
  const step = (id: StepId, body: Pick<SetupStep, 'state' | 'detail'> & { href?: string }): SetupStep => ({ id, name: `overview.step.${id}`, minutes: MINUTES[id], ...body })
  const steps: SetupStep[] = []

  // Company legal data, and sites and lines.
  const companies = facts.companies
  if (companies.state !== 'ok') {
    steps.push(step('legal', pending('legal', companies)!), step('sites', pending('sites', companies)!))
  } else {
    const active = companies.value.filter((company) => company.status === 'ACTIVE')
    const notReady = active.filter((company) => !company.invoicing.ready)
    if (active.length === 0) steps.push(step('legal', { state: 'needs', detail: { key: 'overview.detail.legal.none' }, href: href('/companies?new=company', '/companies') }))
    else if (notReady.length > 0) {
      const first = notReady[0]!
      steps.push(
        step('legal', {
          state: 'needs',
          detail: { key: notReady.length > 1 ? 'overview.detail.legal.needsMore' : 'overview.detail.legal.needs', params: { name: first.legalName, count: first.invoicing.issues.length, others: notReady.length - 1 } },
          href: href(`/companies/${first.id}?tab=legal`, '/companies/[companyId]'),
        }),
      )
    } else steps.push(step('legal', { state: 'done', detail: { key: 'overview.detail.legal.done', params: { count: active.length } }, href: href('/companies') }))

    const noSite = active.find((company) => !company.sites.some((site) => site.status === 'ACTIVE'))
    const plants = active.flatMap((company) => company.sites.filter((site) => site.status === 'ACTIVE' && site.kind === 'PLANT'))
    const bare = plants.find((site) => site.counts.stations === 0)
    if (active.length === 0) steps.push(step('sites', { state: 'blocked', detail: { key: 'overview.detail.sites.blocked' } }))
    else if (noSite) steps.push(step('sites', { state: 'needs', detail: { key: 'overview.detail.sites.noSite', params: { name: noSite.legalName } }, href: href(`/companies/${noSite.id}?tab=sites`, '/companies/[companyId]') }))
    else if (bare)
      steps.push(
        step('sites', {
          state: 'needs',
          detail: { key: 'overview.detail.sites.noStation', params: { name: bare.name } },
          href: href(`/companies/${bare.companyId}/sites/${bare.id}`, '/companies/[companyId]/sites/[siteId]'),
        }),
      )
    else steps.push(step('sites', { state: 'done', detail: { key: 'overview.detail.sites.done', params: { count: plants.length } }, href: href('/companies') }))
  }

  // Mail domain verified.
  const identities = facts.identities
  if (identities.state !== 'ok') steps.push(step('mail', pending('mail', identities)!))
  else {
    const live = identities.value.filter((identity) => identity.status !== 'DISABLED')
    const ready = live.filter((identity) => identity.ready)
    // The mail domain lives on Connections & API (design 02 admin.connections: no separate mail page).
    const mail = href('/connections#mail', '/connections')
    if (ready.length > 0) steps.push(step('mail', { state: 'done', detail: { key: 'overview.detail.mail.done', params: { domain: ready[0]!.domain } }, href: mail }))
    else if (live.length > 0) steps.push(step('mail', { state: 'waiting', detail: { key: 'overview.detail.mail.waiting', params: { domain: live[0]!.domain } }, href: mail }))
    else steps.push(step('mail', { state: 'needs', detail: { key: mail ? 'overview.detail.mail.none' : 'overview.detail.mail.noneLater' }, href: mail }))
  }

  // Number series start values.
  const series = facts.series
  if (series.state !== 'ok') steps.push(step('numbering', pending('numbering', series)!))
  else if (companies.state === 'ok') {
    const active = companies.value.filter((company) => company.status === 'ACTIVE')
    const missing = active.filter((company) => !series.value.some((row) => row.companyId === company.id && row.kind === 'INVOICE' && row.status === 'ACTIVE'))
    if (missing.length > 0)
      steps.push(
        step('numbering', {
          state: 'needs',
          detail: { key: href('/documents') ? 'overview.detail.numbering.needs' : 'overview.detail.numbering.needsLater', params: { name: missing[0]!.legalName } },
          href: href(`/documents?company=${missing[0]!.id}&new=series`, '/documents'),
        }),
      )
    else steps.push(step('numbering', { state: 'done', detail: { key: 'overview.detail.numbering.done', params: { count: series.value.length } }, href: href('/documents') }))
  } else steps.push(step('numbering', pending('numbering', companies)!))

  // People invited.
  const users = facts.users
  if (users.state !== 'ok') steps.push(step('people', pending('people', users)!))
  else {
    const others = users.value.filter((user) => user.id !== facts.me)
    const active = others.filter((user) => user.status === 'ACTIVE')
    const invited = others.filter((user) => user.status === 'INVITED')
    if (active.length > 0) steps.push(step('people', { state: 'done', detail: { key: 'overview.detail.people.done', params: { count: active.length } }, href: href('/users') }))
    else if (invited.length > 0) steps.push(step('people', { state: 'waiting', detail: { key: 'overview.detail.people.waiting', params: { count: invited.length } }, href: href('/users') }))
    else steps.push(step('people', { state: 'needs', detail: { key: 'overview.detail.people.none' }, href: href('/users?new=invite', '/users') }))
  }

  // Roles checked.
  const roles = facts.roles
  if (roles.state !== 'ok') steps.push(step('roles', pending('roles', roles)!))
  else {
    const behind = roles.value.filter((role) => role.outdated || role.templateAdds.permissionsAdded.length + role.templateAdds.grainsAdded.length > 0)
    if (behind.length > 0) steps.push(step('roles', { state: 'needs', detail: { key: 'overview.detail.roles.needs', params: { count: behind.length } }, href: href('/roles') }))
    else steps.push(step('roles', { state: 'done', detail: { key: 'overview.detail.roles.done', params: { count: roles.value.length } }, href: href('/roles') }))
  }

  // Tablets enrolled.
  const devices = facts.devices
  if (devices.state !== 'ok') steps.push(step('tablets', pending('tablets', devices)!))
  else {
    const active = devices.value.filter((device) => device.status === 'ACTIVE').length
    const waiting = devices.value.filter((device) => device.status === 'PENDING').length
    if (active > 0) steps.push(step('tablets', { state: 'done', detail: { key: 'overview.detail.tablets.done', params: { count: active } }, href: href('/devices') }))
    else if (waiting > 0) steps.push(step('tablets', { state: 'waiting', detail: { key: 'overview.detail.tablets.waiting', params: { count: waiting } }, href: href('/devices') }))
    else steps.push(step('tablets', { state: 'needs', detail: { key: 'overview.detail.tablets.none' }, href: href('/devices?enrol=1', '/devices') }))
  }

  // Printers.
  const printers = facts.printers
  if (printers.state !== 'ok') steps.push(step('printers', pending('printers', printers)!))
  else {
    const active = printers.value.filter((printer) => printer.status === 'ACTIVE').length
    if (active > 0) steps.push(step('printers', { state: 'done', detail: { key: 'overview.detail.printers.done', params: { count: active } }, href: href('/devices?mode=printers', '/devices') }))
    else steps.push(step('printers', { state: 'needs', detail: { key: 'overview.detail.printers.none' }, href: href('/devices?mode=printers&new=printer', '/devices') }))
  }

  // SDI connection: each active company's own SDI account (the intermediary), active and live.
  const accounts = facts.accounts
  if (accounts.state !== 'ok') steps.push(step('sdi', pending('sdi', accounts)!))
  else if (companies.state !== 'ok') steps.push(step('sdi', pending('sdi', companies)!))
  else {
    const active = companies.value.filter((company) => company.status === 'ACTIVE')
    const sdiOf = (companyId: string) => accounts.value.filter((account) => account.provider === 'SDI' && account.companyId === companyId && account.status !== 'DISABLED')
    const none = active.find((company) => sdiOf(company.id).length === 0)
    const paused = active.find((company) => sdiOf(company.id).every((account) => account.status === 'PAUSED'))
    const test = active.find((company) => !sdiOf(company.id).some((account) => account.status === 'ACTIVE' && account.mode === 'LIVE'))
    const connections = href('/connections')
    if (active.length === 0) steps.push(step('sdi', { state: 'blocked', detail: { key: 'overview.detail.sdi.blocked' } }))
    else if (none) steps.push(step('sdi', { state: 'needs', detail: { key: 'overview.detail.sdi.none', params: { name: none.legalName } }, href: connections }))
    else if (paused) steps.push(step('sdi', { state: 'needs', detail: { key: 'overview.detail.sdi.paused', params: { name: paused.legalName } }, href: connections }))
    else if (test) steps.push(step('sdi', { state: 'waiting', detail: { key: 'overview.detail.sdi.test', params: { name: test.legalName } }, href: connections }))
    else steps.push(step('sdi', { state: 'done', detail: { key: 'overview.detail.sdi.done', params: { count: active.length } }, href: connections }))
  }

  // Privacy register and worker notice.
  const privacy = facts.privacy
  if (privacy.state !== 'ok') steps.push(step('privacy', pending('privacy', privacy)!))
  else {
    const open = privacy.value.reduce((sum, company) => sum + company.duties.filter((duty) => !duty.done).length, 0)
    if (privacy.value.length > 0 && open === 0) steps.push(step('privacy', { state: 'done', detail: { key: 'overview.detail.privacy.done' }, href: href('/privacy') }))
    else steps.push(step('privacy', { state: 'needs', detail: { key: href('/privacy') ? 'overview.detail.privacy.needs' : 'overview.detail.privacy.needsLater', params: { count: open } }, href: href('/privacy') }))
  }

  // Opening stock: an applied import of the opening-stock importer (B-W1-35), read from the import jobs.
  const imports = facts.imports
  if (imports.state !== 'ok') steps.push(step('stock', pending('stock', imports)!))
  else {
    const opening = imports.value.filter((job) => job.importerKey === OPENING_STOCK)
    const applied = opening.filter((job) => job.status === 'APPLIED')
    const underWay = opening.filter((job) => ['UPLOADED', 'PLANNED', 'APPLYING'].includes(job.status))
    const page = href(`/import?importer=${OPENING_STOCK}`, '/import')
    if (applied.length > 0) steps.push(step('stock', { state: 'done', detail: { key: 'overview.detail.stock.done', params: { count: applied.length } }, href: href('/import') }))
    else if (underWay.length > 0) steps.push(step('stock', { state: 'waiting', detail: { key: 'overview.detail.stock.waiting', params: { count: underWay.length } }, href: href('/import') }))
    else steps.push(step('stock', { state: 'needs', detail: { key: 'overview.detail.stock.none' }, href: page }))
  }
  return steps
}

/** "5 of 11 done". */
export const doneCount = (steps: readonly SetupStep[]) => steps.filter((item) => item.state === 'done').length

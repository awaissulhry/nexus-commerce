import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { createApiClient, type ApiClient } from '../../../lib/api/client'
import { isApiError } from '../../../lib/api/errors'
import type { DesignScreen } from '../../../lib/design/design-screen'
import { LOCALES } from '../../../lib/i18n/locales'
import { CATALOGUE, messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { bulkHeld } from '../kit/bulk-model'
import { runWithStepUp } from '../shared/step-up'
import { checkIdentity, INBOUND_STATUSES, INTEGRATION_MODES, INTEGRATION_PROVIDERS, CALL_STATUSES, listAccounts, listCalls, setPaused, DISPLAY_NAME_POLICIES, IDENTITY_KINDS } from './api'
import { ACCOUNTS, CALLS, CHOICES, designScreen as connectionsScreen, SCANNER, IDENTITY_FAILED, IDENTITY_READY, IDENTITY_WAITING } from './fixtures'
import { designScreen as mailScreen } from './mail/fixtures'
import { dnsRows, draftProblems, emptyDraft, fromAddressOf, identityState, recordStateOf, recordsText } from './mail/model'
import { accountState, AWAITING_SPEND, CONNECTION_TILES, KNOWN_REASONS, KNOWN_SETTINGS, LATER_SERVICES, residencyRows, sameDay, serviceRows, switchReach, tileMatch } from './model'
import { CallsCell, ServiceCell, StateCell } from './view/ConnectionsView'
import { ConnectionsMessages } from './view/parts'

/**
 * Connections & API (B-W0-28, SCR-087 and SCR-015): the state words, tiles and "Not connected" rows; what we know of
 * where data lives; the mail domain's states and records; the calls against a mocked API (pause sends the version read,
 * a check asked for a fresh code runs once more); every design case drawn in it and en with no key left on screen; and
 * no secret ever drawn.
 */

const words = (provider: string) => provider

describe('an account in words', () => {
  it('says paused, no longer used, failing since, working since, or not called yet', () => {
    expect(accountState({ status: 'PAUSED', lastOkAt: '2026-10-29T09:00:00.000Z', lastErrorAt: null })).toEqual({ key: 'paused', tone: 'warning' })
    expect(accountState({ status: 'DISABLED', lastOkAt: null, lastErrorAt: null }).key).toBe('disabled')
    expect(accountState({ status: 'ACTIVE', lastOkAt: '2026-10-29T08:00:00.000Z', lastErrorAt: '2026-10-29T09:00:00.000Z' })).toEqual({ key: 'failing', at: '2026-10-29T09:00:00.000Z', tone: 'danger' })
    expect(accountState({ status: 'ACTIVE', lastOkAt: '2026-10-29T09:30:00.000Z', lastErrorAt: '2026-10-29T09:00:00.000Z' })).toEqual({ key: 'working', at: '2026-10-29T09:30:00.000Z', tone: 'success' })
    expect(accountState({ status: 'ACTIVE', lastOkAt: null, lastErrorAt: null }).key).toBe('notCalled')
  })

  it('counts the tiles from the same rule the list filters by', () => {
    const count = (tile: (typeof CONNECTION_TILES)[number]) => ACCOUNTS.filter((account) => tileMatch(tile, account)).length
    expect(CONNECTION_TILES.map((tile) => [tile, count(tile)])).toEqual([
      ['working', 3],
      ['failing', 1],
      ['test', 4],
      ['paused', 1],
      ['waiting', 1],
    ])
  })

  it('compares days in Rome: 23:30 UTC on the 28th is already the 29th there', () => {
    expect(sameDay('2026-10-28T23:30:00.000Z', '2026-10-29T08:00:00.000Z')).toBe(true)
    expect(sameDay('2026-10-28T21:30:00.000Z', '2026-10-29T08:00:00.000Z')).toBe(false)
  })
})

describe('the services list', () => {
  it('lists the accounts by service, then a "Not connected" row per company for SDI and the carrier', () => {
    const rows = serviceRows(ACCOUNTS, CHOICES, null, '', words)
    expect(rows.filter((row) => row.kind === 'account').map((row) => (row.kind === 'account' ? row.account.code : ''))).toEqual(['mail', 'files', 'sdi-demo', 'sendcloud-demo', 'vies'])
    expect(rows.filter((row) => row.kind === 'missing').map((row) => (row.kind === 'missing' ? [row.provider, row.companyId] : null))).toEqual([
      ['SDI', CHOICES[1]!.id],
      ['SENDCLOUD', CHOICES[1]!.id],
    ])
  })

  it('without companies, only the tenant-wide services can be "not connected"; with nothing connected, every one is', () => {
    expect(serviceRows(ACCOUNTS, null, null, '', words).filter((row) => row.kind === 'missing')).toEqual([])
    expect(serviceRows([], null, null, '', words).map((row) => (row.kind === 'missing' ? row.provider : ''))).toEqual(['SES', 'R2', 'VIES'])
    expect(serviceRows([], CHOICES, null, '', words)).toHaveLength(3 + 2 * CHOICES.length)
  })

  it('B-W2b-24: the virus scanner and error tracking are listed when an account exists, never as "Not connected" (GATE-SPEND)', () => {
    expect([...AWAITING_SPEND].sort()).toEqual(['CLAMAV', 'ERROR_TRACKING'])
    expect(serviceRows([], CHOICES, null, '', words).some((row) => row.kind === 'missing' && AWAITING_SPEND.has(row.provider))).toBe(false)
    const rows = serviceRows([...ACCOUNTS, SCANNER], CHOICES, null, '', words)
    expect(rows.filter((row) => row.kind === 'account').map((row) => (row.kind === 'account' ? row.account.code : ''))).toEqual(['mail', 'files', 'sdi-demo', 'sendcloud-demo', 'vies', 'virus-scan'])
  })

  it('a tile shows accounts only; the search reads the label, the code, the service and the company', () => {
    expect(serviceRows(ACCOUNTS, CHOICES, 'failing', '', words).map((row) => row.id)).toEqual([ACCOUNTS[3]!.id])
    expect(serviceRows(ACCOUNTS, CHOICES, null, 'sendcloud', words).map((row) => row.kind)).toEqual(['account', 'missing'])
    expect(serviceRows(ACCOUNTS, CHOICES, null, 'payroll', words)).toEqual([])
  })

  it('says where data lives only from the account\'s own settings, never a guessed region', () => {
    const rows = residencyRows(ACCOUNTS)
    expect(rows.map((row) => [row.provider, row.region])).toEqual([
      ['SES', 'eu-south-1'],
      ['R2', 'eu'],
      ['SDI', null],
      ['SENDCLOUD', null],
      ['VIES', null],
    ])
  })
})

describe('pausing or resuming several services at once', () => {
  const rows = serviceRows(ACCOUNTS, CHOICES, null, '', words)
  const pick = (...ids: string[]) => rows.filter((row) => ids.includes(row.id))
  const missing = rows.find((row) => row.kind === 'missing')!
  const [mail, , , carrier, vat] = ACCOUNTS as [(typeof ACCOUNTS)[number], unknown, unknown, (typeof ACCOUNTS)[number], (typeof ACCOUNTS)[number]]

  it('Pause applies to the running services; a paused one and a "Not connected" row are left out with the reason', () => {
    const reach = switchReach(pick(mail.id, carrier.id, vat.id, missing.id), true)
    expect(reach.applies.map((row) => row.account.id)).toEqual([mail.id, carrier.id])
    expect(reach.left.map((entry) => entry.why)).toEqual(['conn.bulk.left.paused', 'conn.bulk.left.notConnected'])
  })

  it('Resume applies to the paused services only', () => {
    const reach = switchReach(pick(mail.id, vat.id, missing.id), false)
    expect(reach.applies.map((row) => row.account.id)).toEqual([vat.id])
    expect(reach.left.map((entry) => entry.why)).toEqual(['conn.bulk.left.running', 'conn.bulk.left.notConnected'])
  })

  it('held without the right, and when nothing selected can be switched', () => {
    expect(bulkHeld(switchReach(pick(mail.id), true), false, { right: 'held.needs', none: 'conn.bulk.noneToPause' })).toBe('held.needs')
    expect(bulkHeld(switchReach(pick(missing.id), true), true, { right: 'held.needs', none: 'conn.bulk.noneToPause' })).toBe('conn.bulk.noneToPause')
    expect(bulkHeld(switchReach(pick(vat.id), true), true, { right: 'held.needs', none: 'conn.bulk.noneToPause' })).toBe('conn.bulk.noneToPause')
    expect(bulkHeld(switchReach(pick(vat.id), false), true, { right: 'held.needs', none: 'conn.bulk.noneToResume' })).toBeNull()
  })
})

describe('the mail domain', () => {
  it('says ready, waiting, not verified or switched off', () => {
    expect(identityState(IDENTITY_READY)).toBe('ready')
    expect(identityState(IDENTITY_WAITING)).toBe('waiting')
    expect(identityState(IDENTITY_FAILED)).toBe('failed')
    expect(identityState({ ...IDENTITY_READY, status: 'DISABLED' })).toBe('disabled')
    expect(['SUCCESS', 'PENDING', 'NOT_STARTED', 'FAILED', 'TEMPORARY_FAILURE'].map((status) => recordStateOf(status as never))).toEqual(['found', 'waiting', 'waiting', 'failed', 'retrying'])
  })

  it('lists the three DKIM records with their state, then SPF, DMARC and the reply MX as not checked by Nexus', () => {
    const rows = dnsRows(IDENTITY_WAITING)
    expect(rows.map((row) => [row.type, row.purpose, row.state])).toEqual([
      ['CNAME', 'dkim', 'waiting'],
      ['CNAME', 'dkim', 'waiting'],
      ['CNAME', 'dkim', 'waiting'],
      ['TXT', 'spf', 'notChecked'],
      ['TXT', 'dmarc', 'notChecked'],
      ['MX', 'mx', 'notChecked'],
    ])
    expect(rows.slice(3).every((row) => row.value === null)).toBe(true)
    expect(rows[4]!.name).toBe(`_dmarc.${IDENTITY_WAITING.domain}`)
    expect(recordsText(IDENTITY_READY).split('\n')).toHaveLength(3)
    expect(recordsText(IDENTITY_READY)).toContain('CNAME\tabcd1234demo._domainkey.mail.officina-demo.example.com\tabcd1234demo.dkim.amazonses.com')
  })

  it('checks the add form as the API does, and says the address mail will leave from', () => {
    expect(draftProblems(emptyDraft())).toEqual({ companyId: 'mail.form.required', accountId: 'mail.form.noAccount', domain: 'mail.form.required' })
    expect(draftProblems({ ...emptyDraft('c', 'a'), domain: 'not a domain', localPart: 'no reply' })).toEqual({ domain: 'mail.form.domain', localPart: 'mail.form.localPart' })
    expect(draftProblems({ ...emptyDraft('c', 'a'), domain: 'Mail.Example.com.' })).toEqual({})
    expect(fromAddressOf({ ...emptyDraft('c', 'a'), domain: 'Mail.Example.com.', localPart: 'Orders' })).toBe('orders@mail.example.com')
    expect(fromAddressOf({ ...emptyDraft('c', 'a'), domain: 'x' })).toBeNull()
  })
})

interface Call {
  method: string
  url: string
  headers: Headers
  body: unknown
}

function mockApi(answers: Array<{ status: number; body: unknown }>): { api: ApiClient; calls: Call[] } {
  const calls: Call[] = []
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ method: String(init.method), url, headers: new Headers(init.headers), body: init.body ? JSON.parse(String(init.body)) : undefined })
    const next = answers.shift() ?? { status: 500, body: { error: { code: 'internal_error', message: 'no answer left' } } }
    return new Response(JSON.stringify(next.body), { status: next.status, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof globalThis.fetch
  return { api: createApiClient({ baseUrl: '/api', fetch, company: 'DEMO', csrfToken: () => 'csrf-demo' }), calls }
}

describe('the Connections calls (platform/admin/connections, platform/email-out)', () => {
  it('lists the accounts with the company header, a provider when asked', async () => {
    const { api, calls } = mockApi([{ status: 200, body: { accounts: ACCOUNTS } }, { status: 200, body: { accounts: [] } }])
    expect((await listAccounts(api)).map((account) => account.code)).toEqual(['mail', 'files', 'sdi-demo', 'sendcloud-demo', 'vies'])
    await listAccounts(api, { provider: 'SDI' })
    expect(calls.map((call) => call.url)).toEqual(['/api/integrations/accounts', '/api/integrations/accounts?provider=SDI'])
    expect(calls[0]!.headers.get('x-factory-company')).toBe('DEMO')
  })

  it('B-W2b-24: an account of the virus scanner or error tracking parses (the list never fails on it)', async () => {
    const tracking = { ...SCANNER, id: '00000000-0000-7000-8000-0000000000e7', provider: 'ERROR_TRACKING', code: 'errors', label: 'Error tracking (fake)' }
    const { api } = mockApi([{ status: 200, body: { accounts: [...ACCOUNTS, SCANNER, tracking] } }])
    expect((await listAccounts(api)).map((account) => account.provider).slice(-2)).toEqual(['CLAMAV', 'ERROR_TRACKING'])
  })

  it('pages the call ledger and asks only the failures when told', async () => {
    const { api, calls } = mockApi([{ status: 200, body: { calls: CALLS, nextBefore: CALLS[5]!.id } }])
    const answer = await listCalls(api, ACCOUNTS[3]!.id, { failed: true, before: CALLS[0]!.id })
    expect(answer.nextBefore).toBe(CALLS[5]!.id)
    expect(calls[0]!.url).toBe(`/api/integrations/accounts/${ACCOUNTS[3]!.id}/calls?failed=true&before=${CALLS[0]!.id}&limit=50`)
  })

  it('pauses with the version read, the reason, the CSRF token and an Idempotency-Key; resume goes to its own route', async () => {
    const paused = { ...ACCOUNTS[3]!, status: 'PAUSED', version: 3 }
    const { api, calls } = mockApi([{ status: 200, body: { account: paused } }, { status: 200, body: { account: ACCOUNTS[3] } }])
    expect((await setPaused(api, ACCOUNTS[3]!.id, true, { version: 2, reason: 'Carrier maintenance' })).status).toBe('PAUSED')
    expect(calls[0]).toMatchObject({ method: 'POST', url: `/api/integrations/accounts/${ACCOUNTS[3]!.id}/pause`, body: { version: 2, reason: 'Carrier maintenance' } })
    expect(calls[0]!.headers.get('x-csrf-token')).toBe('csrf-demo')
    expect(calls[0]!.headers.get('idempotency-key')).toMatch(/^[0-9a-f-]{36}$/)
    await setPaused(api, ACCOUNTS[3]!.id, false, { version: 3 })
    expect(calls[1]).toMatchObject({ url: `/api/integrations/accounts/${ACCOUNTS[3]!.id}/resume`, body: { version: 3 } })
  })

  it('a check the API holds for a fresh code runs once more after the code, and only then', async () => {
    const stepUp = { status: 403, body: { error: { code: 'forbidden', message: 'Step-up required.', issues: [{ path: 'stepUp', message: 'fresh code' }] } } }
    const { api, calls } = mockApi([stepUp, { status: 200, body: { identity: IDENTITY_READY } }])
    let asked = 0
    const identity = await runWithStepUp(
      () => checkIdentity(api, IDENTITY_WAITING.id),
      async () => {
        asked += 1
        expect(calls).toHaveLength(1)
      },
    )
    expect(asked).toBe(1)
    expect(identity.ready).toBe(true)
    expect(calls.map((call) => [call.method, call.url])).toEqual([
      ['POST', `/api/email/identities/${IDENTITY_WAITING.id}/check`],
      ['POST', `/api/email/identities/${IDENTITY_WAITING.id}/check`],
    ])
  })

  it('an answer that does not match its shape is a contract error, never half-read', async () => {
    const { api } = mockApi([{ status: 200, body: { accounts: [{ id: 'x', provider: 'FAX' }] } }])
    const error = await listAccounts(api).catch((caught: unknown) => caught)
    expect(isApiError(error) && error.kind).toBe('contract')
  })
})

// ---- the words ----

const SRC = fileURLToPath(new URL('.', import.meta.url))
const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sources(path)
    return /\.tsx?$/.test(entry.name) && !entry.name.includes('.vitest.test.') && entry.name !== 'fixtures.ts' ? [path] : []
  })
const own = (locale: (typeof LOCALES)[number]) => CATALOGUE[locale]['admin-connections'] ?? {}
const has = (key: string) => LOCALES.every((locale) => key in own(locale) || (`${key}_one` in own(locale) && `${key}_other` in own(locale)))

describe('every Connections string exists in it and en', () => {
  it('every key the code names, literally or built from an enum, exists', () => {
    const literal = new Set<string>()
    for (const file of sources(SRC)) for (const match of readFileSync(file, 'utf8').matchAll(/['"`]((?:conn|mail)\.[A-Za-z0-9_.]*[A-Za-z0-9_])['"`]/g)) if (!match[1]!.endsWith('example.com')) literal.add(match[1]!)
    const built = [
      ...INTEGRATION_PROVIDERS.flatMap((provider) => ['name', 'for', 'how'].map((part) => `conn.provider.${provider}.${part}`)),
      ...INTEGRATION_MODES.flatMap((mode) => [`conn.mode.${mode}`, `conn.modeHint.${mode}`]),
      'conn.modeBanner.SANDBOX',
      'conn.modeBanner.FAKE',
      ...['working', 'failing', 'notCalled', 'paused', 'disabled'].map((state) => `conn.state.${state}`),
      ...CONNECTION_TILES.flatMap((tile) => [`conn.tile.${tile}`, `conn.tileHint.${tile}`]),
      ...LATER_SERVICES.map((service) => `conn.laterService.${service}`),
      ...['overview', 'settings', 'calls', 'inbound', 'activity'].map((tab) => `conn.tab.${tab}`),
      ...['pause', 'resume'].flatMap((verb) => ['action', 'title', 'go', 'body', 'undo'].map((part) => `conn.${verb}.${part}`)),
      ...KNOWN_REASONS.map((reason) => `conn.reason.${reason}`),
      ...KNOWN_SETTINGS.map((setting) => `conn.setting.${setting}`),
      ...CALL_STATUSES.map((status) => `conn.callState.${status}`),
      ...INBOUND_STATUSES.map((status) => `conn.inboundState.${status}`),
      ...IDENTITY_KINDS.flatMap((kind) => [`mail.kind.${kind}`, `mail.kindHint.${kind}`]),
      ...DISPLAY_NAME_POLICIES.flatMap((policy) => [`mail.policy.${policy}`, `mail.policyHint.${policy}`]),
      ...['ready', 'waiting', 'failed', 'disabled'].flatMap((state) => [`mail.state.${state}`, `mail.done.checked.${state}`]),
      ...['found', 'waiting', 'failed', 'retrying', 'notChecked'].map((state) => `mail.record.${state}`),
      ...['dkim', 'spf', 'dmarc', 'mx'].map((purpose) => `mail.purpose.${purpose}`),
      ...['required', 'noAccount', 'domain', 'localPart'].map((problem) => `mail.form.${problem}`),
      ...['pause', 'resume'].flatMap((verb) => [`conn.bulk.${verb}Title`, `conn.bulk.${verb}Go`, `conn.bulk.${verb}Body`, `conn.bulk.${verb}Undo`]),
      ...['paused', 'resumed'].flatMap((verb) => ['Done', 'Partial', 'Failed'].map((part) => `conn.bulk.${verb}${part}`)),
      ...['notConnected', 'paused', 'running'].map((why) => `conn.bulk.left.${why}`),
    ]
    const keys = [...literal, ...built].filter((key) => !/\.$/.test(key))
    expect(keys.length).toBeGreaterThan(180)
    expect(keys.filter((key) => !has(key))).toEqual([])
  })
})

/** A key left on screen; a domain such as mail.officina-demo.example.com is not one (it goes on with a hyphen or a dot). */
const LEFT_KEY = /(?<![\w.@-])(?:conn|mail|common|list|problem|record|stepUp|held|form)\.[a-zA-Z]+(?:\.[a-zA-Z_]+)*(?![\w.-])/

function render(screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(View, { model })))
}
const CONNECTIONS = connectionsScreen as unknown as DesignScreen<unknown>
const MAIL = mailScreen as unknown as DesignScreen<unknown>
const SCREENS = [CONNECTIONS, MAIL]
const draw = (screen: DesignScreen<unknown>, id: string, locale: (typeof LOCALES)[number] = 'en') => render(screen, screen.cases.find((item) => item.id === id)!.model, locale)

describe('every Connections design case draws in both languages with no key left on screen', () => {
  it('the screens are SCR-087 and SCR-015, with every state', () => {
    expect(SCREENS.map((screen) => screen.screen).sort()).toEqual(['SCR-015', 'SCR-087'])
    for (const screen of SCREENS) {
      const ids = screen.cases.map((item) => item.id).join(' ')
      expect(ids, screen.screen).toMatch(/loading/)
      expect(ids, screen.screen).toMatch(/error/)
    }
    expect(connectionsScreen.cases.map((item) => item.id)).toEqual(expect.arrayContaining(['empty', 'viewer', 'connect', 'pause-confirm', 'record-not-found', 'record-dock', 'record-calls-empty', 'record-inbound-empty']))
    expect(mailScreen.cases.map((item) => item.id)).toEqual(expect.arrayContaining(['none', 'add', 'step-up', 'no-manage', 'checking', 'failed', 'waiting', 'verified']))
  })

  for (const screen of SCREENS) {
    for (const locale of LOCALES) {
      it(`${screen.screen} in ${locale}: ${screen.cases.length} cases`, () => {
        for (const item of screen.cases) {
          const html = render(screen, item.model, locale)
          expect(html.length, item.id).toBeGreaterThan(500)
          expect(html.match(LEFT_KEY)?.[0] ?? null, `${screen.screen}/${item.id} (${locale})`).toBeNull()
        }
      })
    }
  }

  it('says test mode on top when a service is fake or test, and not when every one is live', () => {
    expect(draw(CONNECTIONS, 'services')).toContain('Test mode: 4 services do not reach anyone')
    expect(draw(CONNECTIONS, 'live-only')).not.toContain('Test mode:')
  })

  it('connecting a service opens the catalogue (a dialog: drawn in the browser); its Continue is held in words', () => {
    expect(draw(CONNECTIONS, 'services')).toContain('Connect a service')
    for (const locale of LOCALES) expect(own(locale)['conn.connect.held']).toMatch(/Nexus/)
  })

  it('the services list is the list frame: the count and the keys in the footer icon, never a key hint above it', () => {
    const html = draw(CONNECTIONS, 'services')
    expect(html).toContain('7 services')
    expect(html).toContain('aria-label="Keyboard keys of this list"')
    expect(html).toContain('placeholder="Search services"')
  })

  it('selected services: Pause and Resume say their reach; the result notice names each refused service with the reason', () => {
    const selected = draw(CONNECTIONS, 'services-selected')
    expect(selected).toContain('4 selected')
    expect(selected).toContain('Pause 2')
    expect(selected).toContain('Resume 1')
    const after = draw(CONNECTIONS, 'paused-many').replace(/<!-- -->/g, '')
    expect(after).toContain('1 of 2 services paused. Not paused:')
    expect(after).toContain('Carrier Officina Demo (test): You may not do this here.')
    expect(draw(CONNECTIONS, 'services-selected', 'it')).toContain('Sospendi 2')
  })

  it('secrets are write-only: saved or not, when — never a value', () => {
    expect(Object.keys(ACCOUNTS[3]!.credentials).sort()).toEqual(['rotatedAt', 'saved', 'savedAt'])
    const html = draw(CONNECTIONS, 'record-settings')
    expect(html).toContain('sealed, never shown')
    expect(html).toMatch(/aria-description="Not available yet: replacing a key/)
    expect(html).not.toMatch(/ciphertext|wrappedKey|secretKey|publicKey|password/i)
    expect(draw(CONNECTIONS, 'record-settings-none')).toContain('Not saved')
  })

  it('a reader sees pause held with the right it needs; Test is held with its reason', () => {
    const html = draw(CONNECTIONS, 'record-viewer')
    expect(html).toContain('Needs the right: Pause and resume outside services')
    expect(html).toContain('the service’s adapter has no harmless test call (ping) yet')
  })

  it('the mail domain: DKIM with Copy, SPF/DMARC/MX not checked, Check held without email.manage', () => {
    const html = draw(MAIL, 'waiting')
    expect(html).toContain('id="mail"')
    expect(html.match(/Not checked by Nexus yet/g)?.length).toBe(3)
    expect(html).toContain('abcd1234demo._domainkey.notify.officina-demo.example.com')
    expect(draw(MAIL, 'no-manage')).toContain('Needs the right: Manage the companies’ sending addresses')
    expect(draw(MAIL, 'none')).toContain('Connect e-mail first: everything that leaves the factory needs it.')
  })

  it('the cells: a "Not connected" row for the company without SDI or a carrier; a failing service says the error as data', () => {
    const cell = (node: ReturnType<typeof createElement>) => renderToString(createElement(I18nProvider, { locale: 'en', messages: messagesFor('en', ['shell']) }, createElement(ConnectionsMessages, null, node)))
    const rows = serviceRows(ACCOUNTS, CHOICES, null, '', words)
    const missing = rows.filter((row) => row.kind === 'missing')
    expect(missing).toHaveLength(2)
    for (const row of missing) expect(cell(createElement(ServiceCell, { row, prefix: '/w/DEMO' }))).toContain('Not connected')
    const carrier = rows.find((row) => row.kind === 'account' && row.account.provider === 'SENDCLOUD')!
    expect(cell(createElement(ServiceCell, { row: carrier, prefix: '/w/DEMO' }))).toContain(`href="/w/DEMO/admin/connections/${ACCOUNTS[3]!.id}"`)
    const state = cell(createElement(StateCell, { row: carrier, now: ACCOUNTS[3]!.lastErrorAt! }))
    expect(state).toContain('Failing since')
    expect(state).toContain('HTTP 503 from the test system')
    const calls = cell(createElement(CallsCell, { account: ACCOUNTS[3]! }))
    expect(calls).toContain('4 failed')
    expect(calls).toContain('title="9 calls in 24 h"')
  })

  it('Italian words on the Italian screen', () => {
    expect(draw(CONNECTIONS, 'services', 'it')).toContain('Modalità di prova')
    expect(draw(MAIL, 'waiting', 'it')).toContain('Non ancora controllato da Nexus')
  })
})

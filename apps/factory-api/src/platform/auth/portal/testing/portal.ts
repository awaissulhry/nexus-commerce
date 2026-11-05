import { createHash } from 'node:crypto'
import type { FactoryClient } from '@nexus/factory-db'
import { newId } from '@nexus/factory-domain/core/ids'
import { textOf } from '../../../../adapters/ses/fake'
import { createAbuseGuard, useAbuseGuard, type AbuseGuard } from '../../../abuse/guard'
import { memoryAbuseStore } from '../../../abuse/store'
import { CSRF_HEADER } from '../../sessions/cookies'
import { Browser, type Answer, type Harness, type TestTenant } from '../../sessions/testing/harness'

/**
 * Test helpers for the portal sign-in's PostgreSQL tests (never imported by a route): a made-up partner organisation of
 * a harness tenant with its portal switched on, the company's portal terms published, a partner person with a PARTNER
 * role, the codes and links read from the FAKE mailbox, and a fresh in-memory abuse guard on the harness clock.
 */

export const TERMS = { it: 'ESEMPIO - termini del portale per i test.', en: 'SAMPLE - portal terms for the tests.' } as const
const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

export interface PortalWorld {
  readonly tenant: TestTenant
  readonly companyId: string
  readonly partyId: string
  readonly roleId: string
  readonly noticeId: string
}

/** A fresh abuse guard (memory store, the harness clock) for the app's routes. */
export function freshGuard(h: Harness): AbuseGuard {
  const guard = createAbuseGuard({ store: memoryAbuseStore(() => h.clock.now().getTime()), key: Buffer.alloc(32, 9), prefix: 'test', clock: h.clock })
  useAbuseGuard(guard)
  return guard
}

const office =
  (h: Harness, tenant: TestTenant) =>
  <T>(work: (client: FactoryClient) => Promise<T>): Promise<T> =>
    h.database.withScope({ audience: 'office', tenantId: tenant.id, actorId: newId() }, work)

/** The portal of a made-up customer of the tenant's first company: switched on, the terms published, a buyer role. */
export async function portalWorld(h: Harness, tenant: TestTenant, options: { readonly terms?: boolean; readonly portalOn?: boolean } = {}): Promise<PortalWorld> {
  const companyId = tenant.companies[0]!.id
  const partyId = newId()
  const roleId = newId()
  const noticeId = newId()
  const now = h.clock.now()
  await office(h, tenant)(async (client) => {
    await client.party.create({ data: { id: partyId, code: `P${partyId.slice(-6)}`, kind: 'ORGANISATION', legalName: 'Brand Alpha S.p.A.', tradeName: 'Brand Alpha', roles: ['CUSTOMER'] }, select: { id: true } })
    await client.portalSettings.create({ data: { id: partyId, partyId, portalOn: options.portalOn ?? true }, select: { id: true } })
    await client.role.create({ data: { id: roleId, key: `customer-buyer-${partyId.slice(-6)}`, name: 'Buyer', audience: 'PARTNER', permissions: ['portal.orders.view'], grains: ['price'] }, select: { id: true } })
    if (options.terms ?? true) {
      const existing = await client.privacyNotice.findFirst({ where: { companyId, kind: 'PORTAL_TERMS', status: 'PUBLISHED' }, select: { id: true } })
      if (!existing) {
        await client.privacyNotice.create({ data: { id: noticeId, companyId, kind: 'PORTAL_TERMS', versionNo: 1, label: '2026-11', createdAt: now, updatedAt: now }, select: { id: true } })
        for (const [locale, body] of Object.entries(TERMS)) {
          await client.privacyNoticeText.create({ data: { id: newId(), noticeId, locale, body, sha256: sha256(body), createdAt: now, updatedAt: now }, select: { id: true } })
        }
        await client.privacyNotice.update({ where: { id: noticeId }, data: { status: 'PUBLISHED', publishedAt: now, publishedById: newId(), version: 2, updatedAt: now }, select: { id: true } })
      }
    }
  })
  const notice = await office(h, tenant)((client) => client.privacyNotice.findFirst({ where: { companyId, kind: 'PORTAL_TERMS', status: 'PUBLISHED' }, select: { id: true } }))
  return { tenant, companyId, partyId, roleId, noticeId: notice?.id ?? noticeId }
}

export interface PartnerOptions {
  readonly status?: 'ACTIVE' | 'INVITED' | 'SUSPENDED'
  readonly accessUntil?: Date | null
  readonly role?: boolean
}

/** A partner person of the world's party (no password: C3), with its buyer role unless `role: false`. */
export async function addPartner(h: Harness, world: PortalWorld, email: string, options: PartnerOptions = {}): Promise<string> {
  const id = newId()
  await office(h, world.tenant)(async (client) => {
    await client.user.create({
      data: { id, email, displayName: email.split('@')[0]!, status: options.status ?? 'ACTIVE', audience: 'PARTNER', partyId: world.partyId, partnerKind: 'CUSTOMER', accessUntil: options.accessUntil ?? null },
      select: { id: true },
    })
    if (options.role ?? true) {
      await client.roleAssignment.create({ data: { id: newId(), userId: id, roleId: world.roleId, allCompanies: true, partyIds: [world.partyId], validFrom: new Date(h.clock.now().getTime() - 60_000) }, select: { id: true } })
    }
  })
  return id
}

/** Writes in the world's tenant (office scope). */
export const inWorld = <T>(h: Harness, world: PortalWorld, work: (client: FactoryClient) => Promise<T>): Promise<T> => office(h, world.tenant)(work)

export interface MailedCode {
  readonly code: string
  readonly link: string
  /** The link's token (its fragment). */
  readonly token: string
  readonly raw: string
  readonly subject: string
}

/** The newest portal mail of a template to an address, with its code (and link). */
export function mailedCode(h: Harness, to: string, template: 'auth.portal_sign_in' | 'auth.portal_step_up' = 'auth.portal_sign_in'): MailedCode | undefined {
  const mail = h.ses.mails.filter((entry) => entry.templateKey === template && entry.to[0] === to).at(-1)
  if (!mail) return undefined
  const text = textOf(mail.raw)
  const code = /\n\n(\d{6})\n\n/.exec(text)?.[1]
  const link = /https?:\/\/\S+#token=\S+/.exec(text)?.[0] ?? ''
  if (!code) throw new Error(`no code in the portal mail to ${to}`)
  const subject = /^Subject: (.*)$/m.exec(mail.raw)?.[1] ?? ''
  return { code, link, token: link ? decodeURIComponent(link.split('#token=')[1] ?? '') : '', raw: mail.raw, subject }
}

/** How many portal mails of a template went to an address. */
export const mailCount = (h: Harness, to: string, template = 'auth.portal_sign_in'): number => h.ses.mails.filter((entry) => entry.templateKey === template && entry.to[0] === to).length

/** A browser that comes from its own network (the abuse guard counts per network): the harness Browser with an address. */
export class NetworkBrowser extends Browser {
  constructor(
    app: Browser['app'],
    readonly remoteAddress: string,
  ) {
    super(app)
  }

  override async send(method: 'GET' | 'POST', url: string, body?: unknown, options: { csrf?: boolean; headers?: Record<string, string> } = {}): Promise<Answer> {
    const headers: Record<string, string> = { ...options.headers }
    if (this.cookies.size > 0) headers.cookie = [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ')
    if (method !== 'GET' && options.csrf !== false && this.csrfToken) headers[CSRF_HEADER] = this.csrfToken
    const response = await this.app.inject({ method, url, headers, remoteAddress: this.remoteAddress, ...(body === undefined ? {} : { payload: body as object }) })
    for (const cookie of response.cookies as { name: string; value: string; maxAge?: number }[]) {
      if (cookie.maxAge === 0 || cookie.value === '') this.cookies.delete(cookie.name)
      else this.cookies.set(cookie.name, cookie.value)
    }
    let parsed: unknown
    try {
      parsed = response.json()
    } catch {
      parsed = response.body
    }
    return { status: response.statusCode, body: parsed, response }
  }
}

/** A browser with a CSRF token (optionally from its own network). */
export async function portalBrowser(h: Harness, remoteAddress?: string): Promise<Browser> {
  const browser = remoteAddress ? new NetworkBrowser(h.app, remoteAddress) : new Browser(h.app)
  await browser.get('/auth/csrf')
  return browser
}

/** Asks for a sign-in e-mail and waits for the work after the answer. */
export async function askCode(h: Harness, browser: Browser, tenant: string, email: string): Promise<number> {
  const answer = await browser.post('/portal/signin/start', { tenant, email })
  await h.auth.settled()
  return answer.status
}

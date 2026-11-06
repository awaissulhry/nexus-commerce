import { describe, expect, it } from 'vitest'
import { partnerGrants, portalAccessProblem, portalAccessWords } from './access'
import { matchesPortalCode, newPortalCode, normalizePortalCode, PORTAL_CODE, PORTAL_CODE_WORDS, portalCodeHash, portalCodeState, portalTriesLeft } from './codes'
import { composePortalMail, PORTAL_MAIL_TEMPLATES } from './mail'
import { PORTAL_SESSION, portalAbsoluteExpiryAt, portalIdleExpiryAt, portalStepUpUntil } from './session'
import { matchesPortalToken, mintPortalToken, parsePortalToken, portalTokenHash } from './token'

const TENANT = '0190a0b0-0000-7000-8000-000000000001'
const PARTY = '0190a0b0-0000-7000-8000-000000000002'
const USER = '0190a0b0-0000-7000-8000-000000000003'
const COMPANY = '0190a0b0-0000-7000-8000-000000000004'
const SESSION = '0190a0b0-0000-7000-8000-000000000005'
const KEY = Buffer.alloc(32, 7)
const NOW = new Date('2026-11-04T10:00:00.000Z')

describe('portal codes (PLT-050, C3)', () => {
  it('makes six digits, uniform, padded', () => {
    expect(newPortalCode(() => 42)).toBe('000042')
    expect(newPortalCode(() => 999_999)).toBe('999999')
    expect(() => newPortalCode(() => 1_000_000)).toThrow()
    expect(newPortalCode()).toMatch(/^\d{6}$/)
  })

  it('reads a typed or pasted code, nothing else', () => {
    expect(normalizePortalCode('123 456')).toBe('123456')
    expect(normalizePortalCode('123-456')).toBe('123456')
    expect(normalizePortalCode('12345')).toBeNull()
    expect(normalizePortalCode('12345a')).toBeNull()
    expect(normalizePortalCode(123456)).toBeNull()
  })

  it('stores an HMAC bound to the purpose, the person and the company or session — never digits only', () => {
    const binding = { purpose: 'SIGN_IN' as const, tenantId: TENANT, userId: USER, boundTo: COMPANY }
    const hash = portalCodeHash(KEY, binding, '123456')
    expect(hash).toMatch(/^pc1\.[0-9a-f]{64}$/)
    expect(hash).not.toContain('123456')
    expect(matchesPortalCode(KEY, binding, '123456', hash)).toBe(true)
    expect(matchesPortalCode(KEY, binding, '123457', hash)).toBe(false)
    // Another company's portal, another session, another purpose, another key: nothing matches.
    expect(matchesPortalCode(KEY, { ...binding, boundTo: SESSION }, '123456', hash)).toBe(false)
    expect(matchesPortalCode(KEY, { ...binding, purpose: 'STEP_UP' }, '123456', hash)).toBe(false)
    expect(matchesPortalCode(Buffer.alloc(32, 8), binding, '123456', hash)).toBe(false)
    expect(matchesPortalCode(KEY, binding, null, hash)).toBe(false)
    expect(matchesPortalCode(KEY, binding, '123456', 'not-a-hash')).toBe(false)
  })

  it('knows a live code from a used, replaced, tried-out or expired one', () => {
    const live = { usedAt: null, revokedAt: null, tries: 4, expiresAt: new Date(NOW.getTime() + 1) }
    expect(portalCodeState(live, NOW)).toBe('live')
    expect(portalCodeState({ ...live, usedAt: NOW }, NOW)).toBe('used')
    expect(portalCodeState({ ...live, revokedAt: NOW }, NOW)).toBe('revoked')
    expect(portalCodeState({ ...live, tries: 5 }, NOW)).toBe('tried_out')
    expect(portalCodeState({ ...live, expiresAt: NOW }, NOW)).toBe('expired')
    expect(portalTriesLeft(1)).toBe(4)
    expect(portalTriesLeft(7)).toBe(0)
    expect(PORTAL_CODE_WORDS.wrong(4)).toBe('That code does not match. 4 tries left.')
    expect(PORTAL_CODE_WORDS.wrong(1)).toBe('That code does not match. 1 try left.')
    expect(PORTAL_CODE).toMatchObject({ ttlMs: 15 * 60_000, maxTries: 5 })
  })
})

describe('portal tokens', () => {
  it('names the tenant, the party or company and the person; only a hash is stored', () => {
    const session = mintPortalToken('session', { tenantId: TENANT, scopeId: PARTY, userId: USER })
    expect(session.value.startsWith(`ps1.${TENANT}.${PARTY}.${USER}.`)).toBe(true)
    expect(parsePortalToken('session', session.value)).toEqual(session)
    expect(parsePortalToken('link', session.value)).toBeNull()
    const link = mintPortalToken('link', { tenantId: TENANT, scopeId: COMPANY, userId: USER })
    expect(parsePortalToken('link', link.value)?.scopeId).toBe(COMPANY)
    expect(portalTokenHash(link.value)).toMatch(/^[0-9a-f]{64}$/)
    expect(matchesPortalToken(link, portalTokenHash(link.value))).toBe(true)
    expect(matchesPortalToken(link, portalTokenHash(session.value))).toBe(false)
    expect(parsePortalToken('session', `${session.value}x`)).toBeNull()
    expect(parsePortalToken('session', session.value.replace(PARTY, 'not-a-uuid-at-all-not-a-uuid-at-all1'))).toBeNull()
    expect(() => mintPortalToken('session', { tenantId: 'x', scopeId: PARTY, userId: USER })).toThrow()
  })
})

describe('partner sessions (A1 §3.10: 30 minutes idle, 12 hours)', () => {
  it('slides the idle end, never past the absolute end; a step-up holds 5 minutes', () => {
    const absolute = portalAbsoluteExpiryAt(NOW)
    expect(absolute.getTime() - NOW.getTime()).toBe(12 * 60 * 60_000)
    expect(portalIdleExpiryAt(NOW, absolute).getTime() - NOW.getTime()).toBe(PORTAL_SESSION.idleMs)
    const late = new Date(absolute.getTime() - 60_000)
    expect(portalIdleExpiryAt(late, absolute)).toEqual(absolute)
    expect(portalStepUpUntil(null, NOW)).toBeNull()
    expect(portalStepUpUntil(NOW, NOW)?.getTime()).toBe(NOW.getTime() + 5 * 60_000)
    expect(portalStepUpUntil(NOW, new Date(NOW.getTime() + 5 * 60_000))).toBeNull()
  })
})

describe('portal access after the code (design portal.signin access-paused; GATE-PRIVACY)', () => {
  const ok = { user: { status: 'ACTIVE', accessUntil: null }, party: { status: 'ACTIVE' }, portalOn: true, termsInForce: true }

  it('opens for an active person of an active organisation with the portal on and the terms published', () => {
    expect(portalAccessProblem(ok, NOW)).toBeNull()
    expect(portalAccessProblem({ ...ok, user: { status: 'INVITED', accessUntil: null }, invitationOpen: true }, NOW)).toBeNull()
  })

  it('says what is wrong, in this order', () => {
    expect(portalAccessProblem({ ...ok, user: { status: 'SUSPENDED', accessUntil: null } }, NOW)).toBe('PAUSED')
    expect(portalAccessProblem({ ...ok, party: { status: 'BLOCKED' } }, NOW)).toBe('PAUSED')
    expect(portalAccessProblem({ ...ok, party: { status: 'ARCHIVED' } }, NOW)).toBe('PAUSED')
    expect(portalAccessProblem({ ...ok, user: { status: 'INVITED', accessUntil: null } }, NOW)).toBe('INVITATION_ENDED')
    expect(portalAccessProblem({ ...ok, user: { status: 'ACTIVE', accessUntil: NOW } }, NOW)).toBe('ENDED')
    expect(portalAccessProblem({ ...ok, portalOn: false }, NOW)).toBe('PORTAL_OFF')
    expect(portalAccessProblem({ ...ok, termsInForce: false }, NOW)).toBe('TERMS_NOT_PUBLISHED')
    expect(portalAccessProblem({ ...ok, portalOn: false, user: { status: 'SUSPENDED', accessUntil: null } }, NOW)).toBe('PAUSED')
  })

  it('words each refusal with whom to contact', () => {
    const input = { company: 'Seed Factory', contact: 'Seed Factory (orders@seed.example)', accessUntil: '30/10/2026' }
    expect(portalAccessWords('PAUSED', input)).toBe('Your access to the Seed Factory portal is paused. Contact Seed Factory (orders@seed.example).')
    expect(portalAccessWords('ENDED', input)).toContain('ended on 30/10/2026')
    expect(portalAccessWords('TERMS_NOT_PUBLISHED', input)).toContain('portal terms are not published')
    expect(portalAccessWords('PORTAL_OFF', input)).toContain('not switched on')
    expect(portalAccessWords('INVITATION_ENDED', input)).toContain('Ask Seed Factory')
  })
})

describe('partner grants (price at most, own party, the session company)', () => {
  const place = { companyId: COMPANY, partyId: PARTY }
  const roles = [
    { permissions: ['portal.orders.view', 'money.cost'], grains: ['price', 'cost', 'margin', 'wages'], allCompanies: true, companyIds: [] },
    { permissions: ['portal.other.view'], grains: [], allCompanies: false, companyIds: ['0190a0b0-0000-7000-8000-0000000000ff'] },
  ]

  it('gives nothing before the terms are acknowledged, nor to a preview', () => {
    expect(partnerGrants(roles, place, { termsAcknowledged: false })).toEqual([])
    expect(partnerGrants(roles, place, { termsAcknowledged: true, preview: true })).toEqual([])
  })

  it('keeps the roles that reach the company, over the party only, with price at most', () => {
    const grants = partnerGrants(roles, place, { termsAcknowledged: true })
    expect(grants).toHaveLength(1)
    expect(grants[0]).toEqual({ permissions: ['money.price', 'portal.orders.view'], companies: [COMPANY], sites: 'all', parties: [PARTY] })
  })
})

describe('portal mails', () => {
  const context = { locale: 'en' as const, company: { legalName: 'Seed Factory S.r.l.', tradeName: 'Seed Factory', address: null, vatNumber: null, fiscalCode: null, reaOffice: null, reaNumber: null, shareCapital: null, soleShareholder: null, inLiquidation: null, currency: 'EUR', pec: null, documentFooter: null } as never, privacyUrl: 'https://factory.example/privacy/x' }

  it('puts the code and the link in the body, never in the subject', () => {
    const mail = composePortalMail({ template: PORTAL_MAIL_TEMPLATES.sign_in, recipientName: 'Anna', portalName: 'Seed Factory', code: '048213', link: 'https://factory.example/p/signin/continue#token=abc', expiresAt: NOW }, context)
    expect(mail.subject).toBe('Sign in to the Seed Factory portal')
    expect(mail.subject).not.toContain('048213')
    expect(mail.text).toContain('048213')
    expect(mail.text).toContain('https://factory.example/p/signin/continue#token=abc')
    expect(mail.text).toContain('15 minutes')
    expect(mail.html).toContain('048213')
    const it = composePortalMail({ template: PORTAL_MAIL_TEMPLATES.step_up, recipientName: 'Anna', portalName: 'Seed Factory', code: '048213', expiresAt: NOW }, { ...context, locale: 'it' })
    expect(it.subject).not.toContain('048213')
    expect(it.text).toContain('048213')
    expect(() => composePortalMail({ template: PORTAL_MAIL_TEMPLATES.step_up, recipientName: 'A', portalName: 'S', code: '12345', expiresAt: NOW }, context)).toThrow()
    expect(() => composePortalMail({ template: PORTAL_MAIL_TEMPLATES.sign_in, recipientName: 'A', portalName: 'S', code: '123456', link: 'javascript:alert(1)', expiresAt: NOW }, context)).toThrow()
  })
})

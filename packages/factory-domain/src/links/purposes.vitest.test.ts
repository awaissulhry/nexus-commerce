import { describe, expect, it } from 'vitest'
import { heldGrains } from '../auth/grains/grains'
import { FACTORY_PERMISSIONS } from '../auth/permissions/catalogue'
import { ROLE_TEMPLATES } from '../auth/roles/templates'
import { ValidationError } from '../core/errors'
import { can, holds, type Actor } from '../core/permissions'
import { LINK_SESSION_PERMISSIONS, LINKS_MANAGE, LINKS_VIEW } from './permissions'
import {
  answersOf,
  isLinkLive,
  LINK_PURPOSES,
  linkGrants,
  linkPermissions,
  linkState,
  linkTerms,
  PURPOSE_RULES,
  type LinkPurpose,
} from './purposes'

const TENANT = '0195f5d0-0000-7000-8000-0000000000f1'
const COMPANY = '0195f5d0-0000-7000-8000-0000000000c1'
const OTHER_COMPANY = '0195f5d0-0000-7000-8000-0000000000c2'
const PARTY = '0195f5d0-0000-7000-8000-0000000000d1'
const OTHER_PARTY = '0195f5d0-0000-7000-8000-0000000000d2'
const LINK = '0195f5d0-0000-7000-8000-0000000000e1'

const linkActor = (purpose: LinkPurpose): Actor => ({
  audience: 'link',
  tenantId: TENANT,
  partyId: PARTY,
  grants: linkGrants(purpose, { companyId: COMPANY, partyId: PARTY }),
})

describe('the purposes', () => {
  it('give QUOTE_ACCEPT its open, accept and decline, and the price grain (its own quote)', () => {
    expect(linkPermissions('QUOTE_ACCEPT')).toEqual(['links.accept', 'links.decline', 'links.open', 'money.price'])
    expect(answersOf('QUOTE_ACCEPT')).toEqual(['accept', 'decline'])
    expect(PURPOSE_RULES.QUOTE_ACCEPT.actions.accept).toEqual({ counts: true, typedName: 'required', checksEmail: true })
  })

  it('give PO_CONFIRM no grain at all: the supplier never sees a price on the link', () => {
    expect(linkPermissions('PO_CONFIRM')).toEqual(['links.confirm', 'links.decline', 'links.open'])
    expect(heldGrains(linkActor('PO_CONFIRM'))).toEqual(new Set())
    expect(heldGrains(linkActor('QUOTE_ACCEPT'))).toEqual(new Set(['price']))
  })

  it('never give cost, margin or wages, and price only to purposes that show the party its own document', () => {
    for (const purpose of LINK_PURPOSES) {
      const grains = PURPOSE_RULES[purpose].grains
      expect(grains.every((grain) => grain === 'price'), purpose).toBe(true)
      expect(linkPermissions(purpose).filter((permission) => permission.startsWith('money.'))).toEqual(grains.map((grain) => `money.${grain}`))
    }
    expect(LINK_PURPOSES.filter((purpose) => PURPOSE_RULES[purpose].grains.includes('price'))).toEqual(['QUOTE_ACCEPT', 'DOCUMENT_VIEW', 'DEPOSIT_INFO'])
  })

  it('declare every permission they give, as link-session permissions no role can hold', () => {
    for (const purpose of LINK_PURPOSES) {
      for (const permission of linkPermissions(purpose)) expect(FACTORY_PERMISSIONS.isDeclared(permission), permission).toBe(true)
    }
    for (const name of LINK_SESSION_PERMISSIONS) {
      expect(FACTORY_PERMISSIONS.get(name)?.link).toBe(true)
      expect(FACTORY_PERMISSIONS.assignable.map((definition) => definition.name)).not.toContain(name)
    }
    for (const template of ROLE_TEMPLATES) {
      for (const name of LINK_SESSION_PERMISSIONS) expect(template.permissions, template.key).not.toContain(name)
    }
    expect(FACTORY_PERMISSIONS.get(LINKS_MANAGE)?.link).toBeUndefined()
    expect(ROLE_TEMPLATES.find((template) => template.key === 'owner')?.permissions).toEqual(expect.arrayContaining([LINKS_VIEW, LINKS_MANAGE]))
    expect(ROLE_TEMPLATES.find((template) => template.key === 'read_only')?.permissions).toContain(LINKS_VIEW)
    expect(ROLE_TEMPLATES.find((template) => template.key === 'read_only')?.permissions).not.toContain(LINKS_MANAGE)
  })

  it('let only DOCUMENT_VIEW read files (its record\'s, shared with its party\'s links): a stored file or a shipment', () => {
    expect(linkPermissions('DOCUMENT_VIEW')).toEqual(['files.read', 'links.open', 'money.price'])
    expect(PURPOSE_RULES.DOCUMENT_VIEW.recordTypes).toEqual(['StoredFile', 'Shipment'])
    for (const purpose of LINK_PURPOSES.filter((name) => name !== 'DOCUMENT_VIEW')) expect(linkPermissions(purpose), purpose).not.toContain('files.read')
  })

  it('count the answers of the answer purposes and every open of the view purposes', () => {
    expect(PURPOSE_RULES.QUOTE_ACCEPT.actions.open?.counts).toBe(false)
    expect(PURPOSE_RULES.PO_CONFIRM.actions.confirm?.counts).toBe(true)
    expect(PURPOSE_RULES.DOCUMENT_VIEW.actions.open?.counts).toBe(true)
    expect(answersOf('DOCUMENT_VIEW')).toEqual([])
    expect(PURPOSE_RULES.QUOTE_ACCEPT.uses).toEqual({ default: 1, max: 1 })
  })
})

describe('linkGrants', () => {
  it('reach the link\'s company and party only', () => {
    const actor = linkActor('QUOTE_ACCEPT')
    expect(holds(actor, 'links.open')).toBe(true)
    expect(can(actor, 'links.accept', { companyId: COMPANY, partyId: PARTY })).toBe(true)
    expect(can(actor, 'links.accept', { companyId: OTHER_COMPANY, partyId: PARTY })).toBe(false)
    expect(can(actor, 'links.accept', { companyId: COMPANY, partyId: OTHER_PARTY })).toBe(false)
    expect(can(actor, 'links.confirm', { companyId: COMPANY, partyId: PARTY })).toBe(false)
    expect(can(actor, 'audit.read', { companyId: COMPANY, partyId: PARTY })).toBe(false)
  })

  it('give nothing for an unknown purpose or a malformed scope', () => {
    expect(linkGrants('NOPE' as LinkPurpose, { companyId: COMPANY, partyId: PARTY })).toEqual([])
    expect(linkGrants('QUOTE_ACCEPT', { companyId: 'x', partyId: PARTY })).toEqual([])
  })
})

describe('linkTerms', () => {
  const now = new Date('2026-10-28T09:00:00.000Z')

  it('takes the purpose defaults', () => {
    expect(linkTerms('QUOTE_ACCEPT', {}, now)).toEqual({ expiresAt: new Date('2026-11-27T09:00:00.000Z'), maxUses: 1 })
    expect(linkTerms('PO_CONFIRM', {}, now)).toEqual({ expiresAt: new Date('2026-11-11T09:00:00.000Z'), maxUses: 1 })
    expect(linkTerms('DOCUMENT_VIEW', { expiresInDays: 365, maxUses: 100 }, now).maxUses).toBe(100)
  })

  it('refuses terms beyond the purpose, naming each field', () => {
    expect(() => linkTerms('QUOTE_ACCEPT', { maxUses: 2 }, now)).toThrow(ValidationError)
    try {
      linkTerms('QUOTE_ACCEPT', { expiresInDays: 91, maxUses: 0 }, now)
    } catch (error) {
      expect((error as ValidationError).issues?.map((issue) => issue.path)).toEqual(['expiresInDays', 'maxUses'])
    }
    expect(() => linkTerms('DEPOSIT_INFO', { expiresInDays: 1.5 }, now)).toThrow(ValidationError)
  })
})

describe('linkState', () => {
  const now = new Date('2026-10-28T09:00:00.000Z')
  const live = { id: LINK, expiresAt: new Date('2026-10-29T09:00:00.000Z'), revokedAt: null, uses: 0, maxUses: 1 }

  it('is LIVE before expiry with uses left, and only then', () => {
    expect(linkState(live, now)).toBe('LIVE')
    expect(isLinkLive(live, now)).toBe(true)
    expect(linkState({ ...live, expiresAt: now }, now)).toBe('EXPIRED')
    expect(linkState({ ...live, uses: 1 }, now)).toBe('USED_UP')
    expect(linkState({ ...live, uses: 1, revokedAt: now, expiresAt: now }, now)).toBe('REVOKED')
    expect(isLinkLive({ ...live, uses: 1 }, now)).toBe(false)
  })
})

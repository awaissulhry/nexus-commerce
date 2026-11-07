import { describe, expect, it } from 'vitest'
import { FACTORY_PERMISSIONS } from '../permissions/catalogue'
import { roleProblems } from '../roles/roles'
import { PARTNER_ROLE_TEMPLATES, partnerTemplateOf, ROLE_TEMPLATES, SYSTEM_ROLE_TEMPLATES, systemTemplateOf, templateOf } from '../roles/templates'
import { partnerRoleTemplates, partnerTemplateProblems } from '../roles/partner-templates'
import { kindFits, partnerKindsOf } from './kinds'
import { composePartnerMail } from './mail'
import { accessEndsSoon, allowedRoleKeysProblems, choiceProblems, holdsSeat, offeredTemplates, previewPermissions, roleKeysOf, seatProblem, splitRoleKeys } from './rules'

const NOW = new Date('2026-11-07T09:00:00.000Z')
const DAY = 24 * 60 * 60_000
const keysOf = (kind: string | null) => PARTNER_ROLE_TEMPLATES.filter((template) => template.kind === kind).map((template) => template.key)

describe('the partner role templates (SAL-060, SCM-092, PLT-021)', () => {
  it('are the roles of the design per kind, plus the three capabilities, and valid', () => {
    expect(partnerTemplateProblems(PARTNER_ROLE_TEMPLATES)).toEqual([])
    expect(keysOf('CUSTOMER')).toEqual(['customer-buyer', 'customer-finance', 'customer-quality', 'customer-designer', 'customer-viewer', 'customer-admin'])
    expect(keysOf('SUPPLIER')).toEqual(['supplier-orders', 'supplier-invoices', 'supplier-quality', 'supplier-admin'])
    expect(keysOf('SUBCONTRACTOR')).toEqual(['subcontractor-jobs', 'subcontractor-admin'])
    expect(keysOf('GUEST')).toEqual(['guest-accountant'])
    expect(keysOf(null)).toEqual(['partner-comment', 'partner-upload', 'partner-approve'])
  })

  it('see prices only as a customer Buyer, Finance or Admin (and the adviser); never cost, margin or pay; a supplier never (C2)', () => {
    const pricing = PARTNER_ROLE_TEMPLATES.filter((template) => template.grains.length > 0).map((template) => template.key)
    expect(pricing).toEqual(['customer-buyer', 'customer-finance', 'customer-admin', 'guest-accountant'])
    expect(PARTNER_ROLE_TEMPLATES.every((template) => template.grains.every((grain) => grain === 'price'))).toBe(true)
    expect(PARTNER_ROLE_TEMPLATES.every((template) => !template.requireMfa)).toBe(true)
  })

  it('hold only partner permissions and the reads shared with the party; an admin holds its kind and manages colleagues', () => {
    for (const template of PARTNER_ROLE_TEMPLATES) {
      for (const permission of template.permissions) expect(FACTORY_PERMISSIONS.get(permission)?.partner === true || permission === 'files.read' || permission === 'threads.read').toBe(true)
    }
    expect(partnerTemplateOf('customer-admin')?.permissions).toContain('portal.colleagues.manage')
    expect(partnerTemplateOf('customer-buyer')?.permissions).not.toContain('portal.colleagues.manage')
    expect(partnerTemplateOf('guest-accountant')?.permissions).toEqual(['files.read', 'portal.home.view', 'portal.search', 'threads.read'])
    expect(partnerTemplateOf('partner-approve')?.permissions).toEqual(['portal.approve'])
  })

  it('take a later step\'s permissions, and the kind\'s admin follows them by itself', () => {
    const later = partnerRoleTemplates([{ 'supplier-orders': ['portal.comment'] }])
    expect(later.find((template) => template.key === 'supplier-orders')?.permissions).toContain('portal.comment')
    expect(later.find((template) => template.key === 'supplier-admin')?.permissions).toContain('portal.comment')
    expect(later.find((template) => template.key === 'supplier-quality')?.permissions).not.toContain('portal.comment')
  })

  it('find a partner role that holds an office permission, a cost, two-factor or a price on a supplier portal', () => {
    const base = partnerTemplateOf('supplier-orders')!
    expect(partnerTemplateProblems([{ ...base, permissions: ['quotes.view'] }])).toEqual(['supplier-orders: a partner role holds only partner permissions, not quotes.view'])
    expect(partnerTemplateProblems([{ ...base, grains: ['cost'] }])).toContain('supplier-orders: a partner role sees at most the price, not cost')
    expect(partnerTemplateProblems([{ ...base, grains: ['price'] }])).toEqual(["supplier-orders: no price on a supplier's or workshop's portal (Owner answer C2)"])
    expect(partnerTemplateProblems([{ ...base, requireMfa: true }])).toEqual(['supplier-orders: a partner role cannot require two-factor (a portal session steps up by e-mail code)'])
  })

  it('are system roles beside the office and floor ones; no office or floor template holds a portal permission', () => {
    expect(SYSTEM_ROLE_TEMPLATES).toHaveLength(ROLE_TEMPLATES.length + PARTNER_ROLE_TEMPLATES.length)
    expect(systemTemplateOf('customer-buyer')?.audience).toBe('partner')
    expect(templateOf('customer-buyer')).toBeUndefined()
    expect(FACTORY_PERMISSIONS.assignable.some((definition) => definition.partner === true)).toBe(false)
    expect(FACTORY_PERMISSIONS.partnerAssignable.map((definition) => definition.name)).toEqual(['portal.colleagues.view', 'portal.colleagues.manage', 'portal.comment', 'portal.upload', 'portal.approve', 'portal.home.view', 'portal.salesOrders.view', 'portal.purchaseOrders.view', 'portal.search'])
    expect(ROLE_TEMPLATES.some((template) => template.permissions.some((name) => name.startsWith('portal.')))).toBe(false)
    for (const key of ['admin', 'sales', 'buyer', 'owner']) expect(templateOf(key)?.permissions).toEqual(expect.arrayContaining(['partners.view', 'partners.invite', 'partners.manage', 'partners.preview']))
    expect(templateOf('read_only')?.permissions).toContain('partners.view')
    expect(templateOf('read_only')?.permissions).not.toContain('partners.preview')
    expect(roleProblems({ name: 'Copy', requireMfa: false, permissions: ['portal.comment'], grains: [] })).toEqual([{ path: 'permissions/0', message: 'portal.comment is held only by partner roles (a portal\'s people).' }])
  })
})

describe('kinds, choices and limits (PLT-006, PLT-021, PLT-022)', () => {
  it('fit a kind to the party\'s roles', () => {
    expect(partnerKindsOf(['BRAND', 'SUPPLIER'])).toEqual(['CUSTOMER', 'SUPPLIER'])
    expect(partnerKindsOf(['CARRIER'])).toEqual([])
    expect(kindFits('GUEST', ['CONSULTANT'])).toBe(true)
    expect(kindFits('SUBCONTRACTOR', ['SUPPLIER'])).toBe(false)
  })

  it('keep a choice within the kind, the allowed roles and the capabilities; an adviser always has an end', () => {
    const limits = { maxUsers: null, allowedRoleKeys: [] }
    expect(choiceProblems({ kind: 'CUSTOMER', roleKey: 'customer-buyer', capabilities: ['comment', 'approve'], accessUntil: null }, limits, NOW)).toEqual([])
    expect(choiceProblems({ kind: 'CUSTOMER', roleKey: 'supplier-orders', capabilities: [], accessUntil: null }, limits, NOW)[0]).toMatchObject({ path: 'roleKey' })
    expect(choiceProblems({ kind: 'CUSTOMER', roleKey: 'customer-buyer', capabilities: [], accessUntil: null }, { maxUsers: null, allowedRoleKeys: ['customer-viewer'] }, NOW)).toEqual([{ path: 'roleKey', message: "This organisation's portal offers only: Viewer." }])
    expect(choiceProblems({ kind: 'CUSTOMER', roleKey: 'customer-viewer', capabilities: ['approve'], accessUntil: null }, limits, NOW)).toEqual([{ path: 'capabilities/0', message: 'A Viewer cannot approve or sign.' }])
    expect(choiceProblems({ kind: 'GUEST', roleKey: 'guest-accountant', capabilities: [], accessUntil: null }, limits, NOW)).toEqual([{ path: 'accessUntil', message: "An adviser's access always ends: give the date." }])
    expect(choiceProblems({ kind: 'GUEST', roleKey: 'guest-accountant', capabilities: [], accessUntil: new Date(NOW.getTime() - 1) }, limits, NOW)).toEqual([{ path: 'accessUntil', message: 'The end of access must be in the future.' }])
    expect(allowedRoleKeysProblems(['customer-buyer', 'partner-comment', 'customer-buyer']).map((issue) => issue.path)).toEqual(['allowedRoleKeys', 'allowedRoleKeys/1'])
    expect(offeredTemplates('SUPPLIER', ['supplier-orders', 'customer-buyer']).map((template) => template.key)).toEqual(['supplier-orders'])
  })

  it('store a choice as role keys and read it back', () => {
    const keys = roleKeysOf('customer-buyer', ['approve', 'comment'])
    expect(keys).toEqual(['customer-buyer', 'partner-comment', 'partner-approve'])
    expect(splitRoleKeys(keys)).toEqual({ roleKey: 'customer-buyer', capabilities: ['comment', 'approve'], unknown: [] })
    expect(splitRoleKeys(['partner-upload', 'custom.x'])).toEqual({ roleKey: null, capabilities: ['upload'], unknown: ['custom.x'] })
  })

  it('count seats over active, suspended and openly invited people, and say when none is left', () => {
    expect([holdsSeat({ status: 'ACTIVE', invitationOpen: false }), holdsSeat({ status: 'INVITED', invitationOpen: false }), holdsSeat({ status: 'INVITED', invitationOpen: true }), holdsSeat({ status: 'DEACTIVATED', invitationOpen: false })]).toEqual([true, false, true, false])
    expect(seatProblem({ maxUsers: null }, 50, 'Brand Alpha')).toBeNull()
    expect(seatProblem({ maxUsers: 3 }, 2, 'Brand Alpha')).toBeNull()
    expect(seatProblem({ maxUsers: 3 }, 3, 'Brand Alpha')).toBe('The portal of Brand Alpha holds at most 3 people, and 3 are invited or active. Deactivate someone first, or ask for more.')
  })

  it('say "access ends soon" within 7 days, not after it ended', () => {
    expect(accessEndsSoon(null, NOW)).toBe(false)
    expect(accessEndsSoon(new Date(NOW.getTime() + 7 * DAY), NOW)).toBe(true)
    expect(accessEndsSoon(new Date(NOW.getTime() + 8 * DAY), NOW)).toBe(false)
    expect(accessEndsSoon(new Date(NOW.getTime() - 1), NOW)).toBe(false)
  })

  it('let an office preview read what the party\'s people could read, never a write', () => {
    expect(previewPermissions(['CUSTOMER'])).toEqual(['files.read', 'portal.colleagues.view', 'portal.home.view', 'portal.salesOrders.view', 'portal.search', 'threads.read'])
    expect(previewPermissions(['GUEST'])).toEqual(['files.read', 'portal.home.view', 'portal.search', 'threads.read'])
    expect(previewPermissions([])).toEqual([])
  })
})

describe('the partner mails', () => {
  const context = { locale: 'en' as const, company: { legalName: 'Example S.r.l.', tradeName: 'Example', address: null, vatNumber: null, fiscalCode: null, reaOffice: null, reaNumber: null, shareCapital: null, soleShareholder: null, inLiquidation: null, currency: 'EUR', pec: null, documentFooter: null } as never, privacyUrl: 'https://factory.example/privacy/x' }

  it('invite with the sign-in page, the role and both ends, no secret', () => {
    const mail = composePartnerMail(
      { template: 'auth.portal_invitation', recipientName: 'Anna', portalName: 'Example', organisation: 'Brand Alpha', invitedBy: 'Marco (Example)', roleName: 'Buyer', link: 'https://factory.example/p/signin?tenant=t&company=C1', expiresAt: new Date(NOW.getTime() + 7 * DAY), accessUntil: new Date(NOW.getTime() + 30 * DAY) },
      context,
    )
    expect(mail.subject).toBe('Invitation to the Example portal')
    expect(mail.text).toContain('Marco (Example) invited you to the Example portal for Brand Alpha, as Buyer.')
    expect(mail.text).toContain('https://factory.example/p/signin?tenant=t&company=C1')
    expect(mail.text).toContain('Your access lasts until')
    expect(() => composePartnerMail({ template: 'auth.portal_invitation', recipientName: 'A', portalName: 'E', organisation: 'B', invitedBy: 'M', roleName: 'Buyer', link: 'javascript:alert(1)', expiresAt: NOW, accessUntil: null }, context)).toThrow(/http/)
  })

  it('tell an ending access in Italian', () => {
    const mail = composePartnerMail({ template: 'auth.portal_access_ending', recipientName: 'Anna', portalName: 'Esempio', accessUntil: new Date(NOW.getTime() + 3 * DAY), contact: 'Esempio (info@esempio.example)' }, { ...context, locale: 'it' as const })
    expect(mail.subject).toBe('Il tuo accesso al portale Esempio sta per finire')
    expect(mail.text).toContain('Se ti serve ancora, scrivi a Esempio (info@esempio.example).')
  })
})

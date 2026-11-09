import { describe, expect, it } from 'vitest'
import { FACTORY_PERMISSIONS } from '../auth/permissions/catalogue'
import { templateOf } from '../auth/roles/templates'
import { EVENT_CATALOGUE } from '../events/catalogue'
import { linkPermissions, PURPOSE_RULES } from '../links/purposes'
import { inviteMail, mayWords, newMessageMail, recordLabelOf, SHARE_MAIL_TEMPLATES } from './mail'
import { PARTNERS_SHARES_ADDS, PARTNERS_SHARES_PERMISSIONS } from './permissions'
import {
  authorNameOf,
  defaultShareEnd,
  latestShareEnd,
  NEVER_SHARED,
  postHeld,
  SHARE_FIELDS,
  SHARE_RECORD_TYPES,
  shareEndProblems,
  shareFieldKeys,
  sharePermissionsOf,
  shareStateOf,
  uploadHeld,
} from './rules'

const NOW = new Date('2026-11-09T09:00:00.000Z')
const DAY = 86_400_000

describe('inviting a partner to one record (B-W2b-200)', () => {
  it('keeps VIEW always and each permission once, in order', () => {
    expect(sharePermissionsOf([])).toEqual(['VIEW'])
    expect(sharePermissionsOf(['UPLOAD', 'COMMENT', 'UPLOAD'])).toEqual(['VIEW', 'COMMENT', 'UPLOAD'])
    expect(sharePermissionsOf(['UPLOAD', 'OWNER'])).toEqual(['VIEW', 'UPLOAD'])
  })

  it('ends a share between an hour and 180 days from now (30 by default), and says its state', () => {
    expect(defaultShareEnd(NOW).getTime() - NOW.getTime()).toBe(30 * DAY)
    expect(shareEndProblems(new Date(NOW.getTime() + 10 * 60_000), NOW).map((issue) => issue.path)).toEqual(['body/expiresAt'])
    expect(shareEndProblems(new Date(latestShareEnd(NOW).getTime() + 1), NOW)).toHaveLength(1)
    expect(shareEndProblems(latestShareEnd(NOW), NOW)).toEqual([])
    expect(shareEndProblems(new Date('nope'), NOW)).toHaveLength(1)
    expect(shareStateOf({ revokedAt: null, expiresAt: new Date(NOW.getTime() + 1) }, NOW)).toBe('LIVE')
    expect(shareStateOf({ revokedAt: null, expiresAt: NOW }, NOW)).toBe('EXPIRED')
    expect(shareStateOf({ revokedAt: NOW, expiresAt: new Date(NOW.getTime() + DAY) }, NOW)).toBe('REVOKED')
  })

  it('lets the invited person post with COMMENT on an open thread of its own party, and upload with UPLOAD', () => {
    const open = { threadStatus: 'OPEN' as const, sameParty: true }
    expect(postHeld({ permissions: ['VIEW'], ...open })).toBe('NO_COMMENT')
    expect(postHeld({ permissions: ['VIEW', 'COMMENT'], ...open })).toBeNull()
    expect(postHeld({ permissions: ['VIEW', 'COMMENT'], threadStatus: null, sameParty: true })).toBeNull()
    expect(postHeld({ permissions: ['VIEW', 'COMMENT'], threadStatus: 'CLOSED', sameParty: true })).toBe('CLOSED')
    expect(postHeld({ permissions: ['VIEW', 'COMMENT'], threadStatus: 'OPEN', sameParty: false })).toBe('OTHER_PARTY')
    expect(uploadHeld({ permissions: ['VIEW', 'COMMENT'] })).toBe('NO_UPLOAD')
    expect(uploadHeld({ permissions: ['VIEW', 'UPLOAD'] })).toBeNull()
    expect(authorNameOf({ contactName: ' Anna Rossi ', email: 'anna@studio.example' })).toBe('Anna Rossi')
    expect(authorNameOf({ contactName: null, email: 'anna@studio.example' })).toBe('anna@studio.example')
  })

  it('registers the shared fields of every record a RECORD_INVITE link opens, and never money, pay or an office person', () => {
    expect([...SHARE_RECORD_TYPES].sort()).toEqual(Object.keys(SHARE_FIELDS).sort())
    expect(SHARE_RECORD_TYPES).toEqual(PURPOSE_RULES.RECORD_INVITE.recordTypes)
    for (const type of SHARE_RECORD_TYPES) {
      const keys = shareFieldKeys(type)
      expect(keys.length, type).toBeGreaterThan(0)
      expect(new Set(keys).size, type).toBe(keys.length)
      for (const key of keys) expect(NEVER_SHARED.test(key), `${type}.${key}`).toBe(false)
    }
    expect(shareFieldKeys('PayrollExport')).toEqual([])
    // The link holds no money grain and only the purpose's own actions.
    expect(linkPermissions('RECORD_INVITE')).toEqual(['files.read', 'links.open', 'links.post', 'links.upload'])
  })

  it('declares its permissions, gives them to the inviting templates, and its events', () => {
    for (const name of PARTNERS_SHARES_PERMISSIONS) expect(FACTORY_PERMISSIONS.isDeclared(name), name).toBe(true)
    for (const [key, adds] of Object.entries(PARTNERS_SHARES_ADDS)) {
      const template = templateOf(key)
      expect(template, key).toBeDefined()
      for (const permission of adds) expect(template!.permissions, `${key} ${permission}`).toContain(permission)
    }
    expect(templateOf('operator')!.permissions).not.toContain('partners.shares.view')
    for (const type of ['record_share.invited', 'record_share.changed', 'record_share.revoked']) expect(EVENT_CATALOGUE.get(type, 1).type, type).toBe(type)
  })

  it('writes the invitation and the new-message mail in the reader\'s language, without money and with the link only in the invitation', () => {
    const facts = { companyName: 'Studio Alpha', inviterName: 'Anna Esempio', label: recordLabelOf('SalesOrder', 'SO-2026-0042', 'it'), permissions: ['VIEW', 'COMMENT', 'UPLOAD'] as const, expiresAt: new Date('2026-11-30T22:59:00Z'), note: 'Guardate i campioni.' }
    const it_ = inviteMail('it', { ...facts, permissions: [...facts.permissions] }, 'https://factory.example/l#token=t')
    expect(it_.subject).toBe('Studio Alpha vi invita: Ordine SO-2026-0042')
    expect(it_.body).toContain('Anna Esempio (Studio Alpha) vi ha aggiunto a Ordine SO-2026-0042.')
    expect(it_.body).toContain('leggere, scrivere messaggi e caricare file fino al 30 nov 2026')
    expect(it_.body).toContain('https://factory.example/l#token=t')
    const en = inviteMail('en', { ...facts, label: recordLabelOf('SalesOrder', 'SO-2026-0042', 'en'), permissions: ['VIEW'], note: null }, 'https://x/l#token=t')
    expect(en.body).toContain('you can read until 30 Nov 2026')
    expect(mayWords(['VIEW', 'UPLOAD'], 'en')).toBe('read and upload files')
    const message = newMessageMail('en', { companyName: 'Studio Alpha', label: 'Order SO-2026-0042', authorName: 'Anna Esempio', excerpt: 'The samples left today.' })
    expect(message.body).not.toContain('#token=')
    expect(message.body).toContain('Anna Esempio wrote on Order SO-2026-0042:')
    expect(SHARE_MAIL_TEMPLATES).toEqual({ invite: 'shares.invite', message: 'shares.message' })
    expect(recordLabelOf('Unknown', 'X-1', 'en')).toBe('X-1')
  })
})

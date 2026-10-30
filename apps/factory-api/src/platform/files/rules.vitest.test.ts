import { describe, expect, it } from 'vitest'
import { FileAudience, FileKind, FileStatus } from '@nexus/factory-db'
import { FACTORY_PERMISSIONS } from '@nexus/factory-domain/auth/permissions/catalogue'
import { ROLE_TEMPLATES } from '@nexus/factory-domain/auth/roles/templates'
import { canTransition } from '@nexus/factory-domain/state/machine'
import { manifest } from './manifest'
import {
  addYears,
  attachmentDisposition,
  audienceSees,
  cleanFileName,
  deleteBlockers,
  FILE_AUDIENCES,
  FILE_KINDS,
  FILE_STATUSES,
  fileMachine,
  isLegalKey,
  isStorageKey,
  KIND_RULES,
  MAX_FILE_BYTES,
  normaliseContentType,
  normaliseVisibility,
  retentionFor,
  sharingProblems,
  storageKeyFor,
  uploadProblems,
  type SeenFile,
} from './rules'

const SHA = 'a'.repeat(64)
const NOW = new Date('2026-10-28T10:00:00.000Z')
const TENANT = '0199f0a0-0000-7000-8000-000000000001'
const COMPANY = '0199f0a0-0000-7000-8000-000000000002'
const SITE = '0199f0a0-0000-7000-8000-000000000003'
const PARTY = '0199f0a0-0000-7000-8000-000000000004'
const RANDOM = '3b1f0c3e-8d1a-4c2b-9f3e-2a1b0c9d8e7f'

describe('the lists match the database enums', () => {
  it('kinds, statuses and audiences', () => {
    expect([...FILE_KINDS].sort()).toEqual(Object.values(FileKind).sort())
    expect([...FILE_STATUSES].sort()).toEqual(Object.values(FileStatus).sort())
    expect([...FILE_AUDIENCES].sort()).toEqual(Object.values(FileAudience).sort())
  })
})

describe('what each kind may hold', () => {
  it('accepts the kind\'s types up to its limit, and nothing a browser would run', () => {
    expect(uploadProblems({ kind: 'CERTIFICATE', contentType: 'application/pdf', sizeBytes: 1, sha256: SHA })).toEqual([])
    expect(uploadProblems({ kind: 'PHOTO', contentType: 'Image/JPEG; foo=bar', sizeBytes: 15 * 1_048_576, sha256: SHA })).toEqual([])
    expect(uploadProblems({ kind: 'FISCAL_ARCHIVE', contentType: 'application/xml', sizeBytes: 10, sha256: SHA })).toEqual([])
    for (const kind of FILE_KINDS) {
      for (const type of ['text/html', 'image/svg+xml', 'application/javascript', 'application/xhtml+xml', 'application/octet-stream']) {
        expect(uploadProblems({ kind, contentType: type, sizeBytes: 10, sha256: SHA }), `${kind} ${type}`).toEqual([{ path: 'body/contentType', message: expect.any(String) }])
      }
    }
    expect(uploadProblems({ kind: 'PHOTO', contentType: 'application/pdf', sizeBytes: 10, sha256: SHA })[0]?.path).toBe('body/contentType')
  })

  it('refuses an empty file, one over the limit and a bad checksum', () => {
    expect(uploadProblems({ kind: 'PHOTO', contentType: 'image/png', sizeBytes: 15 * 1_048_576 + 1, sha256: SHA })).toEqual([{ path: 'body/sizeBytes', message: 'A PHOTO file holds 1 byte to 15 MiB.' }])
    expect(uploadProblems({ kind: 'DOCUMENT', contentType: 'application/pdf', sizeBytes: 0, sha256: SHA })[0]?.path).toBe('body/sizeBytes')
    expect(uploadProblems({ kind: 'DOCUMENT', contentType: 'application/pdf', sizeBytes: 9, sha256: SHA.toUpperCase() })[0]?.path).toBe('body/sha256')
    expect(MAX_FILE_BYTES).toBe(Math.max(...FILE_KINDS.map((kind) => KIND_RULES[kind].maxBytes)))
  })

  it('normalises a content type', () => {
    expect(normaliseContentType(' Application/PDF ; charset=binary')).toBe('application/pdf')
  })
})

describe('names', () => {
  it('keeps the last path part without control characters, at most 200 characters', () => {
    expect(cleanFileName('C:\\Users\\someone\\Report 1.pdf')).toBe('Report 1.pdf')
    expect(cleanFileName('../../etc/passwd')).toBe('passwd')
    expect(cleanFileName('a\u0000b\nc.pdf')).toBe('abc.pdf')
    expect(cleanFileName('  spaced   name.pdf ')).toBe('spaced name.pdf')
    expect(cleanFileName('x'.repeat(300))).toHaveLength(200)
    for (const empty of ['', '/', '..', '  ', 'folder/']) expect(cleanFileName(empty), empty).toBeNull()
  })

  it('downloads as an attachment with an ASCII fallback and the UTF-8 name', () => {
    expect(attachmentDisposition('Scheda tecnica è "nuova".pdf')).toBe(
      `attachment; filename="Scheda tecnica _ _nuova_.pdf"; filename*=UTF-8''Scheda%20tecnica%20%C3%A8%20%22nuova%22.pdf`,
    )
  })
})

describe('sharing (COL-050)', () => {
  it('always includes the office, once each, in a fixed order', () => {
    expect(normaliseVisibility(undefined)).toEqual(['OFFICE'])
    expect(normaliseVisibility(['LINK', 'FLOOR', 'LINK'])).toEqual(['OFFICE', 'FLOOR', 'LINK'])
  })

  it('names a site exactly for the floor (with a company) and a party exactly for a portal or a link', () => {
    const base = { companyId: COMPANY, floorSiteId: null, partyId: null }
    expect(sharingProblems({ ...base, visibility: ['OFFICE'] })).toEqual([])
    expect(sharingProblems({ ...base, visibility: ['OFFICE', 'FLOOR'], floorSiteId: SITE })).toEqual([])
    expect(sharingProblems({ ...base, visibility: ['OFFICE', 'PARTNER', 'LINK'], partyId: PARTY })).toEqual([])
    expect(sharingProblems({ ...base, visibility: ['OFFICE', 'FLOOR'] }).map((issue) => issue.path)).toEqual(['body/floorSiteId'])
    expect(sharingProblems({ ...base, visibility: ['OFFICE'], floorSiteId: SITE }).map((issue) => issue.path)).toEqual(['body/floorSiteId'])
    expect(sharingProblems({ ...base, companyId: null, visibility: ['OFFICE', 'FLOOR'], floorSiteId: SITE }).map((issue) => issue.path)).toEqual(['body/companyId'])
    expect(sharingProblems({ ...base, visibility: ['OFFICE', 'LINK'] }).map((issue) => issue.path)).toEqual(['body/partyId'])
    expect(sharingProblems({ ...base, visibility: ['OFFICE'], partyId: PARTY }).map((issue) => issue.path)).toEqual(['body/partyId'])
  })

  const file = (fields: Partial<SeenFile>): SeenFile => ({ id: 'f', recordType: 'Quote', recordId: 'q', visibility: ['OFFICE'], floorSiteId: null, partyId: null, ...fields })
  it('shows each audience only what is shared with it', () => {
    const internal = file({})
    const floor = file({ visibility: ['OFFICE', 'FLOOR'], floorSiteId: SITE })
    const portal = file({ visibility: ['OFFICE', 'PARTNER'], partyId: PARTY })
    const link = file({ visibility: ['OFFICE', 'LINK'], partyId: PARTY })
    const linkViewer = { audience: 'link', partyId: PARTY, record: { type: 'Quote', id: 'q' } } as const
    for (const shared of [internal, floor, portal, link]) {
      expect(audienceSees({ audience: 'office' }, shared)).toBe(true)
      expect(audienceSees({ audience: 'platform' }, shared)).toBe(false)
    }
    expect(audienceSees({ audience: 'floor', siteId: SITE }, internal)).toBe(false)
    expect(audienceSees({ audience: 'floor', siteId: SITE }, floor)).toBe(true)
    expect(audienceSees({ audience: 'floor', siteId: PARTY }, floor)).toBe(false)
    expect(audienceSees({ audience: 'partner', partyId: PARTY }, portal)).toBe(true)
    expect(audienceSees({ audience: 'partner', partyId: SITE }, portal)).toBe(false)
    expect(audienceSees({ audience: 'partner', partyId: PARTY }, link)).toBe(false)
    expect(audienceSees(linkViewer, link)).toBe(true)
    expect(audienceSees({ ...linkViewer, record: { type: 'StoredFile', id: 'f' } }, link)).toBe(true)
    expect(audienceSees({ ...linkViewer, record: { type: 'Quote', id: 'other' } }, link)).toBe(false)
    expect(audienceSees(linkViewer, portal)).toBe(false)
  })
})

describe('retention (PLAN §2.8)', () => {
  it('keeps a fiscal archive file ten years at least, and other files as asked', () => {
    expect(retentionFor('FISCAL_ARCHIVE', null, NOW)).toEqual({ retainUntil: new Date('2036-10-28T10:00:00.000Z'), problems: [] })
    expect(retentionFor('FISCAL_ARCHIVE', new Date('2040-01-01T00:00:00Z'), NOW).retainUntil).toEqual(new Date('2040-01-01T00:00:00Z'))
    expect(retentionFor('FISCAL_ARCHIVE', new Date('2030-01-01T00:00:00Z'), NOW).problems[0]?.path).toBe('body/retainUntil')
    expect(retentionFor('DOCUMENT', null, NOW)).toEqual({ retainUntil: null, problems: [] })
    expect(retentionFor('DOCUMENT', NOW, NOW).problems[0]?.path).toBe('body/retainUntil')
    expect(addYears(new Date('2028-02-29T00:00:00Z'), 1)).toEqual(new Date('2029-03-01T00:00:00Z'))
  })

  it('a file goes only without legal hold and after its retention date (the machine\'s guard)', () => {
    const later = new Date('2030-01-01T00:00:00Z')
    expect(deleteBlockers({ legalHold: false, retainUntil: null }, NOW)).toEqual([])
    expect(deleteBlockers({ legalHold: true, retainUntil: later }, NOW)).toEqual(['the legal hold to be lifted', 'the retention period to end (2030-01-01T00:00:00.000Z)'])
    expect(canTransition(fileMachine, 'AVAILABLE', 'DELETED', { legalHold: false, retainUntil: later, now: NOW })).toMatchObject({ ok: false })
    expect(canTransition(fileMachine, 'AVAILABLE', 'DELETED', { legalHold: false, retainUntil: later, now: later })).toMatchObject({ ok: true })
    const free = { legalHold: false, retainUntil: null, now: NOW }
    expect(canTransition(fileMachine, 'DELETED', 'AVAILABLE', free)).toMatchObject({ ok: false })
    expect(canTransition(fileMachine, 'AVAILABLE', 'PENDING_UPLOAD', free)).toMatchObject({ ok: false })
    expect(canTransition(fileMachine, 'QUARANTINED', 'AVAILABLE', free)).toMatchObject({ ok: false })
    expect(canTransition(fileMachine, 'PENDING_UPLOAD', 'QUARANTINED', free)).toMatchObject({ ok: true })
  })
})

describe('storage keys (A1 §3.6)', () => {
  it('are tenant-prefixed and random, under legal/ for the fiscal archive', () => {
    const key = storageKeyFor({ tenantId: TENANT, companyId: COMPANY, kind: 'PHOTO', now: NOW, random: RANDOM })
    expect(key).toBe(`t/${TENANT}/c/${COMPANY}/2026/${RANDOM}`)
    expect(storageKeyFor({ tenantId: TENANT, companyId: null, kind: 'ATTACHMENT', now: NOW, random: RANDOM })).toBe(`t/${TENANT}/tenant/2026/${RANDOM}`)
    const legal = storageKeyFor({ tenantId: TENANT, companyId: COMPANY, kind: 'FISCAL_ARCHIVE', now: NOW, random: RANDOM })
    expect(legal).toBe(`legal/t/${TENANT}/c/${COMPANY}/2026/${RANDOM}`)
    expect([isStorageKey(key), isStorageKey(legal), isLegalKey(legal), isLegalKey(key)]).toEqual([true, true, true, false])
    for (const bad of [`${key}/../x`, `../${key}`, `/${key}`, `t/${TENANT}/c/${COMPANY}/2026/x`, `other/${key}`]) expect(isStorageKey(bad), bad).toBe(false)
  })
})

describe('the permissions (registry and role templates)', () => {
  it('declares every permission the routes name, none of them step-up', () => {
    const named = new Set(Object.values(manifest).map((entry) => entry.permission).filter((permission) => permission.startsWith('files.')))
    expect([...named].sort()).toEqual(['files.delete', 'files.manage', 'files.read', 'files.upload'])
    expect(FACTORY_PERMISSIONS.byArea().get('files')?.map(({ name, risk }) => [name, risk])).toEqual([
      ['files.read', 'read'],
      ['files.upload', 'write'],
      ['files.delete', 'write'],
      ['files.manage', 'write'],
    ])
  })

  it('gives every office template files.read, the record roles files.upload, admin and owner the rest', () => {
    const office = ROLE_TEMPLATES.filter((role) => role.audience === 'office')
    const files = Object.fromEntries(office.map((role) => [role.key, role.permissions.filter((permission) => permission.startsWith('files.'))]))
    expect(files).toEqual({
      owner: ['files.delete', 'files.manage', 'files.read', 'files.upload'],
      admin: ['files.delete', 'files.manage', 'files.read', 'files.upload'],
      finance: ['files.read', 'files.upload'],
      sales: ['files.read', 'files.upload'],
      planner: ['files.read', 'files.upload'],
      buyer: ['files.read', 'files.upload'],
      warehouse: ['files.read', 'files.upload'],
      production_manager: ['files.read', 'files.upload'],
      quality_inspector: ['files.read', 'files.upload'],
      floor_supervisor: ['files.read'],
      // B-W2a-35: the plant's technicians (photos and documents of machines, requests and jobs).
      maintenance: ['files.read', 'files.upload'],
      read_only: ['files.read'],
    })
  })
})

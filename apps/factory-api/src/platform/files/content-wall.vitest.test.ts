import { describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import type { CommandCaller } from '../../core/command'
import { systemContext } from '../outbox/system'
import { EVERY_PARTY_MARKER } from '../../modules/quality/wall'
import { contentOwnerOf, contentShownTo, outsidePartyOf, walledForOutside, type ContentOwner } from './content-wall'

/**
 * fix-wall-1 (the brand wall; W25 / T25): the pure part of the one rule for portal and link file reads — a reader of customer B
 * is shown a file only when every record of its content (the file's own, then each source's) is B's or of no customer.
 * The database part (an old copy of a mixed lot's photo on B's order) is content-wall.pg.vitest.test.ts.
 */

const B = newId()
const A = newId()
const own: ContentOwner = { kind: 'party', partyId: B }
const none: ContentOwner = { kind: 'party', partyId: null }

describe('contentShownTo: every record of the content is the reader’s or of no customer', () => {
  it('its own file, our own file, a copy of its own or of our own: shown', () => {
    expect(contentShownTo([own], B)).toBe(true)
    expect(contentShownTo([none], B)).toBe(true)
    expect(contentShownTo([own, own], B)).toBe(true)
    expect(contentShownTo([own, none, none], B)).toBe(true)
  })

  it('a copy of another customer’s, of a mixed lot (the every-party marker), of a gone record, at any hop: not shown', () => {
    expect(contentShownTo([own, { kind: 'party', partyId: A }], B)).toBe(false)
    expect(contentShownTo([own, { kind: 'party', partyId: EVERY_PARTY_MARKER }], B)).toBe(false)
    expect(contentShownTo([own, own, { kind: 'party', partyId: EVERY_PARTY_MARKER }], B)).toBe(false)
    expect(contentShownTo([own, { kind: 'unknown' }], B)).toBe(false)
    // A file on another customer's record (old data: shared with B before B-TH-003).
    expect(contentShownTo([{ kind: 'party', partyId: A }], B)).toBe(false)
    // Nothing read at all: fail closed.
    expect(contentShownTo([], B)).toBe(false)
  })
})

describe('contentOwnerOf: a record as the office’s file reads name it', () => {
  it('a record’s wall party (a mixed work order: the marker), a customer, none; unreadable: unknown', () => {
    expect(contentOwnerOf({ kind: 'record', recordType: 'SalesOrder', scope: { companyId: null, siteId: null, partyId: B } })).toEqual(own)
    expect(contentOwnerOf({ kind: 'record', recordType: 'WorkOrder', scope: { companyId: null, siteId: null, partyId: null, wallPartyId: EVERY_PARTY_MARKER } })).toEqual({ kind: 'party', partyId: EVERY_PARTY_MARKER })
    expect(contentOwnerOf({ kind: 'record', recordType: 'WorkOrder', scope: { companyId: null, siteId: null, partyId: null, wallPartyId: B } })).toEqual(own)
    expect(contentOwnerOf({ kind: 'record', recordType: 'Company', scope: { companyId: null, siteId: null, partyId: null } })).toEqual(none)
    expect(contentOwnerOf({ kind: 'customer', partyId: A })).toEqual({ kind: 'party', partyId: A })
    expect(contentOwnerOf({ kind: 'none' })).toEqual(none)
    expect(contentOwnerOf({ kind: 'unknown' })).toEqual({ kind: 'unknown' })
  })
})

describe('walledForOutside: only portal and link readers are walled', () => {
  const tenantId = newId()
  const ids = [newId(), newId()]
  const refusing = (context: CommandCaller['factoryContext']): CommandCaller => ({
    factoryContext: context,
    withClient: () => Promise.reject(new Error('no read is expected here')),
  })

  it('the office, the floor and the system: nothing walled, nothing read', async () => {
    expect(await walledForOutside(refusing({ audience: 'office', tenantId, actorId: newId(), grants: [], requestId: 'x' }), ids)).toEqual(new Set())
    expect(await walledForOutside(refusing({ audience: 'floor', tenantId, actorId: newId(), siteId: newId(), deviceId: newId(), grants: [], requestId: 'x' }), ids)).toEqual(new Set())
    expect(await walledForOutside(refusing(systemContext(tenantId, 'x')), ids)).toEqual(new Set())
    expect(outsidePartyOf({ audience: 'office', tenantId, actorId: newId(), grants: [], requestId: 'x' })).toBeNull()
  })

  it('a portal or a link caller that cannot be read as its tenant’s system (no request): every file walled (fail closed); no file: none', async () => {
    const partner = refusing({ audience: 'partner', tenantId, actorId: newId(), partyId: B, grants: [], requestId: 'x' })
    expect(await walledForOutside(partner, ids)).toEqual(new Set(ids))
    expect(await walledForOutside(partner, [])).toEqual(new Set())
    expect(outsidePartyOf({ audience: 'link', tenantId, linkId: newId(), partyId: B, record: { type: 'SalesOrder', id: newId() }, grants: [], requestId: 'x' })).toBe(B)
  })
})

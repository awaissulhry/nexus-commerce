import { describe, it, expect } from 'vitest'
import { cellHoverNote, crossChannelColumnCount, channelWriteGate } from './rows'
import type { StudioCellValue } from './types'
import { channelWriteIdentity } from './rows'
import { emptyLedger, ledgerPending, ledgerResolved, ledgerState, type SaveLedger } from '../../saveState'

const cell = (o: Partial<StudioCellValue>): StudioCellValue =>
  ({
    value: null, source: null, inheritedFrom: null, inherited: false, mapped: null,
    layer: 'default', pinned: false, follows: null, editable: true, linkGroupId: null,
    writeField: 'x', writeVerb: 'channel', writeTarget: 'channelListing',
    affectsAllChannels: false, writable: true, writeBlockedReason: null, ...o,
  }) as StudioCellValue

describe('cellHoverNote', () => {
  it('shows the server reason verbatim when there is one', () => {
    expect(cellHoverNote(cell({ writeBlockedReason: 'Parent rows take the axis value.' }), 'eBay · IT'))
      .toBe('Parent rows take the axis value.')
  })

  it('prefers the reason over the cross-market notice', () => {
    expect(cellHoverNote(cell({ writeBlockedReason: 'No listing here.', affectsAllChannels: true }), 'eBay · IT'))
      .toBe('No listing here.')
  })

  it('names the shared master record for a cross-channel cell', () => {
    expect(cellHoverNote(cell({ affectsAllChannels: true }), 'eBay · IT'))
      .toBe('Editing this on eBay · IT changes the shared master record — every channel sees it.')
  })

  // 🔴 The regression that matters: eBay's `name`/`description` are writeVerb 'master' but
  // writeTarget 'channelListing'. Keying the notice on the VERB would warn falsely here.
  it('stays silent for a master-verb cell that only writes its own listing', () => {
    expect(cellHoverNote(cell({ writeVerb: 'master', writeTarget: 'channelListing' }), 'eBay · IT')).toBeNull()
  })

  it('says nothing for a non-editable cell that gave no reason — an empty tooltip is not an answer', () => {
    expect(cellHoverNote(cell({ editable: false }), 'eBay · IT')).toBeNull()
  })

  it('returns null for a missing cell rather than inventing text', () => {
    expect(cellHoverNote(undefined, 'eBay · IT')).toBeNull()
  })
})

describe('crossChannelColumnCount', () => {
  it('counts only the cells that leave this channel', () => {
    expect(crossChannelColumnCount({ values: {
      a: cell({ affectsAllChannels: true }), b: cell({ affectsAllChannels: true }), c: cell({}),
    } })).toBe(2)
  })
  it('is 0 for a row with no values, so the caller omits the notice', () => {
    expect(crossChannelColumnCount(undefined)).toBe(0)
  })
})

describe('channelWriteGate — the reason now blocks (#513)', () => {
  const base = { colId: 'color', source: 'edit', selfInflicted: false, acknowledged: false }
  it('blocks a cell carrying a write-blocked reason', () => {
    expect(channelWriteGate({ ...base, cell: cell({ writeBlockedReason: 'Read-only on this alias.' }) })).toBe('blocked')
  })
  it('still blocks on writable: false if a server ever sends it', () => {
    expect(channelWriteGate({ ...base, cell: cell({ writable: false }) })).toBe('blocked')
  })
  it('still asks for acknowledgement on a cross-channel write', () => {
    expect(channelWriteGate({ ...base, cell: cell({ affectsAllChannels: true }) })).toBe('acknowledge')
  })
  it('writes an ordinary channel cell', () => {
    expect(channelWriteGate({ ...base, cell: cell({}) })).toBe('write')
  })
})

/**
 * #699 — the header's unsaved COUNT, driven through the real ledger with the identities this sheet
 * produces. The sheet's writer closure lives in a `.tsx` the node suite cannot import, so the
 * convention is tested where it is decided (`channelWriteIdentity`) and its consequence is tested
 * against `_studio/saveState`'s own reducer rather than a local imitation of it.
 */
describe('#699 — a refusal then a success on the SAME row leaves nothing unsaved', () => {
  const scope = { channel: 'EBAY', marketplace: 'IT', accountId: 'account-a', locale: 'it', instanceId: 'sheet-1' }
  const attempt = (l: SaveLedger, rowId: string, seq: number, ok: boolean): SaveLedger => {
    const { writeId, subject } = channelWriteIdentity(rowId, seq, scope)
    return ledgerResolved(ledgerPending(l, writeId, subject), writeId, ok, 1_700_000_000_000, subject)
  }

  it('clears the earlier failure when the retry lands', () => {
    const refused = attempt(emptyLedger, 'primary:p1', 1, false)
    expect(ledgerState(refused).kind).toBe('error')
    const saved = attempt(refused, 'primary:p1', 2, true)
    expect(saved.failed.size).toBe(0)
    expect(ledgerState(saved).kind).toBe('saved')
  })

  it('🔴 the CONTROL: with no subject the same sequence still reads as unsaved', () => {
    // This is the behaviour that shipped — every attempt its own failure, so a retry that SUCCEEDS
    // cannot clear the refusal it replaces. Without this case the test above would pass on the
    // broken code as easily as on the fixed one.
    const noSubject = (l: SaveLedger, rowId: string, seq: number, ok: boolean): SaveLedger => {
      const { writeId } = channelWriteIdentity(rowId, seq, scope)
      return ledgerResolved(ledgerPending(l, writeId), writeId, ok, 1_700_000_000_000)
    }
    const refused = noSubject(emptyLedger, 'primary:p1', 1, false)
    const saved = noSubject(refused, 'primary:p1', 2, true)
    expect(saved.failed.size).toBe(1)
    expect(ledgerState(saved).kind).toBe('error')
  })

  it('two DIFFERENT rows refused are two changes not saved, not one', () => {
    const a = attempt(emptyLedger, 'primary:p1', 1, false)
    const b = attempt(a, 'primary:p2', 2, false)
    expect(b.failed.size).toBe(2)
  })

  it('the write id is unique per attempt while the subject is stable', () => {
    const one = channelWriteIdentity('primary:p1', 1, scope)
    const two = channelWriteIdentity('primary:p1', 2, scope)
    expect(one.writeId).not.toBe(two.writeId)
    expect(one.subject).toBe(two.subject)
    expect(one.subject).not.toBe('primary:p1')
  })

  it.each([{ accountId: 'account-b' }, { channel: 'AMAZON' }, { marketplace: 'DE' }, { locale: 'en' }])('keeps identical variant IDs in different scopes independent: %j', async change => {
    const a = channelWriteIdentity('primary:p1', 1, scope)
    const b = channelWriteIdentity('primary:p1', 1, { ...scope, ...change })
    let ledger = ledgerPending(ledgerPending(emptyLedger, a.writeId, a.subject), b.writeId, b.subject)
    expect(ledger.inFlight.size).toBe(2)
    ledger = ledgerResolved(ledger, b.writeId, false, 1, b.subject)
    // A's delayed success must neither remove B's refusal nor masquerade as B's completion.
    await Promise.resolve()
    ledger = ledgerResolved(ledger, a.writeId, true, 2, a.subject)
    expect(ledger.inFlight.size).toBe(0)
    expect(ledger.failed).toEqual(new Set([b.subject]))
    const retry = channelWriteIdentity('primary:p1', 2, { ...scope, ...change })
    ledger = ledgerResolved(ledgerPending(ledger, retry.writeId, retry.subject), retry.writeId, true, 3, retry.subject)
    expect(ledger.failed.size).toBe(0)
  })

  it('does not reuse an in-flight ID when returning to the same account and row', () => {
    const original = channelWriteIdentity('primary:p1', 1, scope)
    const returned = channelWriteIdentity('primary:p1', 1, { ...scope, instanceId: 'sheet-2' })
    expect(returned.subject).toBe(original.subject)
    expect(returned.writeId).not.toBe(original.writeId)
    let ledger = ledgerPending(ledgerPending(emptyLedger, original.writeId, original.subject), returned.writeId, returned.subject)
    ledger = ledgerResolved(ledger, original.writeId, true, 1, original.subject)
    expect(ledger.inFlight).toEqual(new Set([returned.writeId]))
    expect(ledgerState(ledger)).toMatchObject({ kind: 'saving', pending: 1 })
  })
})

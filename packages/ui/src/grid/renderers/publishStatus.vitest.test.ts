import { describe, expect, it } from 'vitest'
import {
  CREATE_FIELD, NO_PUBLISH, PUBLICATION_STATUSES, PUBLISH_RESULT_STATUSES, publicationStatusMeta, publishCardModel, publishCellModel,
  publishFamilyMeta, publishFullTime, publishResultMeta, publishShortTime, publishShownStatus, type PublishStatusValue,
} from './publishStatus'

const last = (over: Partial<NonNullable<PublishStatusValue['last']>> = {}): NonNullable<PublishStatusValue['last']> => ({
  publicationId: 'pub_1', status: 'FAILED', at: '2026-10-01T10:04:00', userName: 'Dev Owner', message: 'Two attributes were refused.',
  reference: 'FEED-1', sentFields: ['Title', 'Bullet points'], issues: [], ...over,
})
const value = (over: Partial<PublishStatusValue> = {}): PublishStatusValue => ({ destinationLabel: 'Amazon · IT', last: last(), ...over })

describe('publication status vocabulary', () => {
  it('gives every publication status a label, a tone and a sentence', () => {
    for (const s of PUBLICATION_STATUSES) {
      const meta = publicationStatusMeta(s)
      expect(meta.label).not.toBe('')
      expect(meta.hint.endsWith('.')).toBe(true)
    }
    expect(publicationStatusMeta('PUBLISHING')).toMatchObject({ label: 'Sending', tone: 'info', terminal: false })
    expect(publicationStatusMeta('SUBMITTED')).toMatchObject({ label: 'Waiting for channel', tone: 'info', terminal: false })
    expect(publicationStatusMeta('PARTIAL')).toMatchObject({ label: 'Partly failed', tone: 'warning' })
    expect(publicationStatusMeta('FAILED')).toMatchObject({ label: 'Failed', tone: 'danger' })
    expect(publicationStatusMeta('NOT_SENT')).toMatchObject({ label: 'Not sent', tone: 'danger' })
    expect(publicationStatusMeta('UNVERIFIED')).toMatchObject({ label: 'Result unknown', tone: 'warning', terminal: false })
    expect(publicationStatusMeta('QUEUED')).toMatchObject({ label: 'Waiting its turn', tone: 'neutral', terminal: false })
    expect(publicationStatusMeta('CANCELLED')).toMatchObject({ label: 'Cancelled', tone: 'neutral', terminal: true })
  })

  it('keeps green for a read-back only: Accepted is not Verified', () => {
    expect(publicationStatusMeta('ACCEPTED')).toMatchObject({ label: 'Accepted', tone: 'info' })
    expect(publicationStatusMeta('VERIFIED')).toMatchObject({ label: 'Verified', tone: 'success' })
    const green = PUBLICATION_STATUSES.filter(s => publicationStatusMeta(s).tone === 'success')
    expect(green).toEqual(['VERIFIED'])
    expect(PUBLISH_RESULT_STATUSES.filter(s => publishResultMeta(s).tone === 'success')).toEqual(['VERIFIED'])
  })

  it('normalises case and shows an unknown status as itself, neutral, never as a known one', () => {
    expect(publicationStatusMeta(' verified ').label).toBe('Verified')
    expect(publicationStatusMeta('QUEUED_LATER')).toMatchObject({ label: 'QUEUED_LATER', tone: 'neutral' })
    expect(publicationStatusMeta('QUEUED_LATER').hint).toContain('Unrecognised')
    expect(publicationStatusMeta(null)).toBe(NO_PUBLISH)
    expect(publicationStatusMeta('  ')).toBe(NO_PUBLISH)
  })

  it('reads the per-SKU vocabulary, with the server SUBMITTED meaning Waiting', () => {
    expect(publishResultMeta('SUBMITTED').label).toBe('Waiting')
    expect(publishResultMeta('SKIPPED')).toMatchObject({ label: 'Skipped', tone: 'neutral' })
    expect(publishResultMeta('UNKNOWN')).toMatchObject({ label: 'Result unknown', tone: 'warning' })
    expect(publishResultMeta('FAILED').tone).toBe('danger')
  })
})

describe('Last publish cell', () => {
  const now = new Date(2026, 9, 1, 15, 0).getTime()

  it('distinguishes loading, a failed read and never published — three different things', () => {
    expect(publishCellModel(undefined, now).state).toBe('loading')
    const failed = publishCellModel(value({ readError: 'HTTP 500' }), now)
    expect(failed).toMatchObject({ state: 'error', title: 'Publish results could not be read.' })
    expect(failed.ariaLabel).toContain('could not be read')
    const never = publishCellModel(value({ last: null }), now)
    expect(never).toMatchObject({ state: 'never', title: 'Not published from Nexus yet.' })
  })

  it('names status, destination and time in the accessible name, and the time short in the cell', () => {
    const model = publishCellModel(value({ last: last({ at: new Date(2026, 9, 1, 12, 4).toISOString() }) }), now)
    expect(model.state).toBe('status')
    expect(model.meta.label).toBe('Failed')
    expect(model.shortTime).toBe('12:04')
    expect(model.ariaLabel).toMatch(/^Last publish: Failed, Amazon · IT, .+\. Press Enter for details\.$/)
  })

  it('shows the day instead of the time for an older publish', () => {
    expect(publishShortTime(new Date(2026, 8, 28, 9, 30).toISOString(), now)).toBe('28 Sep')
    expect(publishShortTime('not a date', now)).toBe('')
  })

  it('lets a publish in flight win over the last finished one, without a stale time', () => {
    const v = value({ inFlight: { status: 'SUBMITTED' } })
    expect(publishShownStatus(v).label).toBe('Waiting for channel')
    const model = publishCellModel(v, now)
    expect(model.shortTime).toBe('')
    expect(model.ariaLabel).toContain('Waiting for channel')
    expect(publishCellModel(value({ last: null, inFlight: { status: 'PUBLISHING' } }), now).meta.label).toBe('Sending')
  })

  it('says when the row was edited after the publish', () => {
    expect(publishCellModel(value({ editedSince: true }), now).ariaLabel).toContain('Edited since.')
  })
})

describe('Last publish card', () => {
  it('lists the facts, what was sent, the channel message and the reported problems', () => {
    const card = publishCardModel(value({
      last: last({ issues: [
        { severity: 'error', message: 'Value not allowed.', fieldLabel: 'Colour', columnKey: 'amazon:color' },
        { severity: 'warning', message: 'Recommended field empty.' },
      ] }),
    }))
    expect(card.title).toBe('Last publish · Amazon · IT')
    expect(card.facts.map(f => f.label)).toEqual(['When', 'By', 'Channel reference'])
    expect(card.sent).toEqual(['Title', 'Bullet points'])
    expect(card.sentSummary).toBe('2 fields sent.')
    expect(card.message).toBe('Two attributes were refused.')
    expect(card.issues.map(i => i.canGoTo)).toEqual([true, false])
    expect(card.publicationId).toBe('pub_1')
    expect(card.editedNote).toBeNull()
  })

  it('says a complete listing was created instead of listing every field', () => {
    const card = publishCardModel(value({ last: last({ status: 'ACCEPTED', sentFields: [CREATE_FIELD] }) }))
    expect(card.sent).toEqual(['Complete listing'])
    expect(card.sentSummary).toBe('A complete new listing was sent.')
  })

  it('never invents a user or a field list', () => {
    const card = publishCardModel(value({ last: last({ userName: null, reference: null, sentFields: [] }) }))
    expect(card.facts.find(f => f.label === 'By')?.value).toBe('Not recorded')
    expect(card.facts.some(f => f.label === 'Channel reference')).toBe(false)
    expect(card.sentSummary).toBe('No field list is recorded for this publish.')
  })

  it('shows this row’s own result only when it differs from the publication', () => {
    expect(publishCardModel(value({ last: last({ status: 'PARTIAL', outcome: 'ACCEPTED' }) })).rowResult?.label).toBe('Accepted')
    expect(publishCardModel(value({ last: last({ status: 'FAILED', outcome: 'FAILED' }) })).rowResult).toBeNull()
  })

  it('carries the in-flight publish and the edited-since note', () => {
    const card = publishCardModel(value({ inFlight: { status: 'PUBLISHING' }, editedSince: true }))
    expect(card.inFlight?.label).toBe('Sending')
    expect(card.editedNote).toContain('Publish again')
  })
})

describe('review fixes (2026-10-02)', () => {
  const now = new Date(2026, 9, 1, 15, 0).getTime()

  it('marks only Verified with the check glyph, at both levels, so it never depends on the blue shade alone', () => {
    expect(PUBLICATION_STATUSES.filter(s => publicationStatusMeta(s).glyph === 'check')).toEqual(['VERIFIED'])
    expect(PUBLISH_RESULT_STATUSES.filter(s => publishResultMeta(s).glyph === 'check')).toEqual(['VERIFIED'])
    expect(publicationStatusMeta('ACCEPTED').glyph).toBeUndefined()
  })

  it('uses one time shape: the cell short time and the card time agree', () => {
    const at = new Date(2026, 8, 29, 9, 5).toISOString()
    expect(publishShortTime(at, now)).toBe('29 Sep')
    expect(publishFullTime(at, now)).toBe('29 Sep, 09:05')
    expect(publishShortTime(new Date(2025, 9, 1, 9, 5).toISOString(), now)).toBe('1 Oct 2025')
    expect(publishFullTime(new Date(2025, 9, 1, 9, 5).toISOString(), now)).toBe('1 Oct 2025, 09:05')
    const when = publishCardModel(value({ last: last({ at }) }), now).facts.find(f => f.label === 'When')?.value
    expect(when?.startsWith('29 Sep, 09:05 · ')).toBe(true)
    expect(publishCellModel(value({ last: last({ at }) }), now).ariaLabel).toContain(', 29 Sep, 09:05.')
  })

  it('does not tell the reader inside the card to open the details', () => {
    for (const s of PUBLICATION_STATUSES) {
      const card = publishCardModel(value({ last: last({ status: s }) }), now)
      expect(card.hint).not.toContain('Open the details')
      expect(card.hint.endsWith('.')).toBe(true)
    }
    expect(publicationStatusMeta('FAILED').hint).toContain('Open the details')
  })

  it('shows an unparseable time as itself rather than inventing one', () => {
    expect(publishCardModel(value({ last: last({ at: 'not-a-date' }) }), now).facts.find(f => f.label === 'When')?.value).toBe('not-a-date')
  })
})

describe('family total on a main row (step 3 review, 2026-10-02)', () => {
  const now = Date.parse('2026-10-01T15:00:00')
  it('says how many of the family failed, in the worst tone — never "Accepted" over failed sizes', () => {
    expect(publishFamilyMeta('PARTIAL', { total: 11, failed: 2 })).toMatchObject({ label: '2 of 11 failed', tone: 'warning', terminal: true })
    expect(publishFamilyMeta('FAILED', { total: 11, failed: 11 })).toMatchObject({ label: 'All 11 failed', tone: 'danger' })
    expect(publishFamilyMeta('FAILED', { total: 11, failed: 3 })?.tone).toBe('danger')
    expect(publishFamilyMeta('PARTIAL', { total: 11, failed: 2 })?.detailHint).toBe('2 of 11 products in this family failed in this publish.')
  })
  it('steps aside when nothing failed, or the counts are empty or nonsense', () => {
    expect(publishFamilyMeta('VERIFIED', { total: 11, failed: 0 })).toBeNull()
    expect(publishFamilyMeta('PARTIAL', { total: 0, failed: 2 })).toBeNull()
    expect(publishFamilyMeta('PARTIAL', { total: 3, failed: 9 })?.label).toBe('All 3 failed')
  })
  it('puts the family count in the cell and its spoken name, keeps the time, and leaves rows without a family alone', () => {
    const v = value({ last: last({ status: 'PARTIAL', outcome: 'ACCEPTED', at: '2026-10-01T10:04:00' }), family: { total: 11, failed: 2 } })
    const cell = publishCellModel(v, now)
    expect(cell.meta.label).toBe('2 of 11 failed')
    expect(cell.shortTime).toBe('10:04')
    expect(cell.ariaLabel).toBe('Last publish: 2 of 11 products in this family failed, Amazon · IT, 1 Oct, 10:04. Press Enter for details.')
    expect(publishCellModel(value({ last: last({ status: 'PARTIAL' }) }), now).meta.label).toBe('Partly failed')
    expect(publishCellModel(value({ last: last({ status: 'VERIFIED' }), family: { total: 11, failed: 0 } }), now).meta.label).toBe('Verified')
  })
  it('a publish in flight still wins over the family count', () => {
    expect(publishCellModel(value({ inFlight: { status: 'SUBMITTED' }, last: last({ status: 'PARTIAL' }), family: { total: 11, failed: 2 } }), now).meta.label).toBe('Waiting for channel')
  })
  it('the card keeps the publication word, says the count as its one sentence, and still shows this row’s own result', () => {
    const card = publishCardModel(value({ last: last({ status: 'PARTIAL', outcome: 'ACCEPTED' }), family: { total: 11, failed: 2 } }), now)
    expect(card.meta.label).toBe('Partly failed')
    expect(card.hint).toBe('2 of 11 products in this family failed in this publish.')
    expect(card.rowResult?.label).toBe('Accepted')
    expect(publishCardModel(value({ last: last({ status: 'PARTIAL' }) }), now).hint).toBe('Some products in this publish failed.')
  })
})

describe('what the last send was — kindLabel (build shape v2, P12)', () => {
  const NOW = Date.parse('2026-10-01T12:00:00')
  it('leads the card with "Pause offer · Accepted · 10:42 · Awais" and names a selling change instead of a missing field list', () => {
    const card = publishCardModel(value({ last: last({ kindLabel: 'Pause offer', status: 'ACCEPTED', at: '2026-10-01T10:42:00', userName: 'Awais', sentFields: [] }) }), NOW)
    expect(card.headline).toBe(`Pause offer · Accepted · ${publishShortTime('2026-10-01T10:42:00', NOW)} · Awais`)
    expect(card.sentSummary).toBe('Pause offer.')
    // No person recorded: the line simply ends at the time (never "Not recorded" in the headline).
    expect(publishCardModel(value({ last: last({ kindLabel: 'End listing', status: 'ACCEPTED', userName: null, sentFields: [] }) }), NOW).headline)
      .toBe(`End listing · Accepted · ${publishShortTime('2026-10-01T10:04:00', NOW)}`)
  })
  it('a plain publish (no kindLabel, or a blank one) keeps the card as it was: no headline', () => {
    expect(publishCardModel(value(), NOW).headline).toBeNull()
    expect(publishCardModel(value({ last: last({ kindLabel: '  ' }) }), NOW).headline).toBeNull()
    expect(publishCardModel(value({ last: last({ kindLabel: null, sentFields: [] }) }), NOW).sentSummary).toBe('No field list is recorded for this publish.')
  })
  it('the cell names the kind to a screen reader and on hover, but not while a newer publish is in flight', () => {
    const model = publishCellModel(value({ last: last({ kindLabel: 'Full update', status: 'ACCEPTED' }) }), NOW)
    expect(model.ariaLabel).toMatch(/^Last publish: Full update, Accepted, Amazon · IT/)
    expect(model.title).toBe(`Full update. ${publicationStatusMeta('ACCEPTED').hint}`)
    const busy = publishCellModel(value({ inFlight: { status: 'PUBLISHING' }, last: last({ kindLabel: 'Full update' }) }), NOW)
    expect(busy.ariaLabel).not.toContain('Full update')
  })
})

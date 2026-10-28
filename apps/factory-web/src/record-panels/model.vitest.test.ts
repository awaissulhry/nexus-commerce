import { describe, expect, it } from 'vitest'
import {
  acceptFor,
  attachableFiles,
  audienceBadges,
  canPreview,
  changedValues,
  changeVerbKey,
  composerAbsentReason,
  composerHeld,
  composerModes,
  contentTypeOf,
  fileGroups,
  liveParts,
  MAX_BODY_LENGTH,
  parseAddresses,
  retentionFacts,
  uploadChoices,
  uploadProblem,
  type ComposerDraft,
  type PanelFile,
  type PanelParty,
  type PanelTimelineEntry,
} from './model'

const PARTY: PanelParty = { id: 'party-1', name: 'Marchio Demo', emails: ['buyer@marchio-demo.example.com'] }
const file = (id: string, extra: Partial<PanelFile> = {}): PanelFile => ({
  id,
  name: `${id}.pdf`,
  kind: 'DOCUMENT',
  contentType: 'application/pdf',
  sizeBytes: 1000,
  status: 'AVAILABLE',
  visibility: ['OFFICE'],
  partyId: null,
  retainUntil: null,
  legalHold: false,
  quarantineReason: null,
  availableAt: '2026-10-28T10:00:00.000Z',
  createdAt: '2026-10-28T10:00:00.000Z',
  ...extra,
})
const draft = (extra: Partial<ComposerDraft> = {}): ComposerDraft => ({ mode: 'note', body: 'Hello', to: '', subject: '', mentions: [], attachments: [], ...extra })
const context = { threadClosed: false, sending: false, files: [] as PanelFile[], hasMail: true }

describe('the composer: internal note vs email to the party (COL-003, COL-024)', () => {
  it('offers an email only when the record has a party AND the person has email.send', () => {
    expect(composerModes({ can: { post: true, email: true }, party: PARTY })).toEqual(['note', 'email'])
    expect(composerModes({ can: { post: true, email: true }, party: null })).toEqual(['note'])
    expect(composerModes({ can: { post: true, email: false }, party: PARTY })).toEqual(['note'])
    expect(composerModes({ can: { post: false, email: true }, party: PARTY })).toEqual(['email'])
    expect(composerModes({ can: { post: false, email: false }, party: PARTY })).toEqual([])
  })

  it('says why there is no composer at all', () => {
    expect(composerAbsentReason({ can: { post: false, email: false }, party: PARTY })).toBe('composer.absent.noPermission')
    expect(composerAbsentReason({ can: { post: false, email: true }, party: null })).toBe('composer.absent.noParty')
    expect(composerAbsentReason({ can: { post: true, email: false }, party: null })).toBeNull()
  })

  it('holds the send with the first reason that applies', () => {
    expect(composerHeld(draft(), { ...context, threadClosed: true })?.key).toBe('composer.held.closed')
    expect(composerHeld(draft(), { ...context, sending: true })?.key).toBe('composer.held.sending')
    expect(composerHeld(draft({ body: '   ' }), context)?.key).toBe('composer.held.emptyNote')
    expect(composerHeld(draft({ mode: 'email', body: '' }), context)?.key).toBe('composer.held.emptyEmail')
    expect(composerHeld(draft({ body: 'x'.repeat(MAX_BODY_LENGTH + 3) }), context)).toEqual({ key: 'composer.held.tooLong', params: { count: 3 } })
    expect(composerHeld(draft(), context)).toBeNull()
  })

  it('an email needs valid addresses; a note needs none', () => {
    expect(composerHeld(draft({ mode: 'email', to: '' }), context)?.key).toBe('composer.held.noRecipient')
    expect(composerHeld(draft({ mode: 'email', to: 'buyer@marchio-demo.example.com, nope' }), context)).toEqual({ key: 'composer.held.badAddress', params: { address: 'nope' } })
    expect(composerHeld(draft({ mode: 'email', to: 'buyer@marchio-demo.example.com' }), context)).toBeNull()
    expect(composerHeld(draft({ mode: 'email', to: 'a@example.com', subject: 's'.repeat(201) }), context)?.key).toBe('composer.held.subjectTooLong')
  })

  it('the first mail of a thread needs a subject; an answer takes the last mail\'s', () => {
    const first = { ...context, hasMail: false }
    expect(composerHeld(draft({ mode: 'email', to: 'a@example.com' }), first)?.key).toBe('composer.held.noSubject')
    expect(composerHeld(draft({ mode: 'email', to: 'a@example.com', subject: 'Samples' }), first)).toBeNull()
    expect(composerHeld(draft({ mode: 'note' }), first)).toBeNull()
  })

  it('holds a mail whose attachments are over 10 MB together', () => {
    const big = [file('a', { sizeBytes: 6 * 1_048_576 }), file('b', { sizeBytes: 5 * 1_048_576 })]
    expect(composerHeld(draft({ mode: 'email', to: 'a@example.com', attachments: ['a', 'b'] }), { ...context, files: big })?.key).toBe('composer.held.attachmentsTooLarge')
    expect(composerHeld(draft({ mode: 'email', to: 'a@example.com', attachments: ['a'] }), { ...context, files: big })).toBeNull()
  })

  it('reads a To line: commas, semicolons, spaces; each address once, lower case', () => {
    expect(parseAddresses('A@Example.com; b@example.com,\n<c@example.com> a@example.com')).toEqual({ valid: ['a@example.com', 'b@example.com', 'c@example.com'], invalid: [] })
    expect(parseAddresses('x@y, plain').invalid).toEqual(['x@y', 'plain'])
  })

  it('a note may carry any available file; a mail only files already shared with the party (COL-050)', () => {
    const files = [
      file('office'),
      file('portal', { visibility: ['OFFICE', 'PARTNER'], partyId: PARTY.id }),
      file('link', { visibility: ['OFFICE', 'LINK'], partyId: PARTY.id }),
      file('other-party', { visibility: ['OFFICE', 'PARTNER'], partyId: 'party-2' }),
      file('floor', { visibility: ['OFFICE', 'FLOOR'] }),
      file('quarantined', { status: 'QUARANTINED', visibility: ['OFFICE', 'PARTNER'], partyId: PARTY.id }),
    ]
    expect(attachableFiles(files, 'note', PARTY).map((f) => f.id)).toEqual(['office', 'portal', 'link', 'other-party', 'floor'])
    expect(attachableFiles(files, 'email', PARTY).map((f) => f.id)).toEqual(['portal', 'link'])
    expect(attachableFiles(files, 'email', null)).toEqual([])
  })
})

describe('files: audience badges, versions, retention (COL-045, COL-050)', () => {
  it('marks an office-only file as such, and every audience beyond the office', () => {
    expect(audienceBadges(['OFFICE'])).toEqual([{ audience: 'OFFICE_ONLY', tone: 'neutral', key: 'files.audience.officeOnly' }])
    expect(audienceBadges(['LINK', 'OFFICE', 'FLOOR']).map((badge) => [badge.audience, badge.tone])).toEqual([
      ['OFFICE', 'neutral'],
      ['FLOOR', 'info'],
      ['LINK', 'warning'],
    ])
    // A party sees it: it leaves the office, so it is never mistaken for an internal file.
    expect(audienceBadges(['OFFICE', 'PARTNER']).find((badge) => badge.audience === 'PARTNER')?.tone).toBe('warning')
  })

  it('groups files of one kind and name as versions, newest first; deleted files are left out', () => {
    const groups = fileGroups([
      file('v1', { name: 'Cert.pdf', kind: 'CERTIFICATE', createdAt: '2026-10-01T00:00:00.000Z' }),
      file('v3', { name: 'cert.pdf ', kind: 'CERTIFICATE', createdAt: '2026-10-03T00:00:00.000Z' }),
      file('v2', { name: 'Cert.pdf', kind: 'CERTIFICATE', createdAt: '2026-10-02T00:00:00.000Z' }),
      file('other-kind', { name: 'Cert.pdf', kind: 'DOCUMENT', createdAt: '2026-09-01T00:00:00.000Z' }),
      file('gone', { name: 'Old.pdf', status: 'DELETED' }),
    ])
    expect(groups.map((group) => [group.latest.id, group.earlier.map((f) => f.id)])).toEqual([
      ['v3', ['v2', 'v1']],
      ['other-kind', []],
    ])
  })

  it('shows what keeps a file, read only: a legal hold, a retention date ahead, the fiscal archive', () => {
    const now = new Date('2026-10-28T00:00:00.000Z')
    expect(retentionFacts(file('a', { kind: 'FISCAL_ARCHIVE', retainUntil: '2036-10-28T00:00:00.000Z' }), now)).toEqual([{ key: 'files.retention.fiscal', tone: 'neutral', until: '2036-10-28T00:00:00.000Z' }])
    expect(retentionFacts(file('b', { legalHold: true, retainUntil: '2027-01-01T00:00:00.000Z' }), now).map((fact) => fact.key)).toEqual(['files.retention.legalHold', 'files.retention.until'])
    expect(retentionFacts(file('c', { retainUntil: '2026-01-01T00:00:00.000Z' }), now)).toEqual([])
  })

  it('previews only an available PDF', () => {
    expect(canPreview(file('a'))).toBe(true)
    expect(canPreview(file('b', { contentType: 'image/png' }))).toBe(false)
    expect(canPreview(file('c', { status: 'QUARANTINED' }))).toBe(false)
  })

  it('offers sharing beyond the office only to files.manage, and only where there is a site or a party', () => {
    const record = { siteId: 'site-1', companyId: 'company-1' }
    expect(uploadChoices({ can: { share: true }, party: PARTY, record }).audiences).toEqual(['OFFICE', 'FLOOR', 'PARTNER', 'LINK'])
    expect(uploadChoices({ can: { share: true }, party: null, record: { siteId: null, companyId: 'company-1' } }).audiences).toEqual(['OFFICE'])
    expect(uploadChoices({ can: { share: false }, party: PARTY, record }).audiences).toEqual(['OFFICE'])
  })

  it('checks a picked file against its kind before anything is sent', () => {
    expect(uploadProblem({ name: 'a.pdf', type: 'application/pdf', size: 10 }, 'CERTIFICATE')).toBeNull()
    expect(uploadProblem({ name: 'a.html', type: 'text/html', size: 10 }, 'ATTACHMENT')?.key).toBe('files.problem.type')
    expect(uploadProblem({ name: 'a.jpg', type: 'image/jpeg', size: 16 * 1_048_576 }, 'PHOTO')?.key).toBe('files.problem.size')
    expect(uploadProblem({ name: 'a.pdf', type: 'application/pdf', size: 0 }, 'DOCUMENT')?.key).toBe('files.problem.empty')
    // A signed invoice the browser did not type is read by its extension.
    expect(contentTypeOf('IT01234567890_00001.xml.p7m')).toBe('application/pkcs7-mime')
    expect(uploadProblem({ name: 'IT01234567890_00001.xml.p7m', type: '', size: 10 }, 'FISCAL_ARCHIVE')).toBeNull()
    expect(acceptFor('PHOTO').split(',')).toEqual(expect.arrayContaining(['image/jpeg', '.jpg', '.heic']))
  })
})

describe('the history (COL-002)', () => {
  const change = (extra: Partial<Extract<PanelTimelineEntry, { kind: 'change' }>> = {}): Extract<PanelTimelineEntry, { kind: 'change' }> => ({
    kind: 'change',
    id: 'c1',
    at: '2026-10-28T10:00:00.000Z',
    action: 'compliance.certificates.issue',
    actorName: null,
    actorAudience: 'OFFICE',
    status: { from: 'DRAFT', to: 'VALID' },
    fields: ['status'],
    values: null,
    reason: null,
    ...extra,
  })

  it('names a change by its verb', () => {
    expect(changeVerbKey('compliance.certificates.issue')).toBe('history.verb.issued')
    expect(changeVerbKey('threads.postNote')).toBe('history.verb.noted')
    expect(changeVerbKey('something.unheardOf')).toBe('history.verb.changed')
  })

  it('shows values before → after only when the API gave them (audit.read)', () => {
    expect(changedValues(change())).toEqual([])
    expect(changedValues(change({ fields: ['status', 'validTo'], values: { before: { status: 'DRAFT', validTo: null }, after: { status: 'VALID', validTo: '2031-10-26' } } }))).toEqual([
      { field: 'status', before: 'DRAFT', after: 'VALID' },
      { field: 'validTo', before: '—', after: '2031-10-26' },
    ])
  })
})

describe('live refresh: only this record, only the parts that changed', () => {
  const record = { type: 'Certificate', id: 'r1' }
  it('reads the thread and history again for a message, files and history for a file, mail states for a mail', () => {
    expect(liveParts({ type: 'thread.message_posted', fields: { recordType: 'Certificate', recordId: 'r1' } }, record)).toEqual(['thread', 'timeline', 'emails'])
    expect(liveParts({ type: 'file.available', fields: { recordType: 'Certificate', recordId: 'r1' } }, record)).toEqual(['files', 'timeline'])
    expect(liveParts({ type: 'email.status_changed', fields: { recordType: 'Certificate', recordId: 'r1', status: 'DELIVERED' } }, record)).toEqual(['emails'])
  })

  it('ignores other records and other events', () => {
    expect(liveParts({ type: 'thread.message_posted', fields: { recordType: 'Certificate', recordId: 'r2' } }, record)).toEqual([])
    expect(liveParts({ type: 'thread.message_posted', fields: { recordType: 'Quote', recordId: 'r1' } }, record)).toEqual([])
    expect(liveParts({ type: 'email.inbound_sorted', fields: { recordType: 'Certificate', recordId: 'r1' } }, record)).toEqual([])
  })
})

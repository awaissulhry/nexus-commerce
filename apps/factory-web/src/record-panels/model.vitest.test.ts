import { describe, expect, it } from 'vitest'
import { contentTypeOf, liveParts, uploadChoices, uploadProblem, type PanelParty } from './model'

/**
 * The record modules' shared rules (B-TH-280: what stays of the old record panels' model — the upload rules the docked thread's
 * Files view and the request forms use, and the live refresh of a record's thread).
 */

const PARTY: PanelParty = { id: 'party-1', name: 'Marchio Demo', emails: ['buyer@marchio-demo.example.com'] }

describe('files: what an upload may be and who may see it (COL-045, COL-050)', () => {
  it('does not offer the kinds of file only the record\'s module uploads (platform/files/owned.ts)', () => {
    const base = { can: { share: false }, party: null }
    expect(uploadChoices({ ...base, record: { type: 'Certificate', siteId: null, companyId: 'c' } })).toMatchObject({ owned: ['CERTIFICATE'], kinds: ['ATTACHMENT', 'DOCUMENT', 'PHOTO', 'FISCAL_ARCHIVE'] })
    expect(uploadChoices({ ...base, record: { type: 'ComplianceDocument', siteId: null, companyId: 'c' } }).kinds).toEqual([])
    expect(uploadChoices({ ...base, record: { type: 'Quote', siteId: null, companyId: 'c' } }).owned).toEqual([])
  })

  it('offers sharing beyond the office only to files.manage, and only where there is a site or a party', () => {
    const record = { type: 'Quote', siteId: 'site-1', companyId: 'company-1' }
    expect(uploadChoices({ can: { share: true }, party: PARTY, record }).audiences).toEqual(['OFFICE', 'FLOOR', 'PARTNER', 'LINK'])
    expect(uploadChoices({ can: { share: true }, party: null, record: { type: 'Quote', siteId: null, companyId: 'company-1' } }).audiences).toEqual(['OFFICE'])
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
  })

  it('knows a voice note (AUDIO, B-W2b-96): offered on a machine request or job only, read by its extension', () => {
    const base = { can: { share: false }, party: null }
    expect(uploadChoices({ ...base, record: { type: 'MaintenanceRequest', siteId: 's', companyId: 'c' } }).kinds).toContain('AUDIO')
    expect(uploadChoices({ ...base, record: { type: 'MaintenanceJob', siteId: 's', companyId: 'c' } }).kinds).toContain('AUDIO')
    expect(uploadChoices({ ...base, record: { type: 'Quote', siteId: null, companyId: 'c' } }).kinds).not.toContain('AUDIO')
    expect(contentTypeOf('note.webm')).toBe('audio/webm')
    expect(uploadProblem({ name: 'note.m4a', type: '', size: 10 }, 'AUDIO')).toBeNull()
    expect(uploadProblem({ name: 'note.webm', type: 'audio/webm', size: 11 * 1_048_576 }, 'AUDIO')?.key).toBe('files.problem.size')
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

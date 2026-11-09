import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { FACTORY_PERMISSIONS } from '../auth/permissions/catalogue'
import { ROLE_TEMPLATES } from '../auth/roles/templates'
import { EVENT_DEFINITIONS } from '../events/catalogue'
import { draftData, draftEnvelope, draftPurgeAfter, draftSizeProblem, DRAFT_MAX_BYTES } from './drafts'
import { evidenceFor } from './evidence'
import { fileSetProblems, LINK_FILES_MAX, newerVersionOf, newerVersionWords, type CandidateFile } from './files'
import { linkFilesMail } from './mail'
import { LINK_PASSWORD, linkPasswordProblem, mintUnlock, passwordStep, passwordWords, unlockOpens } from './password'
import { isPayRecord, PAY_RECORD_TYPES, payByLinkProblem, PAYROLL_HOURS_ONLY_BY_LINK } from './pay'
import { LINK_SESSION_PERMISSIONS } from './permissions'
import { answersOf, DRAFT_PURPOSES, EVIDENCE_ACTIONS, FILE_SET_PURPOSES, LINK_ACTIONS, LINK_PURPOSES, linkPermissions, linkTerms, PURPOSE_RULES } from './purposes'
import { askedRecentlyWords, fileRenewalRefusal, LINK_RENEW_COALESCE_MS, LINK_RENEW_NOTE_MAX, makerToldRefusal, renewalRoute, renewalTerms, type FileRenewalFacts, type MakerToldFacts } from './renew'

/** B-W2b-163: links in depth (COL-051, MES-274; design 02 portal-links "New link purposes", links.document, links.file, links.frame). */

const LINK = '0195f5d0-0000-7000-8000-0000000000e1'
const OTHER_LINK = '0195f5d0-0000-7000-8000-0000000000e2'
const COMPANY = '0195f5d0-0000-7000-8000-0000000000c1'
const NOW = new Date('2026-11-07T09:00:00.000Z')

describe('the thirteen purposes', () => {
  it('match the schema\'s LinkPurpose and give each action its evidence and its link-session permission', () => {
    expect(LINK_PURPOSES).toHaveLength(13)
    expect(Object.keys(EVIDENCE_ACTIONS)).toEqual([...LINK_ACTIONS])
    expect(new Set(Object.values(EVIDENCE_ACTIONS)).size).toBe(LINK_ACTIONS.length)
    expect(LINK_SESSION_PERMISSIONS).toHaveLength(LINK_ACTIONS.length)
    for (const purpose of LINK_PURPOSES) {
      for (const permission of linkPermissions(purpose)) expect(FACTORY_PERMISSIONS.isDeclared(permission), `${purpose} ${permission}`).toBe(true)
    }
    for (const template of ROLE_TEMPLATES) for (const name of LINK_SESSION_PERMISSIONS) expect(template.permissions, template.key).not.toContain(name)
  })

  it('give the price grain to PAYMENT and (B-W2b-184, a revised order of the party\'s own) APPROVAL of the new ones, and nothing beyond price to any', () => {
    const W2B = ['SHIPMENT_TRACK', 'MEASUREMENTS', 'CLAIM', 'PAYMENT', 'SUPPLIER_ONBOARD', 'JOB_ACCEPT', 'APPROVAL', 'RECORD_INVITE', 'SECURE_FILE'] as const
    expect(W2B.filter((purpose) => PURPOSE_RULES[purpose].grains.length > 0)).toEqual(['PAYMENT', 'APPROVAL'])
    expect(linkPermissions('PAYMENT')).toEqual(['links.open', 'links.pay', 'money.price'])
    expect(linkPermissions('JOB_ACCEPT')).toEqual(['links.accept', 'links.decline', 'links.moveDate', 'links.open'])
  })

  it('count the answers, every open of a view purpose, a secure file\'s downloads; never an open of an answer purpose, a receipt or a shared record\'s posts', () => {
    expect(PURPOSE_RULES.SECURE_FILE.actions).toMatchObject({ open: { counts: false }, download: { counts: true }, receive: { counts: false, typedName: 'optional' } })
    expect(PURPOSE_RULES.DOCUMENT_VIEW.actions).toMatchObject({ open: { counts: true }, download: { counts: false } })
    // B-W2b-170: the tracking page's papers are downloads (evidence, never a use).
    expect(PURPOSE_RULES.SHIPMENT_TRACK.actions).toEqual({ open: { counts: false, typedName: 'none', checksEmail: false }, download: { counts: false, typedName: 'none', checksEmail: false } })
    expect(PURPOSE_RULES.RECORD_INVITE.actions.post?.counts).toBe(false)
    expect(PURPOSE_RULES.APPROVAL.actions.approve).toEqual({ counts: true, typedName: 'required', checksEmail: false })
    expect(PURPOSE_RULES.SUPPLIER_ONBOARD.actions.submit?.typedName).toBe('required')
    expect(answersOf('DOCUMENT_VIEW')).toEqual([])
    expect(answersOf('SECURE_FILE')).toEqual(['receive'])
    expect(answersOf('JOB_ACCEPT')).toEqual(['accept', 'decline', 'moveDate'])
  })

  it('keep the design\'s terms: a secure file 7 days and 5 downloads, measurements 21 days and one send', () => {
    expect(linkTerms('SECURE_FILE', {}, NOW)).toEqual({ expiresAt: new Date('2026-11-14T09:00:00.000Z'), maxUses: 5 })
    expect(linkTerms('MEASUREMENTS', {}, NOW)).toEqual({ expiresAt: new Date('2026-11-28T09:00:00.000Z'), maxUses: 1 })
    expect(linkTerms('CLAIM', {}, NOW).maxUses).toBe(5)
    expect(() => linkTerms('SECURE_FILE', { expiresInDays: 31 }, NOW)).toThrow()
  })

  it('name the purposes of a set of files and of a draft as the database does', () => {
    expect([...FILE_SET_PURPOSES]).toEqual(['DOCUMENT_VIEW', 'SECURE_FILE'])
    expect([...DRAFT_PURPOSES]).toEqual(['MEASUREMENTS', 'CLAIM', 'SUPPLIER_ONBOARD'])
    expect(LINK_PURPOSES.filter((purpose) => PURPOSE_RULES[purpose].password)).toEqual(['DOCUMENT_VIEW', 'SECURE_FILE'])
    expect(LINK_PURPOSES.filter((purpose) => PURPOSE_RULES[purpose].receipt)).toEqual(['SECURE_FILE'])
  })

  it('evidence a receipt with an optional typed name, and refuse a download to a purpose without one', () => {
    expect(evidenceFor('SECURE_FILE', 'receive', { email: null }, { typedName: '  Studio  Rossi ' })).toEqual({ action: 'RECEIVED', counts: false, typedName: 'Studio Rossi', emailCheck: 'NOT_ASKED' })
    expect(evidenceFor('SECURE_FILE', 'download', { email: null })).toMatchObject({ action: 'DOWNLOADED', counts: true })
    expect(() => evidenceFor('QUOTE_ACCEPT', 'download', { email: null })).toThrow('This link cannot do that.')
  })

  it('declare link.renewed with a live rule for the links view', () => {
    const renewed = EVENT_DEFINITIONS.find((definition) => definition.type === 'link.renewed')
    expect(renewed?.live?.permission).toBe('links.view')
  })
})

describe('pay figures never go by link (Owner, 11-02)', () => {
  it('refuse every record type with pay figures, and a payroll file with amounts', () => {
    expect(PAY_RECORD_TYPES).toHaveLength(9)
    for (const type of PAY_RECORD_TYPES) expect(payByLinkProblem({ recordType: type })).toContain('pay figures never go by link')
    expect(payByLinkProblem({ recordType: 'PayrollExport', payrollCarriesPay: true, fileName: 'PAY-2026-0001.csv' })).toBe('"PAY-2026-0001.csv" is a payroll file with amounts, and pay figures never go by link. Only a file of hours may be sent.')
    expect(isPayRecord('Quote')).toBe(false)
    expect(payByLinkProblem({ recordType: 'Quote' })).toBeNull()
  })

  it('let a file of hours only go while the Owner\'s W2b-2 question 2 is open', () => {
    expect(PAYROLL_HOURS_ONLY_BY_LINK).toBe(true)
    expect(payByLinkProblem({ recordType: 'PayrollExport', payrollCarriesPay: false })).toBeNull()
  })
})

describe('a set of files (COL-051)', () => {
  const file = (id: string, more: Partial<CandidateFile> = {}): CandidateFile => ({ id, companyId: COMPANY, status: 'AVAILABLE', recordType: 'Style', originalName: `${id}.pdf`, ...more })
  const ids = ['a', 'b', 'c', 'd', 'e', 'f']
  const found = new Map<string, CandidateFile>([
    ['a', file('a')],
    ['b', file('b', { status: 'QUARANTINED' })],
    ['c', file('c', { companyId: '0195f5d0-0000-7000-8000-0000000000c2' })],
    ['d', file('d', { recordType: 'WorkerStatement' })],
    ['e', file('e', { recordType: 'PayrollExport', payrollCarriesPay: true })],
    ['f', file('f', { companyId: null })],
  ])

  it('names each file that may not go, at its place in the list', () => {
    const problems = fileSetProblems([...ids, 'a', 'missing'], found, COMPANY)
    expect(problems.map((issue) => issue.path)).toEqual(['fileIds/1', 'fileIds/2', 'fileIds/3', 'fileIds/4', 'fileIds/6', 'fileIds/7'])
    expect(problems[0]!.message).toBe('"b.pdf" is quarantined: only an available file can be shared.')
    expect(problems[2]!.message).toContain('pay figures never go by link')
    expect(fileSetProblems(['a', 'f'], found, COMPANY)).toEqual([])
    expect(fileSetProblems([], found, COMPANY)).toEqual([{ path: 'fileIds', message: 'Choose at least one file.' }])
    expect(fileSetProblems(Array.from({ length: LINK_FILES_MAX + 1 }, () => 'a'), found, COMPANY)[0]!.message).toBe(`A link shares at most ${LINK_FILES_MAX} files.`)
  })

  it('names a newer version of a shared file, and points at it only when it is in the same set', () => {
    const v3 = { id: 'v3', versionNo: 3, status: 'AVAILABLE', supersededAt: new Date('2026-11-12T10:00:00.000Z') }
    const v4 = { id: 'v4', versionNo: 4, status: 'AVAILABLE', supersededAt: null }
    expect(newerVersionOf(v4, [v3, v4], new Set(['v4']))).toBeNull()
    const newer = newerVersionOf(v3, [v3, v4], new Set(['v3']))!
    expect(newer).toEqual({ versionNo: 4, replacedAt: v3.supersededAt, sharedFileId: null })
    expect(newerVersionWords(newer)).toBe('Version 4 replaced this one on 12 Nov 2026. Ask the sender for it.')
    expect(newerVersionOf(v3, [v3, v4], new Set(['v3', 'v4']))?.sharedFileId).toBe('v4')
  })
})

describe('the password (5 tries, then held 15 minutes)', () => {
  it('takes 8 to 128 characters as typed', () => {
    expect(linkPasswordProblem('short')).toContain('8 to 128')
    expect(linkPasswordProblem('        ')).toBe('A link password is more than spaces.')
    expect(linkPasswordProblem('correct horse')).toBeNull()
  })

  it('counts wrong ones, holds at the fifth, starts again at one after the hold, and a right one clears it', () => {
    let state = { tries: 0, heldUntil: null as Date | null }
    for (let i = 1; i <= 4; i += 1) {
      const step = passwordStep(state, false, NOW)
      expect(step).toMatchObject({ kind: 'wrong', triesLeft: LINK_PASSWORD.tries - i })
      state = (step as { next: typeof state }).next
    }
    expect(passwordWords({ kind: 'wrong', next: { tries: 4, heldUntil: null }, triesLeft: 1 }, NOW)).toBe('That password does not match. 1 try left.')
    const fifth = passwordStep(state, false, NOW)
    expect(fifth).toEqual({ kind: 'wrong', next: { tries: 5, heldUntil: new Date(NOW.getTime() + 15 * 60_000) }, triesLeft: 0 })
    state = (fifth as { next: typeof state }).next
    expect(passwordWords(fifth as never, NOW)).toBe('Too many wrong passwords. Try again in 15 minutes, or ask the sender.')
    expect(passwordStep(state, true, new Date(NOW.getTime() + 60_000))).toEqual({ kind: 'held', until: state.heldUntil })
    const later = new Date(NOW.getTime() + 16 * 60_000)
    expect(passwordStep(state, false, later)).toEqual({ kind: 'wrong', next: { tries: 1, heldUntil: null }, triesLeft: 4 })
    expect(passwordStep(state, true, later)).toEqual({ kind: 'right', next: { tries: 0, heldUntil: null } })
    expect(passwordStep({ tries: 0, heldUntil: null }, true, NOW)).toEqual({ kind: 'right', next: null })
  })

  it('opens the files with an unlock key of this link, for 30 minutes, never past the link', () => {
    const key = randomBytes(32)
    const unlock = mintUnlock(key, LINK, NOW, new Date('2026-12-01T00:00:00.000Z'))
    expect(unlock.until).toEqual(new Date(NOW.getTime() + 30 * 60_000))
    expect(unlockOpens(key, unlock.value, LINK, new Date(NOW.getTime() + 29 * 60_000))).toBe(true)
    expect(unlockOpens(key, unlock.value, LINK, new Date(NOW.getTime() + 30 * 60_000))).toBe(false)
    expect(unlockOpens(key, unlock.value, OTHER_LINK, NOW)).toBe(false)
    expect(unlockOpens(randomBytes(32), unlock.value, LINK, NOW)).toBe(false)
    expect(unlockOpens(key, unlock.value.replace(/\d{13}/, String(NOW.getTime() + 999_999_999)), LINK, NOW)).toBe(false)
    expect(mintUnlock(key, LINK, NOW, new Date(NOW.getTime() + 60_000)).until).toEqual(new Date(NOW.getTime() + 60_000))
  })
})

describe('drafts kept with us', () => {
  it('belong to their link, live until 7 days after it, and stay small', () => {
    const envelope = draftEnvelope(LINK, { chest: 102, note: 'made up' })
    expect(draftData(LINK, envelope)).toEqual({ chest: 102, note: 'made up' })
    expect(draftData(OTHER_LINK, envelope)).toBeNull()
    expect(draftData(LINK, '{not json')).toBeNull()
    expect(draftPurgeAfter(new Date('2026-11-28T09:00:00.000Z'))).toEqual(new Date('2026-12-05T09:00:00.000Z'))
    expect(draftSizeProblem(envelope)).toBeNull()
    expect(draftSizeProblem(draftEnvelope(LINK, { photo: 'x'.repeat(DRAFT_MAX_BYTES) }))).toContain('too large')
  })
})

describe('ask for a new link (a set of files)', () => {
  const dead: FileRenewalFacts = {
    purpose: 'SECURE_FILE',
    recordType: 'StoredFile',
    state: 'EXPIRED',
    email: 'studio@example.com',
    addressOnFile: true,
    files: 2,
    filesAvailable: 2,
    liveSibling: false,
    askedRecently: false,
    payProblem: null,
  }

  it('renews an expired or used-up set to the address on file only, once in ten minutes', () => {
    expect(fileRenewalRefusal(dead)).toBeNull()
    expect(fileRenewalRefusal({ ...dead, state: 'USED_UP' })).toBeNull()
    expect(fileRenewalRefusal({ ...dead, purpose: 'QUOTE_ACCEPT' })).toBe('NOT_A_FILE_LINK')
    expect(fileRenewalRefusal({ ...dead, recordType: 'PayrollExport' })).toBe('NOT_A_FILE_LINK')
    expect(fileRenewalRefusal({ ...dead, state: 'REVOKED' })).toBe('WITHDRAWN')
    expect(fileRenewalRefusal({ ...dead, state: 'LIVE' })).toBe('STILL_LIVE')
    expect(fileRenewalRefusal({ ...dead, email: null })).toBe('NO_ADDRESS')
    expect(fileRenewalRefusal({ ...dead, addressOnFile: false })).toBe('ADDRESS_NOT_ON_FILE')
    expect(fileRenewalRefusal({ ...dead, liveSibling: true })).toBe('NEWER_LINK')
    expect(fileRenewalRefusal({ ...dead, askedRecently: true })).toBe('ASKED_RECENTLY')
    expect(fileRenewalRefusal({ ...dead, filesAvailable: 0 })).toBe('NOTHING_TO_SHARE')
    expect(fileRenewalRefusal({ ...dead, payProblem: 'x' })).toBe('PAY_FIGURES')
  })

  it('B-W2b-F17: a kind with no renewer goes to its maker; a set of files is renewed here; a module renewer decides first', () => {
    expect(renewalRoute('SHIPMENT_TRACK', 'Shipment', true)).toBe('module')
    expect(renewalRoute('SECURE_FILE', 'StoredFile', false)).toBe('files')
    expect(renewalRoute('DOCUMENT_VIEW', 'StoredFile', false)).toBe('files')
    // The payroll file is a DOCUMENT_VIEW of a PayrollExport: no set of files, no renewer → its maker.
    expect(renewalRoute('DOCUMENT_VIEW', 'PayrollExport', false)).toBe('maker')
    for (const purpose of ['QUOTE_ACCEPT', 'DEPOSIT_INFO', 'PAYMENT', 'JOB_ACCEPT', 'APPROVAL', 'RECORD_INVITE'] as const) {
      for (const recordType of PURPOSE_RULES[purpose].recordTypes) expect(renewalRoute(purpose, recordType, false), `${purpose} ${recordType}`).toBe('maker')
    }
  })

  it('B-W2b-F17: tells the maker of a dead link once in ten minutes, never of a live one, never a maker who left', () => {
    const facts: MakerToldFacts = { state: 'EXPIRED', standsFor: true, makerActive: true, lastToldAt: null, now: NOW }
    expect(makerToldRefusal(facts)).toBeNull()
    expect(makerToldRefusal({ ...facts, state: 'REVOKED' })).toBeNull()
    expect(makerToldRefusal({ ...facts, state: 'USED_UP' })).toBeNull()
    expect(makerToldRefusal({ ...facts, state: 'LIVE' })).toBe('STILL_LIVE')
    // A live link whose share was revoked behind it (RECORD_INVITE's live check) is dead to its holder.
    expect(makerToldRefusal({ ...facts, state: 'LIVE', standsFor: false })).toBeNull()
    expect(makerToldRefusal({ ...facts, makerActive: false })).toBe('NO_MAKER')
    const recently = new Date(NOW.getTime() - LINK_RENEW_COALESCE_MS + 60_000)
    expect(makerToldRefusal({ ...facts, lastToldAt: recently })).toBe('ASKED_RECENTLY')
    expect(makerToldRefusal({ ...facts, lastToldAt: new Date(NOW.getTime() - LINK_RENEW_COALESCE_MS) })).toBeNull()
    expect(askedRecentlyWords(recently, NOW)).toBe('The person who made this link was told about it already; it is passed on again in 1 minute at the earliest.')
    expect(askedRecentlyWords(NOW, NOW)).toContain('in 10 minutes')
    expect(LINK_RENEW_NOTE_MAX).toBe(500)
  })

  it('B-W2b-F17: declares link.renewal_asked, its note never on a live screen', () => {
    const asked = EVENT_DEFINITIONS.find((definition) => definition.type === 'link.renewal_asked')
    expect(asked?.live?.permission).toBe('links.view')
    expect(asked?.live?.fields).not.toContain('note')
    expect(asked?.live?.fields).not.toContain('makerId')
  })

  it('keeps the old span and use limit within the purpose', () => {
    const old = { createdAt: new Date('2026-10-01T09:00:00.000Z'), expiresAt: new Date('2026-10-04T09:00:00.000Z'), maxUses: 3 }
    expect(renewalTerms('SECURE_FILE', old, NOW)).toEqual({ expiresAt: new Date('2026-11-10T09:00:00.000Z'), maxUses: 3 })
    expect(renewalTerms('SECURE_FILE', { ...old, expiresAt: new Date('2027-10-04T09:00:00.000Z'), maxUses: 99 }, NOW).maxUses).toBe(20)
  })
})

describe('the mail', () => {
  it('names the files and the terms, says the password comes apart, and never holds it', () => {
    const mail = linkFilesMail({ locale: 'en', companyName: 'Made-up Srl', secure: true, fileNames: ['A.pdf', 'B.csv'], expiresAt: NOW, uses: 5, password: true, renewal: true, message: null }, 'https://web.example/l#token=x')
    expect(mail.subject).toBe('Secure files from Made-up Srl (2 files)')
    expect(mail.body).toContain('- A.pdf\n- B.csv')
    expect(mail.body).toContain('https://web.example/l#token=x')
    expect(mail.body).toContain('This new link replaces the one that no longer opened.')
    expect(mail.body).toContain('we never send it with the link')
    expect(mail.body).toContain('for 5 downloads')
    const it = linkFilesMail({ locale: 'it', companyName: 'Made-up Srl', secure: false, fileNames: ['A.pdf'], expiresAt: NOW, uses: 1, password: false, renewal: false, message: null }, 'u')
    expect(it.subject).toBe('Documenti da Made-up Srl (1 file)')
    expect(it.body).toContain('per 1 apertura')
    expect(it.body).not.toContain('password')
  })
})

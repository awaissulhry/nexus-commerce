import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { createApiClient } from '../../lib/api/client'
import { ApiError } from '../../lib/api/errors'
import { messagesFor } from '../../lib/i18n/messages'
import { I18nProvider } from '../../lib/i18n/provider'
import { linkTaskOf } from '../_nav/link-types'
import { designScreen as setScreen } from '../document/set/fixtures'
import { confirmReceipt, downloadSetFile, fileSetSchema, payrollFilesSchema, readFileSet, UNLOCK_HEADER } from './api'
import { designScreen } from './fixtures'
import {
  downloadAllHeld,
  downloadHeld,
  downloadsCount,
  emptyModel,
  heldUntilOf,
  lastDownload,
  locked,
  monthWords,
  newerOnLink,
  offersDownloadAll,
  pageOfPayroll,
  pageOfSet,
  passwordProblemOf,
  receiptHeld,
  RECEIPT_NAME_MAX,
  shortChecksum,
  sizeText,
  standingHold,
  stateOfReadError,
  triesLeftOf,
  unlockHeld,
  unlockPassed,
  usedUp,
  withUsesLeft,
  type FilePage,
} from './model'

const catalogue = (locale: 'it' | 'en') => JSON.parse(readFileSync(new URL(`../../../messages/${locale}/link-files.json`, import.meta.url), 'utf8')) as Record<string, unknown>
const flat = (tree: Record<string, unknown>, prefix = ''): Record<string, string> =>
  Object.fromEntries(Object.entries(tree).flatMap(([key, value]) => (typeof value === 'string' ? [[`${prefix}${key}`, value]] : Object.entries(flat(value as Record<string, unknown>, `${prefix}${key}.`)))))
const has = (keys: Record<string, string>, key: string) => key in keys || (`${key}_one` in keys && `${key}_other` in keys)

/** What GET /link/files answers (B-W2b-163's contract), made up. */
const SET_ANSWER = {
  link: { purpose: 'SECURE_FILE', expiresAt: '2026-11-16T17:00:00.000Z', usesLeft: 5, password: { asked: true, unlocked: true, heldUntil: null }, receipt: { asked: true, at: null, name: null } },
  sender: { companyName: 'Officina Demo' },
  count: 2,
  files: [
    { id: 'b', position: 2, name: 'b.pdf', sizeBytes: 10, sha256: 'b'.repeat(64), contentType: 'application/pdf', preview: null, available: true, newer: null },
    { id: 'a', position: 1, name: 'a.pdf', sizeBytes: 10, sha256: 'a'.repeat(64), contentType: 'application/pdf', preview: null, available: true, newer: { versionNo: 4, replacedAt: '2026-11-12T10:00:00.000Z', sharedFileId: 'b', words: 'Version 4 replaced this one on 12 Nov 2026.' } },
  ],
}

const page = (over: Partial<FilePage> = {}): FilePage => ({ ...pageOfSet(fileSetSchema.parse(SET_ANSWER)), ...over })
const NOW = new Date('2026-11-09T09:45:00.000Z')

describe('the link registry sends every file link to this page', () => {
  it('SECURE_FILE and DOCUMENT_VIEW of files, and the payroll file', () => {
    expect(linkTaskOf({ purpose: 'SECURE_FILE', record: { type: 'StoredFile' } })).toBe('files')
    expect(linkTaskOf({ purpose: 'DOCUMENT_VIEW', record: { type: 'StoredFile' } })).toBe('files')
    expect(linkTaskOf({ purpose: 'DOCUMENT_VIEW', record: { type: 'PayrollExport' } })).toBe('payroll-file')
    expect(linkTaskOf({ purpose: 'DOCUMENT_VIEW', record: { type: 'Shipment' } })).toBe('shipment-documents')
  })
})

describe('the page as read (pure)', () => {
  it('a set: in position order, the newer version named, the API’s English words left out', () => {
    const read = page()
    expect(read.kind).toBe('secure')
    expect(read.files.map((file) => file.id)).toEqual(['a', 'b'])
    expect(read.files[0]!.newer).toEqual({ versionNo: 4, replacedAt: '2026-11-12T10:00:00.000Z', sharedFileId: 'b' })
    expect(newerOnLink(read, read.files[0]!)?.id).toBe('b')
    expect(pageOfSet(fileSetSchema.parse({ ...SET_ANSWER, link: { ...SET_ANSWER.link, purpose: 'DOCUMENT_VIEW' } })).kind).toBe('shared')
  })

  it('the payroll file: the data file first, then the summary; hours only, no password, no receipt', () => {
    const read = pageOfPayroll(
      payrollFilesSchema.parse({
        sender: 'Officina Demo S.r.l.',
        month: '2026-10',
        label: 'ottobre 2026',
        number: 'PAY-2026-0010',
        revision: 1,
        link: { expiresAt: '2026-12-09T17:00:00.000Z', usesLeft: 18 },
        files: [
          { id: 's', kind: 'SUMMARY', name: 'summary.pdf', sizeBytes: 1, sha256: 's'.repeat(64) },
          { id: 'd', kind: 'DATA', name: 'data.txt', sizeBytes: 1, sha256: 'd'.repeat(64) },
        ],
      }),
    )
    expect(read.files.map((file) => file.payrollKind)).toEqual(['DATA', 'SUMMARY'])
    expect(read.password.asked).toBe(false)
    expect(read.receipt.asked).toBe(false)
    expect(downloadsCount(read)).toBe(true)
  })

  it('a secure file and the payroll file count downloads; a shared set counts opens only', () => {
    expect(downloadsCount({ kind: 'secure' })).toBe(true)
    expect(downloadsCount({ kind: 'payroll' })).toBe(true)
    expect(downloadsCount({ kind: 'shared' })).toBe(false)
  })
})

describe('downloads (each a use on a counted link)', () => {
  it('Download all is held with why when fewer uses are left than files; one by one still works', () => {
    const short = page({ usesLeft: 1 })
    expect(downloadAllHeld(short, emptyModel())).toEqual({ key: 'all.held.uses', params: { count: 2, left: 1 } })
    expect(downloadHeld(short, emptyModel(), 'a')).toBeNull()
    expect(lastDownload(short)).toBe(true)
    // A shared set never holds for uses: its downloads are logged, not counted.
    expect(downloadAllHeld({ ...short, kind: 'shared' }, emptyModel())).toBeNull()
    expect(lastDownload({ ...short, kind: 'shared' })).toBe(false)
  })

  it('busy holds say so; nothing left holds every download', () => {
    expect(downloadAllHeld(page(), { ...emptyModel(), all: { busy: true, done: 1, of: 2 } })).toEqual({ key: 'all.held.busy', params: { done: 1, of: 2 } })
    expect(downloadHeld(page(), { ...emptyModel(), downloads: { a: 'busy' } }, 'a')?.key).toBe('download.held.busy')
    expect(downloadHeld(page({ usesLeft: 0 }), emptyModel(), 'a')?.key).toBe('download.held.none')
    expect(usedUp(withUsesLeft(page(), 0))).toBe(true)
    expect(usedUp(withUsesLeft({ ...page(), kind: 'shared' }, 0))).toBe(false)
  })

  it('Download all is offered from two files that can still be downloaded', () => {
    expect(offersDownloadAll(page())).toBe(true)
    expect(offersDownloadAll(page({ files: page().files.map((file, index) => ({ ...file, available: index === 0 })) }))).toBe(false)
  })
})

describe('the password (5 tries, then held 15 minutes)', () => {
  it('reads the tries left from the wrong answer, and the hold from the 429', () => {
    expect(triesLeftOf('That password does not match. 3 tries left.')).toBe(3)
    expect(triesLeftOf('That password does not match.')).toBeNull()
    expect(triesLeftOf('99 tries')).toBeNull()
    const wrong = new ApiError('invalid', 400, 'validation_failed', 'x', null, [{ path: 'body/password', message: 'That password does not match. 1 try left.' }])
    expect(passwordProblemOf(wrong, NOW)).toEqual({ kind: 'wrong', triesLeft: 1 })
    const held = new ApiError('rate_limited', 429, 'rate_limited', 'x', null, [{ path: 'password/HELD', message: '2026-11-09T09:57:00.000Z' }, { path: 'retryAfter', message: '720' }])
    expect(passwordProblemOf(held, NOW)).toEqual({ kind: 'held', until: '2026-11-09T09:57:00.000Z' })
    expect(heldUntilOf(new ApiError('rate_limited', 429, 'rate_limited', 'x', null, [{ path: 'retryAfter', message: '60' }]), NOW)).toBe('2026-11-09T09:46:00.000Z')
    expect(passwordProblemOf(new ApiError('unavailable', 0, 'network', 'x'), NOW)).toEqual({ kind: 'failed' })
  })

  it('Open the files is held while checking, while held (until it passes) and with nothing typed', () => {
    const lockedPage = page({ password: { asked: true, unlocked: false, heldUntil: null }, files: [] })
    expect(locked(lockedPage)).toBe(true)
    const typed = { ...emptyModel(), password: { value: 'x', shown: false, busy: false, problem: null } }
    expect(unlockHeld(typed, lockedPage, NOW)).toBeNull()
    expect(unlockHeld({ ...typed, password: { ...typed.password, value: '' } }, lockedPage, NOW)?.key).toBe('password.held.empty')
    expect(unlockHeld({ ...typed, password: { ...typed.password, busy: true } }, lockedPage, NOW)?.key).toBe('password.held.busy')
    const heldArrival = page({ password: { asked: true, unlocked: false, heldUntil: '2026-11-09T09:57:00.000Z' }, files: [] })
    expect(standingHold(typed, heldArrival, NOW)).toBe('2026-11-09T09:57:00.000Z')
    expect(unlockHeld(typed, heldArrival, NOW)?.key).toBe('password.held.wait')
    expect(unlockHeld(typed, heldArrival, new Date('2026-11-09T09:58:00.000Z'))).toBeNull()
  })

  it('a 403 at `password` means the 30 minutes passed; the one 404 is a dead link', () => {
    expect(unlockPassed(new ApiError('forbidden', 403, 'forbidden', 'x', null, [{ path: 'password', message: 'Required.' }]))).toBe(true)
    expect(unlockPassed(new ApiError('forbidden', 403, 'forbidden', 'x'))).toBe(false)
    expect(stateOfReadError(new ApiError('not_found', 404, 'not_found', 'x'))).toBe('unavailable')
    expect(stateOfReadError(new ApiError('internal', 500, 'internal', 'x'))).toBe('error')
  })
})

describe('the receipt', () => {
  it('held while sending, behind the password, and past the longest name', () => {
    expect(receiptHeld(emptyModel(), page())).toBeNull()
    expect(receiptHeld({ ...emptyModel(), receipt: { name: '', busy: true, failed: false } }, page())?.key).toBe('receipt.held.busy')
    expect(receiptHeld(emptyModel(), page({ password: { asked: true, unlocked: false, heldUntil: null } }))?.key).toBe('receipt.held.locked')
    expect(receiptHeld({ ...emptyModel(), receipt: { name: 'x'.repeat(RECEIPT_NAME_MAX + 1), busy: false, failed: false } }, page())?.key).toBe('receipt.held.long')
  })
})

describe('words', () => {
  it('sizes, the checksum short, the payroll month in the reader’s language', () => {
    expect(sizeText(2_480_112, 'it')).toMatch(/2,4\s?MB/)
    expect(sizeText(48_201, 'en')).toMatch(/47\s?kB/i)
    expect(shortChecksum('0123456789abcdef'.repeat(4))).toBe('0123456789ab')
    expect(monthWords('2026-10', 'it')).toBe('ottobre 2026')
    expect(monthWords('2026-10', 'en')).toBe('October 2026')
  })

  it('every phrase the model says is in both catalogues, with the same placeholders', () => {
    const it = flat(catalogue('it'))
    const en = flat(catalogue('en'))
    expect(Object.keys(it).sort()).toEqual(Object.keys(en).sort())
    for (const key of ['all.held.uses', 'all.held.busy', 'download.held.busy', 'download.held.none', 'download.held.all', 'password.held.busy', 'password.held.wait', 'password.held.empty', 'receipt.held.busy', 'receipt.held.locked', 'receipt.held.long']) {
      expect(has(it, key), key).toBe(true)
      expect(has(en, key), key).toBe(true)
    }
  })
})

describe('the calls (the token in its header, the unlock key in its own, a key per write)', () => {
  it('sends the unlock key on reads and downloads, never in the address', async () => {
    const seen: Array<{ url: string; headers: Headers; method: string }> = []
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      seen.push({ url, headers: new Headers(init.headers), method: init.method ?? 'GET' })
      const body = url.includes('/download')
        ? { fileId: 'a', name: 'a.pdf', usesLeft: 4, download: { method: 'GET', url: '/local-files?token=x', headers: {}, expiresAt: '2026-11-09T09:46:00.000Z' } }
        : url.includes('/received')
          ? { receipt: { at: '2026-11-09T09:45:00.000Z', name: 'Studio Demo' } }
          : SET_ANSWER
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    const api = createApiClient({ baseUrl: '/api', linkToken: 'made-up-token', fetch: fetch as unknown as typeof globalThis.fetch })
    await readFileSet(api, 'lu1.made-up')
    const answer = await downloadSetFile(api, 'a', 'lu1.made-up', 'key-1')
    expect(answer.usesLeft).toBe(4)
    await confirmReceipt(api, 'Studio Demo', 'lu1.made-up', 'key-2')
    expect(seen.map((call) => call.headers.get(UNLOCK_HEADER))).toEqual(['lu1.made-up', 'lu1.made-up', 'lu1.made-up'])
    expect(seen.map((call) => call.headers.get('x-factory-link'))).toEqual(['made-up-token', 'made-up-token', 'made-up-token'])
    expect(seen.slice(1).map((call) => call.headers.get('idempotency-key'))).toEqual(['key-1', 'key-2'])
    expect(seen.every((call) => !call.url.includes('lu1') && !call.url.includes('made-up-token'))).toBe(true)
    await readFileSet(api, null)
    expect(seen.at(-1)!.headers.has(UNLOCK_HEADER)).toBe(false)
  })
})

const KEY = /\b(title|status|lead|logged|payroll|password|files|all|download|last|file|newer|preview|receipt|used|ask|drafts|loading|error)\.[a-zA-Z_-]+/

describe('the screens (SCR-272, SCR-101-set): no key on screen, the Italian page speaks Italian', () => {
  for (const screen of [designScreen, setScreen]) {
    it(`${screen.screen}: every case in both languages`, () => {
      for (const locale of ['it', 'en'] as const) {
        for (const entry of screen.cases) {
          const html = renderToStaticMarkup(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(screen.view, { model: entry.model })))
          expect(html, `${entry.id} (${locale})`).not.toMatch(KEY)
          expect(html, `${entry.id} (${locale})`).toContain('main-content')
          expect(html, `${entry.id} (${locale})`).not.toMatch(/\{[a-z]+\}/i)
        }
      }
    })
  }

  it('the secure file in Italian: the password first, then the files and the receipt', () => {
    const render = (id: string) =>
      renderToStaticMarkup(createElement(I18nProvider, { locale: 'it', messages: messagesFor('it', ['shell']) }, createElement(designScreen.view, { model: designScreen.cases.find((entry) => entry.id === id)!.model })))
    expect(render('password')).toContain('Apri i file')
    expect(render('password')).not.toContain('Scheda tecnica')
    expect(render('files')).toContain('Scarica tutti e 3')
    expect(render('files')).toContain('Ho ricevuto questi file')
    expect(render('uses-short')).toContain('ne restano 2')
    expect(render('payroll')).toContain('ottobre 2026')
    expect(render('payroll')).not.toMatch(/€|EUR/)
    expect(render('expired')).toContain('Chiedi un nuovo link')
  })
})

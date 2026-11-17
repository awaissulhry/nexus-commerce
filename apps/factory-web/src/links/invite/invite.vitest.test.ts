import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import { SHARE_HELD_REASONS, SHARE_PERMISSIONS } from '@nexus/factory-domain/shares/rules'
import { ApiError } from '../../lib/api/errors'
import { sharePageSchema } from './api'
import { designScreen } from './fixtures'
import { acceptOf, CODE_VALUES, daysLeft, FIELD_KEYS, fieldValueOf, pickedProblem, readRefusal, RECORD_TYPES, shownFields, threadOldestFirst, writeRefusal } from './model'
// ---- B-TH-274 (PL7)
import { render, textOf } from '../../lib/record-thread/parts/testing'
import { scanText } from '../../lib/testing/brand-scan'
import { BRAND_ALPHA, BRAND_BETA } from '../../lib/testing/two-brands'
import type { SharePage } from './api'
import { filesStrip, inviteLayout, START, STRIP_FILES, TWO_COLUMNS_FROM, type InviteViewModel } from './model'
import { InviteView } from './view/InviteView'
// ---- end B-TH-274

const catalogue = (locale: 'it' | 'en') => JSON.parse(readFileSync(new URL(`../../../messages/${locale}/link-invite.json`, import.meta.url), 'utf8')) as Record<string, unknown>
const flat = (tree: Record<string, unknown>, prefix = ''): Record<string, string> =>
  Object.fromEntries(Object.entries(tree).flatMap(([key, value]) => (typeof value === 'string' ? [[`${prefix}${key}`, value]] : Object.entries(flat(value as Record<string, unknown>, `${prefix}${key}.`)))))
const refused = (status: number, code: string, paths: string[] = []) => new ApiError(status === 404 ? 'not_found' : status === 403 ? 'forbidden' : status === 409 ? 'conflict' : status === 503 ? 'unavailable' : 'invalid', status, code, 'x', 'r', paths.map((path) => ({ path, message: 'x' })))

describe('SCR-270 Join a record (links.invite)', () => {
  it('says every shared field from its kind: codes in words, days, instants, numbers; empty values are left out', () => {
    expect(fieldValueOf({ key: 'status', kind: 'code', value: 'IN_PRODUCTION' })).toEqual({ kind: 'words', words: { key: 'code.status.IN_PRODUCTION' } })
    // A code the catalogue does not know is never shown as a key.
    expect(fieldValueOf({ key: 'status', kind: 'code', value: 'SOMETHING_NEW' })).toEqual({ kind: 'none' })
    expect(fieldValueOf({ key: 'orderDate', kind: 'date', value: '2026-10-28' })).toEqual({ kind: 'day', iso: '2026-10-28' })
    expect(fieldValueOf({ key: 'shippedAt', kind: 'instant', value: '2026-10-28T10:00:00.000Z' })).toEqual({ kind: 'instant', iso: '2026-10-28T10:00:00.000Z' })
    expect(fieldValueOf({ key: 'revision', kind: 'count', value: 2 })).toEqual({ kind: 'text', text: '2' })
    expect(shownFields([{ key: 'promiseDate', kind: 'date', value: null }, { key: 'number', kind: 'text', value: 'SO-1' }]).map((field) => field.key)).toEqual(['number'])
  })

  it('reads the thread oldest first without repeats, counts the days left, and checks a picked file before sending', () => {
    const message = (id: string, at: string) => ({ id, side: 'COMPANY' as const, channel: 'EMAIL', author: { name: null, mine: false }, body: '', attachments: [], at })
    expect(threadOldestFirst([message('b', '2026-11-02T00:00:00Z'), message('a', '2026-11-01T00:00:00Z')], [message('a', '2026-11-01T00:00:00Z'), message('z', '2026-10-30T00:00:00Z')]).map((row) => row.id)).toEqual(['z', 'a', 'b'])
    const now = Date.parse('2026-11-10T09:00:00Z')
    expect(daysLeft('2026-11-30T09:00:00Z', now)).toBe(20)
    expect(daysLeft('2026-11-10T15:00:00Z', now)).toBe(0)
    const page = { upload: { canUpload: true, held: null, contentTypes: ['application/pdf', 'image/png'], maxBytes: 1_048_576 } }
    expect(pickedProblem({ size: 10, type: 'application/pdf' }, page)).toBeNull()
    expect(pickedProblem({ size: 2_000_000, type: 'application/pdf' }, page)).toEqual({ key: 'files.problem.size', params: { mb: 1 } })
    expect(pickedProblem({ size: 10, type: 'video/quicktime' }, page)).toEqual({ key: 'files.problem.type' })
    expect(acceptOf(['application/pdf', 'image/jpeg', 'application/x-unknown'])).toBe('.pdf,.jpg,.jpeg')
  })

  it('says the API\'s refusals in its own words: a narrowed share reads again, a revoked one is the dead link', () => {
    expect(readRefusal(refused(404, 'not_found'))).toBe('unavailable')
    expect(readRefusal(new Error('offline'))).toBe('error')
    expect(writeRefusal(refused(403, 'forbidden', ['held/NO_COMMENT']))).toEqual({ words: { key: 'held.NO_COMMENT' }, reload: true })
    expect(writeRefusal(refused(404, 'not_found'))).toEqual({ words: { key: 'problem.gone' }, link: 'unavailable' })
    expect(writeRefusal(refused(503, 'not_ready')).words.key).toBe('files.problem.closed')
    expect(writeRefusal(refused(400, 'validation_failed', ['body/contentType'])).words.key).toBe('files.problem.type')
    expect(writeRefusal(refused(409, 'conflict', ['refusal/STALE']))).toEqual({ words: { key: 'problem.changed' }, reload: true })
  })

  it('has words in Italian and English for every record type, field, code, permission and held reason, and the same keys in both', () => {
    const it_ = flat(catalogue('it'))
    const en = flat(catalogue('en'))
    expect(Object.keys(it_).sort()).toEqual(Object.keys(en).sort())
    const needed = [
      ...RECORD_TYPES.map((type) => `type.${type}`),
      ...FIELD_KEYS.map((key) => `field.${key}`),
      ...Object.entries(CODE_VALUES).flatMap(([field, values]) => values.map((value) => `code.${field}.${value}`)),
      ...SHARE_PERMISSIONS.map((permission) => `may.${permission}`),
      ...SHARE_HELD_REASONS.map((reason) => `held.${reason}`),
    ]
    for (const key of needed) {
      expect(it_[key], `it ${key}`).toBeTruthy()
      expect(en[key], `en ${key}`).toBeTruthy()
    }
  })

  it('its design cases are made-up pages the API could answer', () => {
    for (const item of designScreen.cases) if (item.model.page) expect(() => sharePageSchema.parse(item.model.page), item.id).not.toThrow()
    expect(designScreen.cases.map((item) => item.id)).toEqual(expect.arrayContaining(['record', 'read-only', 'loading', 'error', 'withdrawn']))
  })
})

// ---- B-TH-274 (threads plan TH-6, PL7; L-INVITE.side, L-INVITE.thread; walls W08, W24, W25): the thread as the main column ------
const caseModel = (id: string): InviteViewModel => designScreen.cases.find((item) => item.id === id)!.model
const draw = (model: InviteViewModel, locale: 'it' | 'en' = 'en') => render(createElement(InviteView, { model }), locale)
const css = readFileSync(new URL('./invite.css', import.meta.url), 'utf8')
/** The html of the side column (the `<aside>`), and the rest of the page without it. */
const split = (html: string) => {
  const start = html.indexOf('<aside class="fw-inv-side"')
  const end = html.indexOf('</aside>', start)
  return { side: html.slice(start, end), rest: html.slice(0, start) + html.slice(end) }
}

describe('B-TH-274 — two columns from 1280 px: the thread main, the side column beside it, behind "i" narrower', () => {
  it('the layout rule: two columns from 1280 px, the thread as the whole page below; the CSS follows it and drops the frame’s phone width only there', () => {
    expect(TWO_COLUMNS_FROM).toBe(1280)
    expect(inviteLayout(1920)).toBe('two-columns')
    expect(inviteLayout(1280)).toBe('two-columns')
    expect(inviteLayout(1279)).toBe('thread-page')
    expect(inviteLayout(375)).toBe('thread-page')
    const wide = css.slice(css.indexOf('@media (min-width: 1280px)'))
    expect(wide).toMatch(/\.fw-link:has\(\.fw-inv-page\) \{\s*max-width: none;/)
    expect(wide).toMatch(/grid-template-columns: minmax\(0, 2fr\) minmax\(320px, 1fr\)/)
    expect(wide).toMatch(/\.fw-inv-bar \{\s*display: none;/)
    // Below 1280 px the side column is not on the page (it waits behind "i").
    expect(css.slice(0, css.indexOf('@media (min-width: 1280px)'))).toMatch(/\.fw-inv-side \{\s*display: none;/)
  })

  it('the thread is the main column (files strip, conversation, Add files); the side column holds Why you are here, the record and E-mail me', () => {
    const html = draw(caseModel('record'))
    const { side, rest } = split(html)
    expect(html.indexOf('class="fw-inv-main"')).toBeGreaterThan(-1)
    expect(html.indexOf('class="fw-inv-main"')).toBeLessThan(html.indexOf('<aside class="fw-inv-side"'))
    expect(html.match(/<aside/g)?.length).toBe(1)
    expect(side).toContain('aria-label="About this invitation"')
    const sideText = textOf(side)
    for (const words of ['Why you are here', 'What you can do', 'The record', 'Our number', 'E-mail me']) expect(sideText).toContain(words)
    const mainText = textOf(rest)
    for (const words of ['Messages', 'Files', 'Add files']) expect(mainText).toContain(words)
    expect(sideText).not.toContain('Add files')
    expect(sideText).not.toContain('Messages')
  })

  it('files in ONE place: no Shared files card; the strip names the files (never the side column); the Files view lists them all, newest first', () => {
    const model = caseModel('record')
    const html = draw(model)
    const { side } = split(html)
    expect(textOf(html)).not.toContain('Shared files')
    expect(html.match(/class="fw-inv-strip"/g)?.length).toBe(1)
    expect(html).not.toContain('class="fw-inv-files"')
    for (const file of model.page!.files) expect(textOf(side)).not.toContain(file.originalName)
    const files = model.page!.files
    const strip = filesStrip([...files, files[0]!])
    expect(strip.all.map((file) => file.id)).toEqual([...files].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).map((file) => file.id))
    expect(strip.shown.length).toBe(Math.min(STRIP_FILES, files.length))
    expect(strip.more).toBe(Math.max(0, files.length - STRIP_FILES))
    const many = caseModel('many-files')
    expect(filesStrip(many.page!.files).more).toBe(many.page!.files.length - STRIP_FILES)
    expect(textOf(draw(many))).toContain(`+${many.page!.files.length - STRIP_FILES} more · all ${many.page!.files.length} files`)
    expect(textOf(draw({ ...model, page: { ...model.page!, files: [] } }))).toContain('No files shared yet.')
  })

  it('narrower than 1280 px the side column waits behind "About this invitation" (a sheet); the Files view is a pop-up too', () => {
    const html = draw(caseModel('record'))
    expect(html).toContain('class="fw-inv-bar"')
    expect(textOf(html)).toContain('About this invitation')
    expect(html).toMatch(/aria-haspopup="dialog"[^>]*>(?:(?!<\/button>).)*About this invitation/)
    expect(caseModel('phone-side').sheet).toBe('side')
    expect(caseModel('files-view').sheet).toBe('files')
    // The E-mail me switch is drawn in the side column and again in the sheet: each copy has its own id.
    const view = readFileSync(new URL('./view/InviteView.tsx', import.meta.url), 'utf8')
    expect(view).toContain('const id = `fw-inv-notify-${useId()')
    const container = readFileSync(new URL('./InviteLink.tsx', import.meta.url), 'utf8')
    expect(container).toContain("onSheet: (sheet) => setModel((now) => ({ ...now, sheet })),")
    expect(container).toContain('(min-width: ${TWO_COLUMNS_FROM}px)')
    expect(START.sheet).toBeNull()
  })

  it('read only: writing and Add files are held with the reason (no box, no drop zone), the page still reads', () => {
    const text = textOf(draw(caseModel('read-only')))
    expect(text).toContain('Your invitation lets you read this record, not write on it.')
    expect(text).toContain('Your invitation does not let you add files.')
    expect(text).not.toContain('Add files')
    expect(text).toContain('Why you are here')
  })

  it('E-mail me is on by default (their own switch) and says so; off says so too', () => {
    const on = draw(caseModel('record'))
    expect(on).toMatch(/role="switch"[^>]*aria-checked="true"/)
    expect(textOf(on)).toContain('On: new messages on this record come by e-mail')
    expect(textOf(draw(caseModel('notify-off')))).toContain('Off: you see new messages only on this page')
  })

  it('the words are in Italian and English', () => {
    for (const locale of ['it', 'en'] as const) {
      const words = flat(catalogue(locale))
      for (const key of ['side.title', 'side.open', 'files.title', 'files.all_one', 'files.all_other', 'files.allMore', 'files.viewTitle']) expect(words[key], `${locale} ${key}`).toBeTruthy()
    }
    expect(textOf(draw(caseModel('record'), 'it'))).toContain("Informazioni sull'invito")
  })
})

describe('B-TH-274 — the brand wall (W24, W25): a Brand Beta invitation shows nothing of Brand Alpha', () => {
  const at = (hours: number) => new Date(Date.parse('2026-11-10T09:00:00.000Z') + hours * 3_600_000).toISOString()
  const betaPage = (): SharePage => ({
    share: { id: BRAND_BETA.ids.thread, permissions: ['VIEW', 'COMMENT', 'UPLOAD'], notifyByEmail: true, expiresAt: at(20 * 24), invitedAt: at(-72), invitedBy: 'Carlo Prova', version: 1 },
    from: { companyName: 'Studio Demo' },
    record: {
      type: 'SalesOrder',
      reference: BRAND_BETA.numbers.order,
      theirRef: BRAND_BETA.customerRef,
      fields: [
        { key: 'number', kind: 'text', value: BRAND_BETA.numbers.order },
        { key: 'theirRef', kind: 'text', value: BRAND_BETA.customerRef },
        { key: 'status', kind: 'code', value: 'IN_PRODUCTION' },
      ],
    },
    files: [{ id: BRAND_BETA.ids.file, kind: 'DOCUMENT', originalName: BRAND_BETA.fileName, contentType: 'application/pdf', sizeBytes: 120_000, at: at(-30), mine: false }],
    thread: {
      status: 'OPEN',
      shared: true,
      messages: [{ id: 'b2b2b2b2-0000-4000-8000-000000000299', side: 'PARTNER', channel: 'PORTAL', author: { name: BRAND_BETA.portalPerson.name, mine: true }, body: BRAND_BETA.message, attachments: [], at: at(-2) }],
      nextCursor: null,
      canPost: true,
      held: null,
      replyByEmail: true,
    },
    upload: { canUpload: true, held: null, contentTypes: ['application/pdf'], maxBytes: 25 * 1_048_576 },
    locale: 'en',
  })

  it('every part — the thread, the files strip, the side column, the Files view’s case — holds only its own record’s party', () => {
    const page = betaPage()
    expect(() => sharePageSchema.parse(page)).not.toThrow()
    for (const sheet of [null, 'side', 'files'] as const) {
      for (const locale of ['it', 'en'] as const) {
        const html = draw({ ...START, page, now: Date.parse('2026-11-10T09:00:00.000Z'), timeZone: 'Europe/Rome', sheet }, locale)
        expect(scanText(textOf(html), BRAND_ALPHA), `${locale} ${sheet}`).toEqual([])
        expect(scanText(html, BRAND_ALPHA), `${locale} ${sheet} (markup)`).toEqual([])
        // It does show its own record (the scan is not empty because nothing was drawn).
        expect(textOf(html)).toContain(BRAND_BETA.fileName)
        expect(textOf(html)).toContain(BRAND_BETA.message)
      }
    }
  })
})
// ---- end B-TH-274

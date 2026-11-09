import { describe, expect, it } from 'vitest'
import type { PublicDocFile } from '@nexus/factory-domain/compliance/public-doc/contracts'
import { ApiError } from '../../lib/api/errors'
import { designScreen } from './fixtures'
import { careText, chooseLanguage, codeProblem, fileIn, frameSender, lookupRefusal, monthOf, publicDocFileUrl, readerFirst, readerLanguages, retryAfterMs, spanMonths, styleName, waitParts, wantsChallenge } from './model'

const file = (language: string): PublicDocFile => ({ language, fileId: `0190f0e2-7101-7000-8000-00000000000${language.length}`, name: `${language}.pdf`, sizeBytes: 1, sha256: 'a'.repeat(64), number: null, issuedOn: null })

describe('the public DoC page (SCR-102)', () => {
  it('reads the declaration in the reader’s language: the browser’s first, then the page’s, then English and Italian', () => {
    expect(readerLanguages(['de-CH', 'fr', 'de'], 'it')).toEqual(['de', 'fr', 'it', 'en'])
    expect(readerLanguages([], 'en')).toEqual(['en', 'it'])
    expect(readerLanguages(['x-klingon', 'pt_BR'], 'it')).toEqual(['pt', 'it', 'en'])
    const files = [file('it'), file('en'), file('de')]
    expect(chooseLanguage(files, ['de', 'it', 'en'])).toBe('de')
    expect(chooseLanguage(files, ['fr', 'en'])).toBe('en')
    expect(chooseLanguage([file('es')], ['fr', 'en', 'it'])).toBe('es')
    expect(chooseLanguage([], ['it'])).toBeNull()
    expect(fileIn(files, 'en')?.language).toBe('en')
    expect(fileIn(files, 'nl')?.language).toBe('it')
    expect(readerFirst(files, ['de', 'it']).map((entry) => entry.language)).toEqual(['de', 'it', 'en'])
  })

  it('says the care lines and the style’s name in the reader’s language, else what there is', () => {
    expect(careText({ symbol: 'wash-not', text: { it: 'Non lavare', en: 'Do not wash' } }, ['de', 'en'])).toBe('Do not wash')
    expect(careText({ symbol: 'wash-not', text: { fr: 'Ne pas laver' } }, ['it', 'en'])).toBe('Ne pas laver')
    expect(careText({ symbol: 'wash-not', text: {} }, ['it'])).toBe('wash-not')
    const page = designScreen.cases[0]!.model.page!
    expect(styleName(page, ['en', 'it'])).toBe('Demo Jacket')
    expect(styleName(page, ['it'])).toBe('Giacca Demo')
  })

  it('checks a typed code before sending it', () => {
    expect(codeProblem('  ')).toBe('required')
    expect(codeProblem('7K3Q-M2')).toBe('format')
    expect(codeProblem('7k3q m2xa')).toBeNull()
    expect(codeProblem('https://factory.example.com/doc/7K3QM2XA')).toBeNull()
  })

  it('turns a refusal into the page’s state: unknown, a wait in words, a failed check, or the error card', () => {
    const notFound = new ApiError('not_found', 404, 'not_found', 'x')
    expect(lookupRefusal(notFound, false)).toEqual({ kind: 'lookup', problem: 'unknown', waitMs: null })
    const wait = new ApiError('rate_limited', 429, 'rate_limited', 'x', null, [{ path: 'retryAfter', message: '230' }])
    expect(retryAfterMs(wait)).toBe(230_000)
    expect(lookupRefusal(wait, false)).toEqual({ kind: 'lookup', problem: null, waitMs: 230_000 })
    expect(waitParts(230_000)).toEqual({ unit: 'minutes', count: 4 })
    expect(waitParts(12_300)).toEqual({ unit: 'seconds', count: 13 })
    const challenge = new ApiError('rate_limited', 429, 'rate_limited', 'x', null, [{ path: 'challenge', message: 'solve' }])
    expect(wantsChallenge(challenge)).toBe(true)
    expect(lookupRefusal(challenge, true)).toEqual({ kind: 'lookup', problem: 'checkFailed', waitMs: null })
    expect(lookupRefusal(new ApiError('unavailable', 503, 'not_ready', 'x'), false)).toEqual({ kind: 'error' })
    expect(lookupRefusal(new ApiError('unavailable', 0, 'network', 'x'), true)).toEqual({ kind: 'lookup', problem: 'checkFailed', waitMs: null })
  })

  it('writes months and spans in the page’s language, and the PDFs’ permanent addresses', () => {
    expect(monthOf('2026-09-15', 'en')).toBe('September 2026')
    expect(monthOf('2026-09-15', 'it')).toBe('settembre 2026')
    expect(spanMonths({ first: '2026-09-01', last: '2026-09-30' }, 'en')).toEqual({ one: 'September 2026' })
    expect(spanMonths({ first: '2025-03-10', last: '2026-09-01' }, 'en')).toEqual({ from: 'March 2025', to: 'September 2026' })
    expect(publicDocFileUrl('7K3QM2XA', 'f1')).toBe('/api/public/doc/7K3QM2XA/files/f1')
    expect(publicDocFileUrl('7K3QM2XA', 'f1', true)).toBe('/api/public/doc/7K3QM2XA/files/f1?download=1')
  })

  it('heads the frame with the company and whom to ask', () => {
    const page = designScreen.cases[0]!.model.page!
    expect(frameSender(page)).toMatchObject({ companyId: page.sender.companyId, name: 'Officina Demo S.r.l.', logoUrl: null, contact: { name: 'Officina Demo S.r.l.', email: 'qualita@officina-demo.example' } })
    expect(frameSender({ ...page, contact: { email: null } }).contact).toBeNull()
  })

  it('has a design case for every state of the page', () => {
    const ids = designScreen.cases.map((entry) => entry.id)
    for (const id of ['batch-current', 'batch-earlier', 'style-current', 'not-published', 'not-ppe', 'loading', 'loading-slow', 'error', 'lookup', 'lookup-unknown', 'lookup-wait', 'lookup-checking', 'pdf-failed']) expect(ids).toContain(id)
    // Every case's page is a page the API could send (the contract parses it).
    for (const entry of designScreen.cases) if (entry.model.page) expect(entry.model.page.code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/)
  })
})

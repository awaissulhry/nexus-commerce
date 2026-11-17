import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CATALOGUE, messagesFor } from '../../../../../../lib/i18n/messages'
import { I18nProvider } from '../../../../../../lib/i18n/provider'
import { PROSPECT_VIEW, VIEW } from '../../../demo/fixtures'
import { NAMESPACES } from '../../../model'
import { carriableFiles, startBodyOf, startDraftOf, startProblems, startProjectHeld, startRefusalKey, type StartProjectModel } from '../../../start-project'
import { paneMenu } from '../RequestPane'
import { StartProjectDialog } from './StartProjectDialog'

/**
 * B-TH-252 — "Start a project…" from an Incoming request (PROJ.new-F07; O-SAL-INQ-LIST.pane-actions; wall W38): in ⋯, never a sixth
 * main action; the project's outside company is the REQUEST's customer — never sent, never a choice; a prospect's request is held
 * until it is matched; the request's files carried when ticked. (Written in the build; run at the end check.)
 */

const render = (model: StartProjectModel, locale: 'en' | 'it' = 'en') =>
  renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, [...NAMESPACES, 'shell', 'ds']) }, createElement(StartProjectDialog, { model })))

const dialogOf = (over: Partial<StartProjectModel> = {}): StartProjectModel => ({
  number: VIEW.number,
  customer: VIEW.party?.name ?? 'Brand Alpha',
  draft: startDraftOf(VIEW),
  files: carriableFiles(VIEW),
  busy: false,
  notice: null,
  offline: false,
  ...over,
})

describe('Start a project from a request', () => {
  it('is a line of ⋯ (after Edit), never a main action, and only for a person who reads projects', () => {
    expect(paneMenu(VIEW, 'pane', { erase: false, closeThread: false }, true, true)).toEqual(['full', 'print', 'edit', 'project', 'copy'])
    expect(paneMenu(VIEW, 'pane', { erase: false, closeThread: false }, true)).not.toContain('project')
  })

  it('is held with why: no right to keep projects, a prospect (match it first), or without reading conversations', () => {
    expect(startProjectHeld(VIEW, { manage: true, read: true })).toBeNull()
    expect(startProjectHeld(VIEW, { manage: false, read: true })).toBe('project.held.right')
    expect(startProjectHeld(PROSPECT_VIEW, { manage: true, read: true })).toBe('project.held.prospect')
    expect(startProjectHeld(VIEW, { manage: true, read: false })).toBe('project.held.read')
  })

  it('carries the request’s customer by the request itself: the body never names an outside company', () => {
    const body = startBodyOf({ ...startDraftOf(VIEW), targetDate: '2027-03-01', goal: '  ' })
    expect(body).not.toHaveProperty('partyId')
    expect(body).not.toHaveProperty('goal')
    expect(body.targetDate).toBe('2027-03-01')
    expect(startBodyOf({ name: '', targetDate: '2027-03-01', goal: '', fileIds: [] })).toEqual({ targetDate: '2027-03-01' })
  })

  it('starts with the subject as the name and every available file ticked; asks a target date not in the past', () => {
    const draft = startDraftOf(VIEW)
    expect(draft.name.length).toBeGreaterThan(0)
    expect(draft.targetDate).toBe('')
    expect(draft.fileIds).toEqual(carriableFiles(VIEW).map((file) => file.id))
    expect(startProblems(draft, '2026-11-17')).toContain('project.problem.target')
    expect(startProblems({ ...draft, targetDate: '2026-11-01' }, '2026-11-17')).toContain('project.problem.targetPast')
    expect(startProblems({ ...draft, targetDate: '2026-12-01' }, '2026-11-17')).toEqual([])
  })

  it('says a refusal from its code in the pane’s words', () => {
    expect(startRefusalKey('NO_PARTY_REQUEST')).toBe('project.refusal.NO_PARTY_REQUEST')
    expect(startRefusalKey('PARTY_BLOCKED')).toBe('project.refusal.PARTY_BLOCKED')
    expect(startRefusalKey('SOMETHING_ELSE')).toBeNull()
  })

  it('names the request’s customer only — set once — in Italian and English, with no raw key', () => {
    for (const locale of ['en', 'it'] as const) {
      const html = render(dialogOf(), locale)
      expect(html, locale).toContain(VIEW.party?.name ?? 'Brand Alpha')
      expect(html, locale).not.toMatch(/\bproject\.[a-zA-Z]+/)
      // A choice of outside company is never offered: the customer is said, not picked.
      expect(html, locale).not.toMatch(/<select/)
    }
    expect(render(dialogOf({ notice: { key: 'project.refusal.NO_PARTY_REQUEST' } }))).toContain('match it to its customer first')
  })

  it('has every word in Italian and English with the same placeholders', () => {
    const en = CATALOGUE.en['sales-inquiries'] ?? {}
    const it = CATALOGUE.it['sales-inquiries'] ?? {}
    const keys = Object.keys(en).filter((key) => key.startsWith('project.'))
    expect(keys.length).toBeGreaterThan(20)
    const holes = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort()
    for (const key of keys) {
      expect(it[key], key).toBeTruthy()
      expect(holes(it[key] ?? ''), key).toEqual(holes(en[key] ?? ''))
    }
  })
})

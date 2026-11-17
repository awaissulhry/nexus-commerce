import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { ComponentType } from 'react'
import { describe, expect, it } from 'vitest'
import { CATALOGUE } from '../../../../lib/i18n/messages'
import type { CardMessage } from '../../../../lib/record-thread/card/model'
import { everyCase, leftKeys, renderView, textOf } from '../../../../lib/record-thread/parts/testing'
import { BRAND_ALPHA } from '../../../../lib/testing/two-brands'
import { designScreen } from './fixtures'
import { carriesOfficeNotes, paperFeed, paperFiles } from './model'

/**
 * B-TH-280 — the record's thread on paper replaces the old record panels' print form: the docked thread's feed read-only (every
 * message open, nothing to answer, correct, task or carry), "Contains office notes" at the head and the foot (T1-F09), the record's
 * documents in force, a locked measurement sheet by its lock words only; the container is the docked thread's own and touches no
 * draft and marks nothing read; no page mounts the old panels any more.
 */

const SRC = new URL('../../../../', import.meta.url).pathname
const view = designScreen.view as ComponentType<{ model: unknown }>
const caseOf = (id: string) => designScreen.cases.find((item) => item.id === id)!.model
const card = (id: string, kind: CardMessage['kind']): Pick<CardMessage, 'id' | 'kind'> => ({ id, kind })

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sources(path)
    return /\.(ts|tsx)$/.test(name) && !/\.vitest\.test\.ts$/.test(name) ? [path] : []
  })
}

describe('the feed for paper', () => {
  const fixture = caseOf('normal') as { paper: { feed: Parameters<typeof paperFeed>[0] } }
  const feed = fixture.paper.feed

  it('opens every message and drops the screen-only lines (fold by age, new since, new bar, link anchor, hidden by a view)', () => {
    const paper = paperFeed({ ...feed, runOpen: false, openIds: [], firstNewId: 'm1', newSince: 3, newCount: 2, hiddenNew: 4, context: { ...feed.context, anchorId: 'm2' } })
    expect(paper.runOpen).toBe(true)
    expect(paper.openIds).toEqual(feed.messages.map((message) => message.id))
    expect(paper).toMatchObject({ firstNewId: null, newSince: 0, newCount: 0, hiddenNew: 0 })
    expect(paper.context.anchorId).toBeNull()
  })

  it('offers nothing to act on: no reply, task, carry or correction', () => {
    const paper = paperFeed({ ...feed, context: { ...feed.context, canReply: true, canTask: true, canUseOn: true, canCorrect: { note: true, email: true, portal: true } } })
    expect(paper.context).toMatchObject({ canReply: false, canTask: false, canUseOn: false, canCorrect: { note: false, email: false, portal: false } })
    expect(paper.context.canReadFiles).toBe(feed.context.canReadFiles)
    expect(paper.messages).toBe(feed.messages)
  })

  it('says it carries office notes only when a note prints', () => {
    expect(carriesOfficeNotes([card('a', 'theirs'), card('b', 'note')])).toBe(true)
    expect(carriesOfficeNotes([card('a', 'theirs'), card('b', 'ours'), card('c', 'floor')])).toBe(false)
    expect(carriesOfficeNotes([])).toBe(false)
  })

  it('prints the record’s own documents in force (another record’s file never)', () => {
    const files = [
      { id: 'f1', recordType: 'SalesOrder', recordId: 'o1', name: 'a.pdf', contentType: 'application/pdf', kind: 'DOCUMENT' as const, sizeBytes: 1, status: 'AVAILABLE' as const, quarantineReason: null, visibility: ['OFFICE' as const], partyId: null, createdAt: '2026-11-01T09:00:00Z', previewUrl: null },
      { id: 'f2', recordType: 'SalesOrder', recordId: 'o2', name: 'b.pdf', contentType: 'application/pdf', kind: 'DOCUMENT' as const, sizeBytes: 1, status: 'AVAILABLE' as const, quarantineReason: null, visibility: ['OFFICE' as const], partyId: null, createdAt: '2026-11-01T09:00:00Z', previewUrl: null },
      { id: 'f3', recordType: 'SalesOrder', recordId: 'o1', name: 'gone.pdf', contentType: 'application/pdf', kind: 'DOCUMENT' as const, sizeBytes: 1, status: 'DELETED' as const, quarantineReason: null, visibility: ['OFFICE' as const], partyId: null, createdAt: '2026-11-01T09:00:00Z', previewUrl: null },
    ]
    expect(paperFiles(files, { type: 'SalesOrder', id: 'o1' }).map((series) => series.latest.id)).toEqual(['f1'])
  })
})

describe('the paper (SCR-006-print)', () => {
  it('every case in Italian and English, no key left on screen', () => {
    for (const [locale, id, html] of everyCase(designScreen)) expect(leftKeys(html, ['print', 'locked', 'audience', 'kind', 'version', 'keep', 'feed', 'card']), `${id} (${locale})`).toEqual([])
  })

  it('every print word exists in both languages', () => {
    // A namespace's keys are flat paths (lib/i18n/messages flattenMessages): `print.title`.
    const printKeys = (records: Readonly<Record<string, string>> | undefined) => Object.keys(records ?? {}).filter((key) => key.startsWith('print.')).map((key) => key.slice('print.'.length)).sort()
    const en = printKeys(CATALOGUE.en.records)
    const it = printKeys(CATALOGUE.it.records)
    expect(en).toEqual(['conversation', 'files', 'filesNone', 'notes', 'title'])
    expect(it).toEqual(en)
  })

  it('draws the conversation with the docked thread’s cards and says it carries office notes at the head and the foot', () => {
    const text = textOf(renderView(view, caseOf('normal')))
    expect(text).toContain(`Thread of ${BRAND_ALPHA.numbers.order} · ${BRAND_ALPHA.tradeName}`)
    expect(text.match(/Contains office notes/g)?.length).toBe(2)
    expect(text).toContain('Conversation')
    expect(text).toContain(BRAND_ALPHA.fileName)
  })

  it('a paper without notes has no office-notes line', () => {
    expect(textOf(renderView(view, caseOf('shared-only')))).not.toContain('Contains office notes')
  })

  it('a locked measurement sheet prints by its lock words, never by its name', () => {
    const text = textOf(renderView(view, caseOf('locked-sheet')))
    expect(text).toContain('Measurement sheet — you cannot open it')
    expect(text).not.toContain('Rider measurements.pdf')
  })

  it('no Files part without the files right; nothing to act on in the cards', () => {
    const html = renderView(view, caseOf('no-files-right'))
    expect(textOf(html)).not.toContain('Files (')
    expect(html).not.toContain('fw-rt-cx-text')
    expect(html).not.toContain('Reply to')
  })
})

describe('the container (ThreadPrint.tsx) and the pages', () => {
  const container = readFileSync(new URL('../ThreadPrint.tsx', import.meta.url), 'utf8')
  const hook = readFileSync(new URL('../use-record-thread.ts', import.meta.url), 'utf8')

  it('is the docked thread’s own container, read-only: no draft, no leave guard, no "seen" report', () => {
    expect(container).toContain('useRecordThread({ record, title, recordLabel: title, party, readOnly: true })')
    expect(container).not.toContain('onSeen')
    expect(hook).toContain('if (host.readOnly) return // B-TH-280')
    expect(hook).toContain("useLeaveGuard(host.readOnly ? { text: '', files: 0 }")
    // B-TH-287's server draft too: the print form never reads it and never becomes ready to save (four guards in all).
    expect(hook).toMatch(/B-TH-280: the print form \(ThreadPrint\) neither reads nor saves the server's draft[^\n]*\n\s*if \(host\.readOnly\) return/)
    expect(hook.match(/host\.readOnly/g)?.length).toBeGreaterThanOrEqual(4)
  })

  it('no file mounts the old record panels or their views any more (B-TH-280)', () => {
    for (const file of sources(SRC)) {
      const source = readFileSync(file, 'utf8')
      expect(source, file).not.toMatch(/record-panels\/(RecordPanels|view\/|fixtures'|print\/)/)
      expect(source, file).not.toMatch(/<RecordPanels\b|RecordPanelsView|RecordPanelsViewModel|RecordPanelsActions/)
    }
  })

  it('the old dock copies are gone: no own thread dock, ⌘J dock hook or dock CSS besides the record frame’s (B-TH-280)', () => {
    for (const file of sources(SRC)) {
      const source = readFileSync(file, 'utf8')
      // Code, not the comments that say a hook went (B-TH-265, B-TH-268 name `useThreadDock` in theirs).
      const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '')
      expect(code, file).not.toMatch(/useThreadDock|useRecordDock|'record\.dockHint'|'record\.noPanels'|fw-q-record-dock|has-dock/)
    }
    const quality = readFileSync(join(SRC, 'areas/quality/_shared/quality.css'), 'utf8')
    expect(quality).not.toMatch(/has-dock|fw-q-record-dock|fw-q-keys/)
  })

  it('every record page prints its thread with ThreadPrint under its body', () => {
    const pages = sources(join(SRC, 'areas')).filter((file) => readFileSync(file, 'utf8').includes('printThread'))
    const mounting = pages.filter((file) => readFileSync(file, 'utf8').includes('<ThreadPrint '))
    expect(mounting.length).toBeGreaterThanOrEqual(40)
  })
})

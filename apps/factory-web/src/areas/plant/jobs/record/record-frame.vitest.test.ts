import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { ComponentType } from 'react'
import { renderView, textOf } from '../../../../lib/record-thread/parts/testing'
import { JOB_TABS, jobTabOf, MERGED_JOB_TABS } from '../view-model'
import { designScreen } from './fixtures'

/**
 * B-TH-265 — the maintenance job on RecordFrame (O-PLT-JOB; the rule of picture 38, 08-tabs O-PLT-JOB): the band in the shell's row
 * with ONE state pill, the job's thread docked beside both tabs (notes only: a job has no party), Activity's tools in the thread's "⋯"
 * (R-ACT), one notice, tabs 4 → 2 — Problem & photos (both bodies as they are: before / after is a category the Files view does not
 * show, the requests' photos live on other records), Hand-back — with every old address kept (R-8).
 */

const view = designScreen.view as ComponentType<{ model: unknown }>
const draw = (id: string, locale: 'it' | 'en' = 'en') => renderView(view, designScreen.cases.find((item) => item.id === id)!.model, locale)
const dockOf = (html: string) => html.slice(html.indexOf('class="fw-rcf-dock"'))

describe('B-TH-265 — the maintenance job on RecordFrame', () => {
  it('two tabs: Problem & photos · Hand-back; every old ?tab= keeps working (Photos, Activity → Problem & photos)', () => {
    expect(JOB_TABS).toEqual(['problem', 'handback'])
    expect(MERGED_JOB_TABS).toEqual({ photos: 'problem', activity: 'problem' })
    expect(jobTabOf('photos')).toBe('problem')
    expect(jobTabOf('activity')).toBe('problem')
    expect(jobTabOf('handback')).toBe('handback')
    expect(jobTabOf(null)).toBe('problem')
    expect(jobTabOf('hasOwnProperty')).toBe('problem')
    const text = textOf(draw('thread-docked'))
    expect(text).toContain('Problem & photos')
    expect(text).toContain('Hand-back')
    expect(text).not.toMatch(/\bActivity\b/)
    expect(textOf(draw('thread-docked', 'it'))).toContain('Problema e foto')
  })

  it('Problem & photos draws the Problem body, then the Photos body as it is (before / after kept)', () => {
    const source = readFileSync(new URL('./view/JobRecordView.tsx', import.meta.url), 'utf8')
    expect(source).toMatch(/<ProblemTab [^>]*\/>\s*<PhotosTab /)
    expect(source).not.toContain("model.tab === 'photos'")
    expect(source).not.toContain("model.tab === 'activity'")
  })

  it('ONE thread docked beside both tabs; its "⋯" holds Activity’s tools (R-ACT)', () => {
    for (const id of ['thread-docked', 'thread-handback', 'photos', 'handed-back']) {
      const html = draw(id)
      expect(html.match(/class="fw-rcf-dock"/g)?.length, id).toBe(1)
      expect(html, id).toContain('aria-label="Thread tools"')
      expect(html, id).not.toContain('fw-rp-tabs')
    }
  })

  it('a job has no party: Office notes only — no "Reply to", no e-mail in its thread', () => {
    const dock = textOf(dockOf(draw('thread-docked')))
    expect(dock).not.toMatch(/Reply to (?!the customer)/)
    expect(dock).not.toMatch(/@[a-z0-9-]+\.example/)
  })

  it('without threads.read there is no thread here: no dock, no Thread button', () => {
    const html = draw('thread-no-right')
    expect(html).not.toContain('class="fw-rcf-dock"')
    expect(html).not.toContain('aria-label="Thread tools"')
  })

  it('one notice in the body column, never above the thread', () => {
    const html = draw('refused')
    const dockAt = html.indexOf('class="fw-rcf-dock"')
    expect(html.indexOf('class="fw-rcf-notices"')).toBeGreaterThan(-1)
    expect(html.indexOf('class="fw-rcf-notices"')).toBeLessThan(dockAt)
    expect(dockOf(html)).not.toContain('fw-rcf-notices')
  })

  it('the page mounts the office thread docked with no party; the area’s own frame and the record panels are gone from the view', () => {
    const container = readFileSync(new URL('./JobRecord.tsx', import.meta.url), 'utf8')
    expect(container).toMatch(/<OfficeRecordThread docked record=\{record\}[^>]*party=\{null\}/)
    expect(container).toContain("type: 'MaintenanceJob'")
    expect(container).not.toMatch(/tab === 'activity'/)
    const source = readFileSync(new URL('./view/JobRecordView.tsx', import.meta.url), 'utf8')
    expect(source).toContain("from '../../../../_shared/record-frame/RecordFrame'")
    expect(source).not.toContain('RecordPanelsView')
  })
})

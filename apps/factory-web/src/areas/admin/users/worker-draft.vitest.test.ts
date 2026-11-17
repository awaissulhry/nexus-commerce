import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { blankWorkerDraft, workerDraftWithSites, type WorkerDraft } from './model'

/**
 * W1-BGF (the W1 browser stages' repair) — Admin › Users › Add floor worker kept what the admin typed only if the site list
 * was already there: the dialog emptied the whole form whenever the list arrived or changed, so a name, the tablet's language
 * or the roles picked in the first moment were lost (the browser golden flow's cutter was made in Italian, not English). Now
 * the form empties when the dialog opens, and the site list only fills an empty site.
 */

const A = { id: 'site-a' }
const B = { id: 'site-b' }

describe('Add floor worker: the site list arriving keeps what was typed', () => {
  it('an open dialog starts empty, on the first site, Italian on the tablet', () => {
    expect(blankWorkerDraft([A, B])).toEqual({ displayName: '', locale: 'it', employeeCode: '', siteId: 'site-a', roleIds: [] })
    expect(blankWorkerDraft([]).siteId).toBe('')
  })

  it('the list arriving fills an empty site and leaves the name, the language, the number and the roles', () => {
    const typed: WorkerDraft = { displayName: 'Carla Esempio', locale: 'en', employeeCode: 'E-7', siteId: '', roleIds: ['role-op'] }
    expect(workerDraftWithSites(typed, [A, B])).toEqual({ ...typed, siteId: 'site-a' })
  })

  it('a site already picked stays while it is in the list; one no longer in it falls back to the first', () => {
    const picked: WorkerDraft = { displayName: 'Carla Esempio', locale: 'en', employeeCode: '', siteId: 'site-b', roleIds: [] }
    expect(workerDraftWithSites(picked, [A, B])).toBe(picked)
    expect(workerDraftWithSites(picked, [A])).toEqual({ ...picked, siteId: 'site-a' })
  })

  it('the dialog empties the form when it opens only (never when the site list changes)', () => {
    const source = readFileSync(new URL('./view/UsersView.tsx', import.meta.url), 'utf8')
    const modal = source.slice(source.indexOf('function AddWorkerModal'), source.indexOf('function AddWorkerModal') + 2000)
    expect(modal).toMatch(/setDraft\(blankWorkerDraft\(sites\.current\)\)[\s\S]*?\}, \[open\]\)/)
    expect(modal).toMatch(/setDraft\(\(current\) => workerDraftWithSites\(current, model\.sites\)\)/)
    expect(modal).not.toMatch(/setDraft\(\{ displayName: '', locale: 'it'/)
  })
})

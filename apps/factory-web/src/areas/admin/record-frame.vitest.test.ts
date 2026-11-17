import { readFileSync } from 'node:fs'
import type { ComponentType } from 'react'
import { describe, expect, it } from 'vitest'
import type { DesignScreen } from '../../lib/design/design-screen'
import { renderView, textOf } from '../../lib/record-thread/parts/testing'
import { designScreen as companiesScreen } from './companies/fixtures'
import { COMPANY_MERGED_TABS, COMPANY_TABS, companyTabOf } from './companies/model'
import { designScreen as devicesScreen } from './devices/fixtures'
import { DEVICE_MERGED_TABS, DEVICE_TABS, deviceTabOf, mayReadDeviceThread } from './devices/model'
import { designScreen as sitesScreen } from './sites/fixtures'
import { SITE_MERGED_TABS, SITE_TABS, siteTabOf } from './sites/model'
// ---- B-TH-269 (F4b): the person's record (User, Worker) ----
import { designScreen as personScreen } from './users/record/fixtures'
import { PERSON_THREAD_GATE, personThreadMounted, USER_MERGED_TABS, USER_TABS, userTabOf, WORKER_MERGED_TABS, WORKER_TABS, workerTabOf } from './users/record/model'

/**
 * B-TH-269 (threads plan TH-6; the rule of picture 38, the tabs of 08-tabs O-ADM-*): the admin records on the shared RecordFrame — the
 * band in the shell's row with ONE status pill, the docked thread beside every tab (notes only: an admin record has no party, W03),
 * Activity gone with its tools in the thread's "⋯" (R-ACT), every old `?tab=` kept (R-8), the banners in the one notice.
 * This file holds the company, site and device (F4a); the user and worker block (F4b) follows below (the role's is in
 * roles/save-role/roles-depth.vitest.test.ts).
 * The connection's block lives in connections/connections.vitest.test.ts.
 */

const draw = (screen: unknown, id: string, locale: 'it' | 'en' = 'en') => {
  const design = screen as DesignScreen<unknown>
  const found = design.cases.find((item) => item.id === id)
  if (!found) throw new Error(`no case ${id} in ${design.screen}`)
  return renderView(design.view as ComponentType<{ model: unknown }>, found.model, locale)
}
const dockOf = (html: string) => html.slice(html.indexOf('class="fw-rcf-dock"'))
const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

describe('B-TH-269 (F4a) — company, site and device on RecordFrame: the docked thread (notes only), Activity gone (R-ACT)', () => {
  it('company 5 → 4: Legal & tax · Sites · Defaults · Calendars; every old ?tab= keeps working (Activity → Legal & tax)', () => {
    expect(COMPANY_TABS).toEqual(['legal', 'sites', 'defaults', 'calendars'])
    expect(COMPANY_MERGED_TABS).toEqual({ activity: 'legal' })
    expect(companyTabOf('activity')).toBe('legal')
    for (const tab of COMPANY_TABS) expect(companyTabOf(tab)).toBe(tab)
    expect(companyTabOf(null)).toBe('legal')
    expect(companyTabOf('constructor')).toBe('legal')
    const text = textOf(draw(companiesScreen, 'record-thread'))
    for (const tab of ['Legal & tax', 'Sites', 'Defaults']) expect(text).toContain(tab)
    expect(text).not.toMatch(/\bActivity\b/)
    expect(textOf(draw(companiesScreen, 'record-thread', 'it'))).toContain('Dati legali e fiscali')
  })

  it('site 5 → 4: Structure · Work centres · Calendars · Devices; every old ?tab= keeps working (Activity → Structure)', () => {
    expect(SITE_TABS).toEqual(['structure', 'centres', 'calendars', 'devices'])
    expect(SITE_MERGED_TABS).toEqual({ activity: 'structure' })
    expect(siteTabOf('activity')).toBe('structure')
    for (const tab of SITE_TABS) expect(siteTabOf(tab)).toBe(tab)
    expect(siteTabOf(undefined)).toBe('structure')
    expect(siteTabOf('constructor')).toBe('structure')
    const text = textOf(draw(sitesScreen, 'thread'))
    for (const tab of ['Structure', 'Work centres', 'Calendars', 'Devices']) expect(text).toContain(tab)
    expect(text).not.toMatch(/\bActivity\b/)
  })

  it('device 3 → 2: Station & mode · Status; every old ?tab= keeps working (Activity → Station & mode)', () => {
    expect(DEVICE_TABS).toEqual(['binding', 'status'])
    expect(DEVICE_MERGED_TABS).toEqual({ activity: 'binding' })
    expect(deviceTabOf('activity')).toBe('binding')
    for (const tab of DEVICE_TABS) expect(deviceTabOf(tab)).toBe(tab)
    expect(deviceTabOf(null)).toBe('binding')
    expect(deviceTabOf('constructor')).toBe('binding')
    const text = textOf(draw(devicesScreen, 'device-thread'))
    for (const tab of ['Station & mode', 'Status']) expect(text).toContain(tab)
    expect(text).not.toMatch(/\bActivity\b/)
  })

  it('the device thread is read only with devices.view beside threads.read (B-TH-005, thread-G02: notes about who uses it)', () => {
    expect(mayReadDeviceThread(['threads.read', 'devices.view'])).toBe(true)
    expect(mayReadDeviceThread(['threads.read'])).toBe(false)
    expect(mayReadDeviceThread(['devices.view', 'devices.manage'])).toBe(false)
    expect(source('./devices/DeviceRecord.tsx')).toContain('mayReadDeviceThread(held)')
  })

  const DOCKED: ReadonlyArray<[unknown, string]> = [
    [companiesScreen, 'record-thread'],
    [companiesScreen, 'record-sites'],
    [companiesScreen, 'record-defaults'],
    [companiesScreen, 'record-calendars'],
    [sitesScreen, 'thread'],
    [sitesScreen, 'centres'],
    [sitesScreen, 'calendars'],
    [sitesScreen, 'devices'],
    [devicesScreen, 'device-thread'],
    [devicesScreen, 'device-status'],
  ]

  it('ONE thread on every tab, its "⋯" (R-ACT) there; no record panels, no old admin dock, no address to Activity', () => {
    for (const [screen, id] of DOCKED) {
      const html = draw(screen, id)
      expect(html.match(/class="fw-rcf-dock"/g)?.length, id).toBe(1)
      expect(html, id).toContain('aria-label="Thread tools"')
      expect(html, id).not.toContain('fw-rp-tabs')
      expect(html, id).not.toContain('fw-adm-record-dock')
      expect(html, id).not.toContain('?tab=activity')
    }
  })

  it('the wall (W03): an admin record has no party — Office notes only, no "Reply to", no e-mail of anyone outside', () => {
    for (const [screen, id] of [
      [companiesScreen, 'record-thread'],
      [sitesScreen, 'thread'],
      [devicesScreen, 'device-thread'],
    ] as const) {
      const dock = textOf(dockOf(draw(screen, id)))
      expect(dock, id).not.toMatch(/Reply to (?!the customer)/)
      expect(dock, id).not.toMatch(/@[a-z0-9-]+\.example/)
    }
  })

  it('without the read right there is no thread here: no dock, no Thread button', () => {
    for (const [screen, id] of [
      [companiesScreen, 'record-no-thread'],
      [sitesScreen, 'no-thread'],
      [devicesScreen, 'device-no-thread'],
    ] as const) {
      const html = draw(screen, id)
      expect(html, id).not.toContain('class="fw-rcf-dock"')
      expect(html, id).not.toContain('aria-label="Thread tools"')
    }
  })

  it('every banner in the one notice of the body column, never above the thread', () => {
    for (const [screen, id] of [
      [companiesScreen, 'record-saved'],
      [sitesScreen, 'archived'],
      [devicesScreen, 'device-revoked'],
    ] as const) {
      const html = draw(screen, id)
      const dockAt = html.indexOf('class="fw-rcf-dock"')
      expect(html.indexOf('class="fw-rcf-notices"'), id).toBeGreaterThan(-1)
      expect(html.indexOf('class="fw-rcf-notices"'), id).toBeLessThan(dockAt)
      expect(dockOf(html), id).not.toContain('fw-rcf-notices')
    }
  })

  it('not found and loading stay inside the frame with no thread', () => {
    for (const [screen, id] of [
      [companiesScreen, 'record-not-found'],
      [companiesScreen, 'record-loading'],
      [sitesScreen, 'not-found'],
      [devicesScreen, 'device-not-found'],
    ] as const) {
      const html = draw(screen, id)
      expect(html, id).toContain('class="fw-rcf')
      expect(html, id).not.toContain('class="fw-rcf-dock"')
    }
  })

  it('each page mounts the office thread docked with no party; the admin dock hook and frame are gone from these pages', () => {
    for (const path of ['./companies/CompanyRecord.tsx', './sites/SiteRecord.tsx', './devices/DeviceRecord.tsx']) {
      const container = source(path)
      expect(container, path).toMatch(/<OfficeRecordThread docked record=\{record\}[^>]*party=\{null\}/)
      expect(container, path).not.toContain('useThreadDock')
      expect(container, path).not.toContain('useRecordTab')
    }
    for (const path of ['./companies/view/CompanyRecordView.tsx', './sites/view/SiteRecordView.tsx', './devices/view/DeviceRecordView.tsx']) {
      const view = source(path)
      expect(view, path).toContain("from '../../../_shared/record-frame/RecordFrame'")
      expect(view, path).not.toContain('shared/view/RecordFrame')
      expect(view, path).not.toMatch(/tab === 'activity'/)
    }
  })
})

// ---- B-TH-269 (F4b): the user and worker records follow below (the role's block is in roles/save-role/roles-depth.vitest.test.ts). ----
// ---- B-TH-269 (F4b): a colleague's and a worker's record on RecordFrame — the thread docked CLOSED (R-10), read only with the
// record's own view right beside threads.read (B-TH-005; GDPR art. 4 inside the office), notes only (W03) ----
describe('B-TH-269 (F4b) — User and Worker: the thread docked CLOSED (R-10), read only with users.view / workers.view, notes only', () => {
  const screen = personScreen as unknown as DesignScreen<unknown>
  const drawPerson = (id: string, locale: 'it' | 'en' = 'en') => {
    const found = screen.cases.find((item) => item.id === id)
    if (!found) throw new Error(`no case ${id}`)
    return renderView(screen.view as ComponentType<{ model: unknown }>, found.model, locale)
  }
  const personDock = (html: string) => html.slice(html.indexOf('class="fw-rcf-dock"'))

  it('tabs: User 5 → 4 (Profile · Roles & scope · Partner organisation · Sessions & sign-ins), Worker 3 → 2 (Profile · Badge & PIN); every old ?tab= keeps working (R-8)', () => {
    expect(USER_TABS).toEqual(['profile', 'roles', 'partner', 'sessions'])
    expect(WORKER_TABS).toEqual(['profile', 'badge'])
    expect(USER_MERGED_TABS).toEqual({ activity: 'profile' })
    expect(WORKER_MERGED_TABS).toEqual({ activity: 'profile' })
    for (const tab of USER_TABS) expect(userTabOf(tab)).toBe(tab)
    for (const tab of WORKER_TABS) expect(workerTabOf(tab)).toBe(tab)
    expect(userTabOf('activity')).toBe('profile')
    expect(workerTabOf('activity')).toBe('profile')
    expect(userTabOf('constructor')).toBe('profile')
    expect(workerTabOf(null)).toBe('profile')
    const user = drawPerson('thread-closed')
    for (const tab of ['profile', 'roles', 'sessions']) expect(user).toContain(`?tab=${tab}`)
    expect(user).not.toContain('?tab=activity')
    expect(textOf(user)).toContain('Roles & scope')
    const worker = drawPerson('worker-thread-closed')
    for (const tab of ['profile', 'badge']) expect(worker).toContain(`?tab=${tab}`)
    expect(worker).not.toContain('?tab=activity')
    expect(textOf(drawPerson('worker-thread-closed', 'it'))).toContain('Badge e PIN')
  })

  it('the read right is named beside threads.read (B-TH-005): users.view for a colleague, workers.view for a worker', () => {
    expect(PERSON_THREAD_GATE).toEqual({ User: 'users.view', Worker: 'workers.view' })
    expect(personThreadMounted('User', new Set(['threads.read', 'users.view']))).toBe(true)
    expect(personThreadMounted('User', new Set(['threads.read']))).toBe(false)
    expect(personThreadMounted('User', new Set(['users.view']))).toBe(false)
    expect(personThreadMounted('User', new Set(['threads.read', 'workers.view']))).toBe(false)
    expect(personThreadMounted('Worker', new Set(['threads.read', 'workers.view']))).toBe(true)
    expect(personThreadMounted('Worker', new Set(['threads.read', 'users.view']))).toBe(false)
    const user = readFileSync(new URL('./users/record/UserRecord.tsx', import.meta.url), 'utf8')
    expect(user).toContain("personThreadMounted('User', held)")
    const worker = readFileSync(new URL('./users/record/WorkerRecord.tsx', import.meta.url), 'utf8')
    expect(worker).toContain("personThreadMounted('Worker', held)")
  })

  it('User and Worker dock their thread CLOSED: the frame starts hidden and its Thread button is not pressed (the button or ⌘J shows it)', () => {
    for (const id of ['thread-closed', 'roles', 'profile', 'w2b-413-sessions', 'worker-thread-closed', 'worker-badge', 'worker-profile']) {
      const html = drawPerson(id)
      expect(html.match(/class="fw-rcf-dock"/g)?.length, id).toBe(1)
      expect(html, id).toContain('class="fw-rcf has-thread is-hidden"')
      expect(html, id).toMatch(/aria-pressed="false"[^>]*aria-controls=|aria-controls=[^>]*aria-pressed="false"/)
      expect(html, id).not.toContain('fw-rp-tabs')
      expect(html, id).not.toContain('fw-adm-record-dock')
    }
    for (const file of ['./users/record/view/UserRecordView.tsx', './users/record/view/WorkerRecordView.tsx']) {
      const view = readFileSync(new URL(file, import.meta.url), 'utf8')
      expect(view, file).toMatch(/closed: true/)
      expect(view, file).toContain("from '../../../../_shared/record-frame/RecordFrame'")
      expect(view, file).not.toContain("from '../../../shared/view/RecordFrame'")
      expect(view, file).not.toContain("tab === 'activity'")
    }
  })

  it('without the view right: no thread and no Thread button', () => {
    for (const id of ['no-thread', 'worker-no-thread']) {
      const html = drawPerson(id)
      expect(html, id).not.toContain('class="fw-rcf-dock"')
      expect(html, id).not.toContain('aria-label="Thread tools"')
    }
  })

  it('W03: no outside party on a person’s thread — notes only, no "Reply to", no e-mail; the containers mount it with party null', () => {
    for (const id of ['thread-closed', 'worker-thread-closed']) {
      const dock = textOf(personDock(drawPerson(id)))
      expect(dock, id).not.toMatch(/Reply to (?!the customer)/)
      expect(dock, id).not.toMatch(/@[a-z0-9-]+\.example/)
    }
    for (const file of ['./users/record/UserRecord.tsx', './users/record/WorkerRecord.tsx']) {
      const container = readFileSync(new URL(file, import.meta.url), 'utf8')
      expect(container, file).toMatch(/<OfficeRecordThread docked record=\{record\}[^>]*party=\{null\}/)
      expect(container, file).not.toContain('useThreadDock')
      expect(container, file).not.toContain('useRecordTab')
    }
  })

  it('one notice in the body column, never above the thread', () => {
    const html = drawPerson('worker-own')
    const dockAt = html.indexOf('class="fw-rcf-dock"')
    expect(html.indexOf('class="fw-rcf-notices')).toBeGreaterThan(-1)
    expect(html.indexOf('class="fw-rcf-notices')).toBeLessThan(dockAt)
    expect(personDock(html)).not.toContain('fw-rcf-notices')
  })
})
// ---- end B-TH-269 (F4b)

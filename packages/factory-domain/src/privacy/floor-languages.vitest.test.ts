import { describe, expect, it } from 'vitest'
import { planFloorLanguages } from './floor-languages'

const facts = { current: ['it', 'en'], noticeLanguages: ['it', 'en', 'ro'], workersByLanguage: { it: 4, en: 1 } }

describe('floor languages (PLT-128)', () => {
  it('adds a language the worker notice in force has', () => {
    const plan = planFloorLanguages(['it', 'en', 'RO '], facts)
    expect(plan).toMatchObject({ locales: ['it', 'en', 'ro'], added: ['ro'], removed: [], problems: [] })
  })

  it('refuses a language the notice lacks, or any language while no notice is in force', () => {
    expect(planFloorLanguages(['it', 'en', 'ur'], facts).problems).toEqual([{ path: 'body/locales/2', message: expect.stringMatching(/worker notice in force has no ur text or PDF/) }])
    expect(planFloorLanguages(['it', 'en', 'ro'], { ...facts, noticeLanguages: null }).problems).toEqual([{ path: 'body/locales/2', message: expect.stringMatching(/No worker notice is in force/) }])
  })

  it('refuses to remove a language active workers read, and keeps at least one, each once, as ISO codes', () => {
    expect(planFloorLanguages(['it'], facts).problems).toEqual([{ path: 'remove/en', message: expect.stringMatching(/^1 active worker of the site reads en/) }])
    expect(planFloorLanguages(['it'], { ...facts, workersByLanguage: { it: 4 } }).problems).toEqual([])
    expect(planFloorLanguages([], facts).problems.map((issue) => issue.path)).toContain('body/locales')
    expect(planFloorLanguages(['it', 'it', 'english'], facts).problems.map((issue) => issue.path)).toEqual(['body/locales/1', 'body/locales/2', 'remove/en'])
  })
})

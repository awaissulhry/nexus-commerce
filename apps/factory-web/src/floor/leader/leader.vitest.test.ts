import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { LOCALES } from '../../lib/i18n/locales'
import { CATALOGUE, messagesFor } from '../../lib/i18n/messages'
import { I18nProvider } from '../../lib/i18n/provider'
import { basketHome, FRAME, PATCH, QUALITY, STITCHING } from '../basket/fixtures'
import type { BasketTeam } from '../basket/api'
import { deptOf } from '../basket/model'
import { giveBasketsOf, givePeopleOf, holderOf, namesNoWorkers } from './give'
import { groupsOf, keeps, leaderForYouOf, teamBasketsOf, teamNumbersOf } from './model'
import { LeaderHomeView, type LeaderHomeViewModel } from './view/LeaderHomeView'

/**
 * owb-fl6 — the team leader's home, Give to… and the words (written, run at the end: Owner rule). The numbers are the TEAM's, never one
 * person's; a tap on a number keeps those baskets; the baskets come by order (Do this first, then a problem, then late); Give to… lists the
 * team with what each holds ("Person n" where names are not shown); the Undo of a give goes back to who held it.
 */

const rows = basketHome().here
const TEAM: BasketTeam = {
  team: { id: 'team-1', name: 'Team Noor', picture: null },
  numbers: { working: 1, waiting: 3, late: 0, problem: 1 },
  forYou: basketHome().forYou,
  orders: [
    { salesOrderId: 'so-2', customerCode: 'SEED-C2', picture: null, baskets: [{ ...rows[1]!, bundleId: 'bnd-B-0502', code: 'B-0502' }] },
    { salesOrderId: 'so-1', customerCode: 'SEED-C1', picture: null, baskets: rows },
  ],
  people: [
    { key: 'w-1', name: 'Ada Demo', holds: { bundleId: 'bnd-B-0402', code: 'B-0402' } },
    { key: 'w-2', name: 'Bilal Demo', holds: null },
  ],
  missing: 1,
  doneToday: 7,
  // server B's fl4 sends no topics (an older note may): read as none.
  handover: { writtenAt: '2026-11-28T06:00:00.000Z', topics: [], text: 'Needle 3 is slow.' },
}

describe('the leader\'s home', () => {
  it('four numbers of the TEAM, as the server counts them; never a number of one person', () => {
    expect(teamNumbersOf(TEAM)).toEqual({ working: 1, waiting: 3, late: 0, problem: 1 })
    // The people of Who has what carry what they hold, never a count of their work.
    expect(Object.keys(TEAM.people[0]!).sort()).toEqual(['holds', 'key', 'name'])
  })

  it('a tap on a number keeps those baskets (Waiting counts the paused ones too)', () => {
    expect(rows.filter((row) => keeps('working', row)).map((row) => row.code)).toEqual(['B-0402'])
    expect(rows.filter((row) => keeps('waiting', row)).map((row) => row.code)).toEqual(['B-0431', 'B-0418', 'B-0409'])
    expect(rows.filter((row) => keeps('problem', row)).map((row) => row.code)).toEqual(['B-0409'])
  })

  it('the team\'s baskets by order: an order with Do this first comes first; inside, Do this first on top', () => {
    const groups = groupsOf(TEAM, null)
    expect(groups.map((group) => group.order.customerCode)).toEqual(['SEED-C1', 'SEED-C2'])
    expect(groups[0]!.rows[0]!.code).toBe('B-0418')
    expect(groupsOf(TEAM, 'problem').map((group) => group.order.customerCode)).toEqual(['SEED-C1'])
    expect(teamBasketsOf(TEAM)).toBe(5)
  })

  it('For you: the same ONE list (a waiting problem stays)', () => {
    expect(leaderForYouOf(TEAM, []).map((item) => item.kind)).toEqual(['CHANGED_DESIGN', 'ANSWER', 'PROBLEM'])
  })
})

describe('Give to…', () => {
  const words = (n: number) => `Person ${n}`

  it('the people of the team with what each holds; the holder of this basket marked', () => {
    expect(givePeopleOf(TEAM, 'bnd-B-0402', words)).toEqual([
      { key: 'w-1', label: 'Ada Demo', holds: 'B-0402', current: true },
      { key: 'w-2', label: 'Bilal Demo', holds: null, current: false },
    ])
  })

  it('a site that names no workers (key member-n, no name): nobody to give to, said in words', () => {
    const station = { ...TEAM, people: [{ key: 'member-1', name: null, holds: null }, { key: 'member-2', name: null, holds: null }] }
    expect(givePeopleOf(station, 'bnd-B-0402', words)).toEqual([])
    expect(namesNoWorkers(station)).toBe(true)
    expect(namesNoWorkers(TEAM)).toBe(false)
  })

  it('from a person: the team\'s baskets not in that person\'s hands; the Undo goes back to who held it', () => {
    expect(giveBasketsOf(TEAM, 'w-1').map((basket) => basket.code)).not.toContain('B-0402')
    expect(holderOf(TEAM, 'bnd-B-0402')?.key).toBe('w-1')
    expect(holderOf(TEAM, 'bnd-B-0431')).toBeNull()
  })
})

const draw = (model: LeaderHomeViewModel, locale: (typeof LOCALES)[number]) =>
  renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['floor', 'floor-basket', 'floor-lineview']) }, createElement(LeaderHomeView, { model, onAction: () => undefined })))

const model = (extra: Partial<LeaderHomeViewModel> = {}): LeaderHomeViewModel => ({
  frame: FRAME,
  pick: { current: deptOf(STITCHING, 'en'), open: false, departments: [STITCHING, PATCH, QUALITY].map((look) => deptOf(look, 'en')!), stations: null, problem: null, busy: false },
  part: 'baskets',
  state: 'ready',
  team: TEAM,
  numbers: teamNumbersOf(TEAM),
  filter: null,
  forYou: leaderForYouOf(TEAM, []),
  groups: groupsOf(TEAM, null),
  total: teamBasketsOf(TEAM),
  locale: 'en',
  readAt: 0,
  people: givePeopleOf(TEAM, '', (n) => `Person ${n}`).map(({ key, label, holds }) => ({ key, label, holds })),
  jobs: ['incident'],
  said: null,
  busy: false,
  ...extra,
})

describe('the leader\'s home at 390 px', () => {
  for (const locale of LOCALES) {
    it(`Baskets in ${locale}: four numbers in ONE row, the orders with Change all, the step of each basket a button; no key left`, () => {
      const html = draw(model(), locale)
      expect(html.match(/(?:^|[\s>"])(?:leader|give|steps|route|homePage|state|flag)\.[a-zA-Z]+/)?.[0] ?? null).toBeNull()
      expect(html.match(/fw-ld-num"/g)?.length).toBe(4)
      expect(html).toContain(CATALOGUE[locale]['floor-basket']!['leader.changeAll']!)
      expect(html.match(/fw-ld-step/g)?.length).toBe(5)
    })
  }

  it('Team: the team card, Who has what (a free person says Free), the handover note', () => {
    const html = draw(model({ part: 'team' }), 'en')
    expect(html).toContain('People missing: 1')
    expect(html).toContain('Done today: 7')
    expect(html).toContain('Who has what')
    expect(html).toContain('Free')
    expect(html).toContain('Needle 3 is slow.')
    expect(html).toContain('Ada Demo')
  })
})

// ---- every word of the leader's screens exists in it and en ------------------------------------------------------------------------

const DIR = fileURLToPath(new URL('.', import.meta.url))
const sources = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? sources(join(dir, entry.name)) : /\.tsx?$/.test(entry.name) && !entry.name.includes('.vitest.test.') ? [join(dir, entry.name)] : []))

describe('the words', () => {
  it('names only keys of floor-basket (literal and built)', () => {
    const keys = new Set<string>()
    for (const file of [...sources(DIR), ...sources(join(DIR, '../basket'))]) for (const match of readFileSync(file, 'utf8').matchAll(/\btb\(\s*'([A-Za-z0-9_.]+)'/g)) keys.add(match[1]!)
    const built = [
      ...['working', 'waiting', 'late', 'problem'].flatMap((filter) => [`leader.number.${filter}`, `leader.filter.${filter}`]),
      ...['REDO', 'MISTAKE', 'OTHER'].map((why) => `steps.why.${why}`),
      ...['NOT_NEEDED', 'REDO', 'CUSTOMER', 'OTHER'].map((why) => `route.why.${why}`),
      ...['MATERIAL', 'MACHINE', 'PEOPLE', 'REDO'].map((reason) => `late.reason.${reason}`),
      ...['moved', 'failed'].map((said) => `undo.${said}`),
      'steps.leaderBack',
      'steps.packFirst',
      'leader.firstOn',
      'leader.firstOff',
    ]
    const has = (key: string) => LOCALES.every((locale) => {
      const words = CATALOGUE[locale]['floor-basket'] ?? {}
      return key in words || (`${key}_one` in words && `${key}_other` in words)
    })
    expect([...keys, ...built].filter((key) => !has(key))).toEqual([])
  })
})

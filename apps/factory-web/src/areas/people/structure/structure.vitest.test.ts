import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import { CATALOGUE } from '../../../lib/i18n/messages'
import { render, textOf } from '../../../lib/record-thread/parts/testing'
import { designScreen, LIA_RECORD, PEOPLE, UNITS } from './fixtures'
import {
  addDraftOf,
  addHeldOf,
  bossOf,
  chainOf,
  closeBlockersOf,
  dragOf,
  dragText,
  hitsOf,
  isAsk,
  keepMerge,
  leaderChanged,
  listRowsOf,
  maxBasketsOf,
  mergeBodyOf,
  mergeCandidatesOf,
  mergeDraftOf,
  mergeHeldOf,
  mergeLeadersOf,
  mergeMovesOf,
  moveAskOf,
  moveTargetsOf,
  newUnitDraftOf,
  openOrdersOf,
  personBodyOf,
  personDraftOf,
  personHeldOf,
  pickColour,
  pickIcon,
  pickLetters,
  pictureDraftOf,
  structureHref,
  structureRightsOf,
  subtreeIds,
  tabOf,
  termsOf,
  tickMerge,
  toggleWorksFor,
  treeOf,
  unitBodyOf,
  unitDraftOf,
  unitHeldOf,
  UNIT_TABS,
  viewOf,
  withLeader,
} from './model'
import { StructureView } from './view/StructureView'

/**
 * owb-ss8 (S3 web B; design plan § 5zb, § 5zd) — People › Factory structure (8.1) and its profiles and windows (8.2). Written, not run
 * (Owner rule: checks at the end). Made-up data (fixtures.ts).
 */

const source = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8')
const tree = treeOf(UNITS, PEOPLE)
const node = (id: string) => tree.byId.get(id)!

describe('8.1 the tree from the flat read', () => {
  it('open units only, a unit under its parent, the API order kept; people at home, the leader first; totals count the units under', () => {
    expect(tree.roots.map((root) => root.unit.id)).toEqual(['u-top'])
    expect(node('u-top').children.map((kid) => kid.unit.id)).toEqual(['u-floor', 'u-quality'])
    expect(tree.byId.has('u-old')).toBe(false)
    expect(node('t-noor').here[0]!.name).toBe('Noor Nadir')
    expect(node('t-noor').total).toBe(6)
    expect(node('u-floor').total).toBe(1 + 6 + 2 + 1)
    expect(node('u-top').total).toBe(13)
    expect(tree.loose.map((row) => row.name)).toEqual(['Pavel Pattern'])
    expect(tree.order.map((each) => each.unit.id)).toEqual(['u-top', 'u-floor', 't-noor', 't-kian', 't-lia', 'u-quality'])
  })

  it('a unit whose parent is unknown or closed is a root; a loop in the data places each unit once', () => {
    const odd = treeOf([...UNITS, { ...UNITS[1]!, id: 'u-lost', parentId: 'u-gone', name: 'Lost' }, { ...UNITS[1]!, id: 'u-a', parentId: 'u-b', name: 'A' }, { ...UNITS[1]!, id: 'u-b', parentId: 'u-a', name: 'B' }], PEOPLE)
    expect(odd.roots.map((root) => root.unit.id)).toEqual(expect.arrayContaining(['u-top', 'u-lost']))
    expect(odd.order.filter((each) => each.unit.id === 'u-a')).toHaveLength(1)
    expect(odd.order.filter((each) => each.unit.id === 'u-b')).toHaveLength(1)
  })

  it('the line up to the top, whom a person answers to', () => {
    expect(chainOf(tree, 't-noor').map((unit) => unit.id)).toEqual(['u-floor', 'u-top'])
    expect(bossOf(tree, PEOPLE.find((row) => row.employeeId === 'e-omar')!)).toEqual({ employeeId: 'e-noor', name: 'Noor Nadir' })
    expect(bossOf(tree, PEOPLE.find((row) => row.employeeId === 'e-noor')!)).toEqual({ employeeId: 'e-sven', name: 'Sven Supervisor' })
    expect(bossOf(tree, PEOPLE.find((row) => row.employeeId === 'e-lia')!)).toEqual({ employeeId: 'e-sven', name: 'Sven Supervisor' })
    expect(bossOf(tree, PEOPLE.find((row) => row.employeeId === 'e-otto')!)).toBeNull()
  })

  it('find: a unit by its name or kind, a person by name or role (letter case and accents aside); nothing typed marks nothing', () => {
    expect([...hitsOf(tree, 'QUALITY')]).toEqual(['u-quality'])
    expect([...hitsOf(tree, 'omar')]).toEqual(['t-noor'])
    expect([...hitsOf(tree, 'worker petra')]).toEqual(['t-noor'])
    expect([...hitsOf(tree, 'wörker')].sort()).toEqual(['t-kian', 't-lia', 't-noor'])
    expect(hitsOf(tree, '  ').size).toBe(0)
  })

  it('list ↔ chart: the list is the tree as rows; a shut unit hides its units; finding opens them; a phone starts with the list', () => {
    expect(listRowsOf(tree, new Set(), false).map((row) => row.depth)).toEqual([0, 1, 2, 2, 2, 1])
    expect(listRowsOf(tree, new Set(['u-floor']), false).map((row) => row.unit.id)).toEqual(['u-top', 'u-floor', 'u-quality'])
    expect(listRowsOf(tree, new Set(['u-floor']), true)).toHaveLength(6)
    expect(viewOf(null, true)).toBe('list')
    expect(viewOf(null, false)).toBe('chart')
    expect(viewOf('chart', true)).toBe('chart')
    expect(viewOf('nonsense', false)).toBe('chart')
  })
})

describe('8.1 drag → the Move window asks first and says what moves', () => {
  it('the drag text round trip; anything else reads as nothing', () => {
    expect(dragOf(dragText({ kind: 'unit', id: 't-noor' }))).toEqual({ kind: 'unit', id: 't-noor' })
    expect(dragOf(dragText({ kind: 'person', id: 'e-omar' }))).toEqual({ kind: 'person', id: 'e-omar' })
    expect(dragOf('file:///x')).toBeNull()
    expect(dragOf(null)).toBeNull()
  })

  it('a unit under another unit: the move body and the people that go with it', () => {
    const ask = moveAskOf(tree, { kind: 'unit', id: 't-noor' }, 'u-quality')
    expect(isAsk(ask) && ask).toEqual({ kind: 'unit', unitId: 't-noor', parentId: 'u-quality', from: 'Floor A', to: 'Quality', people: 6 })
    expect(moveAskOf(tree, { kind: 'unit', id: 'u-quality' }, null)).toMatchObject({ kind: 'unit', parentId: null, to: null })
  })

  it('refused in words: under a team, under itself or a unit under it, where it is already', () => {
    expect(moveAskOf(tree, { kind: 'unit', id: 'u-quality' }, 't-kian')).toEqual({ key: 'move.refused.team' })
    expect(moveAskOf(tree, { kind: 'unit', id: 'u-floor' }, 't-noor')).toEqual({ key: 'move.refused.self' })
    expect(moveAskOf(tree, { kind: 'unit', id: 'u-floor' }, 'u-floor')).toEqual({ key: 'move.refused.self' })
    expect(moveAskOf(tree, { kind: 'unit', id: 't-kian' }, 'u-floor')).toEqual({ key: 'move.refused.same' })
    expect(moveAskOf(tree, { kind: 'unit', id: 'u-nothing' }, 'u-floor')).toEqual({ key: 'move.refused.gone' })
  })

  it('a person to a unit (a team takes people); a leader who moves leaves the unit without a leader; a person in no unit can be put in one', () => {
    expect(moveAskOf(tree, { kind: 'person', id: 'e-omar' }, 't-kian')).toEqual({ kind: 'person', employeeId: 'e-omar', unitId: 't-kian', from: 'Team Noor', to: 'Team Kian', leaves: false })
    expect(moveAskOf(tree, { kind: 'person', id: 'e-noor' }, 't-kian')).toMatchObject({ leaves: true })
    expect(moveAskOf(tree, { kind: 'person', id: 'e-omar' }, 't-noor')).toEqual({ key: 'move.refused.same' })
    expect(moveAskOf(tree, { kind: 'person', id: 'e-pavel' }, 'u-quality')).toMatchObject({ kind: 'person', from: null, to: 'Quality' })
  })

  it('Move… (the keyboard twin): a unit may go to the top or under a unit that is not a team, not itself, not its own parent', () => {
    const targets = moveTargetsOf(tree, { kind: 'unit', id: 't-noor' })
    expect(targets.top).toBe(true)
    expect(targets.units.map((each) => each.unit.id)).toEqual(['u-top', 'u-quality'])
    expect(moveTargetsOf(tree, { kind: 'unit', id: 'u-top' }).top).toBe(false)
    expect(moveTargetsOf(tree, { kind: 'person', id: 'e-omar' }).units.map((each) => each.unit.id)).not.toContain('t-noor')
    expect(subtreeIds(node('u-floor'))).toEqual(['u-floor', 't-noor', 't-kian', 't-lia'])
  })
})

describe('8.2 the windows — merge, close, the picture, the profile, the person', () => {
  it('merge: the same kind only, tick ≥ 1, which profile stays (its name and leader follow), the body, what moves', () => {
    expect(mergeCandidatesOf(tree, 't-noor').map((each) => each.unit.id)).toEqual(['t-kian', 't-lia'])
    expect(mergeCandidatesOf(tree, 'u-quality').map((each) => each.unit.id)).toEqual(['u-floor'])
    let draft = mergeDraftOf(tree, 't-noor')
    expect(mergeHeldOf(draft)).toEqual({ key: 'merge.held.pick' })
    draft = tickMerge(tickMerge(draft, 't-kian'), 't-lia')
    expect(mergeHeldOf(draft)).toBeNull()
    draft = { ...draft, step: 'confirm' }
    draft = keepMerge(tree, draft, 't-kian')
    expect(draft).toMatchObject({ keepId: 't-kian', name: 'Team Kian', leaderId: 'e-kian' })
    expect(mergeLeadersOf(tree, draft).map((leader) => leader.name)).toEqual(['Noor Nadir', 'Kian Kole'])
    expect(mergeMovesOf(tree, draft)).toEqual({ people: 7, units: 2 })
    expect(mergeBodyOf({ ...draft, name: ' Team Noor and Kian ' })).toEqual({ keepId: 't-kian', mergeIds: ['t-noor', 't-lia'], name: 'Team Noor and Kian', leaderEmployeeId: 'e-kian' })
    expect(mergeHeldOf({ ...draft, name: '  ' })).toEqual({ key: 'merge.held.name' })
    expect(tickMerge(draft, 't-lia').picked).toEqual(['t-kian'])
  })

  it('close: the words say what to move first (units under it, its people, its open orders); the top never closes', () => {
    expect(closeBlockersOf(node('u-floor'), 0)).toEqual([
      { key: 'close.units', params: { count: 3 } },
      { key: 'close.people', params: { count: 1 } },
    ])
    expect(closeBlockersOf(node('t-lia'), openOrdersOf(LIA_RECORD))).toEqual([
      { key: 'close.people', params: { count: 1 } },
      { key: 'close.orders', params: { count: 1 } },
    ])
    expect(closeBlockersOf(node('u-top'), 0)[0]).toEqual({ key: 'close.top' })
    expect(closeBlockersOf({ ...node('t-lia'), here: [] }, 0)).toEqual([])
  })

  it('the picture: letters · 12 icons · 10 colours; an unknown icon or colour changes nothing; no photo', () => {
    const picture = pictureDraftOf(UNITS[0]!.picture, 'slate')
    expect(picture).toEqual({ kind: 'ICON', icon: 'factory', colour: 'emerald' })
    expect(pickLetters(picture)).toEqual({ kind: 'LETTERS', icon: null, colour: 'emerald' })
    expect(pickIcon(picture, 'scissors')).toEqual({ kind: 'ICON', icon: 'scissors', colour: 'emerald' })
    expect(pickIcon(picture, 'camera')).toBe(picture)
    expect(pickColour(picture, 'cyan').colour).toBe('cyan')
    expect(pickColour(picture, 'gold')).toBe(picture)
    expect(source('./view/PicturePicker.tsx')).not.toMatch(/type="file"|<img/)
  })

  it('Edit the profile: held words (name, a name taken, the basket limit), the body (a team has no kind word), the leader through today\'s PUT', () => {
    const draft = unitDraftOf(LIA_RECORD)
    expect(draft).toMatchObject({ id: 't-lia', version: 4, takesOrders: true, maxBaskets: '8', takesNewOrders: false })
    expect(unitHeldOf({ ...draft, name: ' ' }, [])).toEqual({ key: 'unit.held.name' })
    expect(unitHeldOf({ ...draft, name: 'team kián' }, ['Team Kian'])).toEqual({ key: 'unit.held.taken' })
    expect(unitHeldOf({ ...draft, maxBaskets: '0' }, [])).toEqual({ key: 'unit.held.max' })
    expect(unitHeldOf({ ...draft, maxBaskets: 'ten' }, [])).toEqual({ key: 'unit.held.max' })
    expect(unitHeldOf(draft, ['Team Kian'])).toBeNull()
    expect(maxBasketsOf('')).toBeNull()
    expect(maxBasketsOf('12')).toBe(12)
    expect(unitBodyOf({ ...draft, kindWord: 'Group', standInUntil: '2026-12-01' })).toMatchObject({ kindWord: null, maxBaskets: 8, takesNewOrders: false, standInEmployeeId: null, standInUntil: null, worksForPartyIds: [] })
    const lead = withLeader({ ...draft, standInId: 'e-lia' }, 'e-lia')
    expect(lead).toMatchObject({ leaderId: 'e-lia', standInId: null })
    expect(leaderChanged(lead, LIA_RECORD)).toBe(true)
    expect(leaderChanged(draft, LIA_RECORD)).toBe(false)
    expect(toggleWorksFor(toggleWorksFor(draft, 'party-a'), 'party-b').worksFor).toEqual(['party-a', 'party-b'])
    expect(toggleWorksFor(draft, null).worksFor).toEqual([])
  })

  it('A new unit: a team or another unit, under its parent, a colour of its own; a unit\'s body keeps its own kind word', () => {
    const draft = newUnitDraftOf({ siteId: 'site-a1', parentId: 'u-floor', takesOrders: false, count: 7 })
    expect(draft).toMatchObject({ id: null, parentId: 'u-floor', picture: { kind: 'LETTERS', colour: 'red' } }) // the 8th of the 10 tones
    expect(unitBodyOf({ ...draft, name: 'Floor C', kindWord: 'Group' })).toMatchObject({ name: 'Floor C', kindWord: 'Group', takesOrders: false, maxBaskets: null })
  })

  it('Edit the person: the phone only with the personal right; with us since is a date; reads and speaks is one language', () => {
    const draft = personDraftOf({ id: 'e-omar', version: 2, jobRole: 'Worker', phone: '+39 000 000', locale: 'ur', startDate: '2024-03-01T00:00:00.000Z' })
    expect(draft).toEqual({ employeeId: 'e-omar', version: 2, role: 'Worker', phone: '+39 000 000', locale: 'ur', since: '2024-03-01' })
    expect(personBodyOf(draft, false)).toEqual({ version: 2, jobRole: 'Worker', locale: 'ur', startDate: '2024-03-01' })
    expect(personBodyOf({ ...draft, phone: ' ' }, true)).toEqual({ version: 2, jobRole: 'Worker', locale: 'ur', startDate: '2024-03-01', phone: null })
    expect(personHeldOf({ ...draft, since: '' })).toEqual({ key: 'person.held.since' })
    expect(personHeldOf({ ...draft, locale: 'EN-gb' })).toEqual({ key: 'person.held.speaks' })
    expect(personHeldOf(draft)).toBeNull()
  })

  it('Add a person: both names, a unit, a start day', () => {
    const draft = addDraftOf('t-kian', '2026-11-28')
    expect(addHeldOf(draft)).toEqual({ key: 'add.held.name' })
    expect(addHeldOf({ ...draft, firstName: 'Dora', lastName: 'Dune', unitId: null })).toEqual({ key: 'add.held.unit' })
    expect(addHeldOf({ ...draft, firstName: 'Dora', lastName: 'Dune' })).toBeNull()
  })

  it('the address: one profile at a time, the tab (overview is the default), the view; rights from the session and the read', () => {
    expect(structureHref('/w/demo/people/structure', { unit: 't-noor', tab: 'overview' })).toBe('/w/demo/people/structure?unit=t-noor')
    expect(structureHref('/w/demo/people/structure', { unit: 't-noor', person: 'e-omar', tab: 'people' })).toBe('/w/demo/people/structure?unit=t-noor&tab=people')
    expect(structureHref('/w/demo/people/structure', { view: 'list' })).toBe('/w/demo/people/structure?view=list')
    const terms = termsOf(new URLSearchParams('person=e-omar&tab=history&new=team'))
    expect(terms).toEqual({ view: null, unit: null, person: 'e-omar', tab: 'history', newTeam: true })
    expect(tabOf('work', UNIT_TABS)).toBe('work')
    expect(tabOf('money', UNIT_TABS)).toBe('overview')
    expect(structureRightsOf(['people.structure.manage', 'people.employees.manage', 'fields.personal.view'], true)).toEqual({ manage: true, phone: true, editPerson: true })
    expect(structureRightsOf(['people.structure.manage'], false)).toEqual({ manage: false, phone: false, editPerson: false })
  })
})

describe('8.1 what a reader sees', () => {
  const html = (id: string, locale: 'en' | 'it' = 'en') => render(createElement(StructureView, { model: designScreen.cases.find((item) => item.id === id)!.model }), locale)

  it('the chart: the cards, the leader, the people count, the person in no unit yet; the closed unit is not drawn', () => {
    const text = textOf(html('chart'))
    expect(text).toContain('Seed Factory A')
    expect(text).toContain('Noor Nadir leads it')
    expect(text).toContain('In no unit yet')
    expect(text).not.toContain('Old floor')
    expect(html('chart')).toContain('draggable="true"')
    expect(html('chart')).toContain('/w/demo/people/structure?unit=t-noor')
  })

  it('read only: no drag, no buttons, "You read this page"', () => {
    const page = html('read-only')
    expect(page).not.toContain('draggable="true"')
    expect(textOf(page)).toContain('You read this page')
    expect(textOf(page)).not.toContain('New unit…')
  })

  it('every case draws in Italian with no key left on screen', () => {
    for (const item of designScreen.cases) expect(textOf(html(item.id, 'it')), item.id).not.toMatch(/\b(head|tools|unit|person|profile|loose|notice|error|common)\.[A-Za-z]/)
  })
})

describe('walls and seams', () => {
  it('no figure about one person: the reads carry no speed, count, rank or pay per person; the phone is optional (the personal right)', () => {
    const api = source('./api.ts')
    expect(api).not.toMatch(/\b(speed|rank|output|piecesDone|pay)\b\s*:/)
    expect(api).toContain('phone: z.string().nullable().optional()')
    expect(source('./view/PersonProfileView.tsx')).toContain('model.phone && facts.phone')
  })

  it('no new route: the profiles are addresses of the same page; the base\'s page stub is replaced', () => {
    expect(source('../../../app/(office)/w/[company]/people/structure/page.tsx')).toContain('<StructurePage />')
    expect(source('./StructurePage.tsx')).toContain('termsOf(params)')
  })

  it('the team window of Employees › Teams opens the shared profile; the Teams page\'s New team opens A new unit as a team', () => {
    expect(source('../employees/teams/view/TeamWindow.tsx')).toContain('<OpenProfileLink prefix={prefix} unitId={team.id}')
    expect(source('../../production/teams/TeamsPage.tsx')).toContain('/people/structure?new=team')
  })

  it('the words: factory-structure has the same keys in en and it', () => {
    const en = Object.keys(CATALOGUE.en['factory-structure'] ?? {}).sort()
    expect(en.length).toBeGreaterThan(200)
    expect(Object.keys(CATALOGUE.it['factory-structure'] ?? {}).sort()).toEqual(en)
  })
})

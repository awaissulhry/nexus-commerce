import { describe, expect, it } from 'vitest'
import { FACTORY_PERMISSIONS } from '../../auth/permissions/catalogue'
import { ROLE_TEMPLATES } from '../../auth/roles/templates'
import { EVENT_CATALOGUE } from '../../events/catalogue'
import { AUTOMATED_DECISIONS, informationPackDue, peopleDataFacts, personDecidesProblems, purposesInOrder } from './decisions'
import { figureRoleKeysProblems, figureRolesChangeOf, openReasonProblems, personFigureAccess, sightWords } from './figures'
import { gateClosedWords, gateDriftNotes, gateOpen, gateReadiness, leadsChangeOf, leadsChangeProblems, switchOffProblems, switchOnProblems, type GateFacts } from './gate'
import { groupShown, maskSmallGroups, minimumGroupChangeOf, minimumGroupOf, minimumGroupProblems, personKeyProblems, TOO_FEW_WORDS } from './groups'
import { PEOPLE_FIGURES_VIEW, PEOPLE_PRIVACY_MANAGE, PEOPLE_PRIVACY_VIEW } from './permissions'
import { columnsForPurpose, gateFor, GATE_PURPOSES, PEOPLE_DATA_PURPOSES, purposeUseProblems } from './purposes'

/**
 * Privacy of people data (B-W2b-27): the purpose tags (PLT-209, PLT-207), the legal gate per site and purpose
 * (Statuto dei Lavoratori art. 4 c.1-3; GDPR arts. 13, 35), the minimum group size (ANA-075), one person's figures for
 * the worker and HR only (MES-249; Owner answer H3) and a person decides (MES-281; D.Lgs. 152/1997 art. 1-bis).
 * Made-up ids only.
 */

const NOTICE = { id: '0190a000-0000-7000-8000-000000000001', label: '2026-10' }
const DPIA = { id: '0190a000-0000-7000-8000-000000000002', versionNo: 1, reviewDueOn: '2027-10-01' }
const SITE_BASIS = { kind: 'UNION_AGREEMENT' as const, reference: 'RSU agreement 2026-01' }
const facts = (patch: Partial<GateFacts> = {}): GateFacts => ({
  purpose: 'ATTENDANCE',
  workerNotice: NOTICE,
  dpia: DPIA,
  siteBasis: SITE_BASIS,
  scanSubject: 'WORKER',
  today: '2026-11-02',
  ...patch,
})
const paths = (issues: readonly { path: string }[]) => issues.map((issue) => issue.path)

describe('purpose tags (PLT-209, PLT-207)', () => {
  it('are the six purposes of the ownership files; only attendance and performance have a gate of their own', () => {
    expect([...PEOPLE_DATA_PURPOSES]).toEqual(['EMPLOYMENT', 'ATTENDANCE', 'PERFORMANCE', 'PAY', 'SAFETY', 'PRODUCTION'])
    expect([...GATE_PURPOSES]).toEqual(['ATTENDANCE', 'PERFORMANCE'])
    expect(PEOPLE_DATA_PURPOSES.map((purpose) => [purpose, gateFor(purpose)])).toEqual([
      ['EMPLOYMENT', null],
      ['ATTENDANCE', 'ATTENDANCE'],
      ['PERFORMANCE', 'PERFORMANCE'],
      ['PAY', null],
      ['SAFETY', null],
      ['PRODUCTION', null],
    ])
  })

  it('refuse a use outside the tags in words (no quiet reuse of scan data as performance figures)', () => {
    expect(purposeUseProblems(['PRODUCTION'], 'PRODUCTION')).toEqual([])
    expect(purposeUseProblems(['PAY', 'PERFORMANCE', 'PRODUCTION'], 'PERFORMANCE')).toEqual([])
    const refused = purposeUseProblems(['PRODUCTION'], 'PERFORMANCE')
    expect(refused).toEqual([{ path: 'purpose', message: expect.stringMatching(/kept for production, not for performance: .*decided by a person \(GDPR art\. 5\(1\)\(b\)\)/) }])
    expect(purposeUseProblems(['MARKETING'], 'PAY')[0]?.message).toBe('Unknown purpose tag: MARKETING.')
  })

  it('drive what a purpose reads: a column tagged for others is left out, an untagged one passes', () => {
    const row = { id: 'e1', displayName: 'Seed Worker', weeklyMinutes: 2400, contract: 'FULL_TIME' }
    const tags = { displayName: ['EMPLOYMENT', 'PRODUCTION'], weeklyMinutes: ['EMPLOYMENT', 'ATTENDANCE', 'PAY'], contract: ['EMPLOYMENT', 'PAY'] }
    expect(columnsForPurpose(row, tags, 'ATTENDANCE')).toEqual({ id: 'e1', weeklyMinutes: 2400 })
    expect(columnsForPurpose(row, tags, 'PRODUCTION')).toEqual({ id: 'e1', displayName: 'Seed Worker' })
  })
})

describe('the legal gate per site and purpose (Statuto art. 4)', () => {
  it('a row with no switch-off is ON; none, or a switched-off one, is OFF (the safe default)', () => {
    expect(gateOpen(null)).toBe(false)
    expect(gateOpen({ switchedOffAt: '2026-11-13T09:30:00.000Z' })).toBe(false)
    expect(gateOpen({ switchedOffAt: null })).toBe(true)
  })

  it('readiness names what is missing: the worker notice, the DPIA and, for PERFORMANCE, the site basis', () => {
    expect(gateReadiness(facts())).toEqual({ canSwitchOn: true, missing: [], notes: [] })
    const nothing = gateReadiness(facts({ purpose: 'PERFORMANCE', workerNotice: null, dpia: null, siteBasis: null }))
    expect(nothing.canSwitchOn).toBe(false)
    expect(nothing.missing.map((entry) => entry.code)).toEqual(['WORKER_NOTICE', 'DPIA', 'SITE_BASIS'])
    // ATTENDANCE (art. 4 c.2) needs no site basis from Production › Settings.
    expect(gateReadiness(facts({ siteBasis: null })).canSwitchOn).toBe(true)
    const notes = gateReadiness(facts({ purpose: 'PERFORMANCE', scanSubject: 'STATION', dpia: { ...DPIA, reviewDueOn: '2026-10-01' } })).notes
    expect(notes).toEqual([expect.stringMatching(/^The impact assessment \(version 1\) was due for review on 2026-10-01/), expect.stringMatching(/name the station only/)])
  })

  it('ATTENDANCE: switched on with the basis kept (kind and reference) and a reason; never leads', () => {
    expect(switchOnProblems({ facts: facts(), basis: { kind: 'NOT_REQUIRED', reference: 'Counsel opinion 2026-10-20' }, reason: 'Clock-in starts at A1.' })).toEqual([])
    expect(paths(switchOnProblems({ facts: facts(), reason: 'Clock-in starts at A1.' }))).toEqual(['body/basis/kind', 'body/basis/reference'])
    expect(paths(switchOnProblems({ facts: facts(), basis: { kind: 'NOT_REQUIRED', reference: 'x' }, basisCoversLeads: true, reason: 'ok go' }))).toEqual(['body/basisCoversLeads'])
    expect(paths(switchOnProblems({ facts: facts(), basis: { kind: 'NOT_REQUIRED', reference: 'Opinion' } }))).toEqual(['body/reason'])
  })

  it("PERFORMANCE: takes the site's basis from Production › Settings, never one in the body; leads only on an agreement or authorisation", () => {
    const perf = facts({ purpose: 'PERFORMANCE' })
    expect(switchOnProblems({ facts: perf, reason: 'The RSU agreement covers efficiency.' })).toEqual([])
    expect(paths(switchOnProblems({ facts: perf, basis: { kind: 'UNION_AGREEMENT', reference: 'x' }, reason: 'ok go' }))).toEqual(['body/basis'])
    expect(paths(switchOnProblems({ facts: facts({ purpose: 'PERFORMANCE', siteBasis: null }), reason: 'ok go' }))).toEqual(['site/legalBasis'])
    expect(switchOnProblems({ facts: perf, basisCoversLeads: true, leadsSeeFigures: true, reason: 'The agreement names team leads.' })).toEqual([])
    const opinion = facts({ purpose: 'PERFORMANCE', siteBasis: { kind: 'NOT_REQUIRED', reference: 'Opinion' } })
    expect(paths(switchOnProblems({ facts: opinion, basisCoversLeads: true, reason: 'ok go' }))).toEqual(['body/basisCoversLeads'])
    expect(paths(switchOnProblems({ facts: perf, leadsSeeFigures: true, reason: 'ok go' }))).toEqual(['body/leadsSeeFigures'])
  })

  it('a switch-on with nothing on record is refused with every missing item', () => {
    expect(paths(switchOnProblems({ facts: facts({ workerNotice: null, dpia: null }), basis: { kind: 'NOT_REQUIRED', reference: 'Opinion' }, reason: 'ok go' }))).toEqual(['company/workerNotice', 'company/dpia'])
  })

  it('switching off needs a reason only; leads: widening needs the basis to cover them and a reason, narrowing never asks', () => {
    expect(paths(switchOffProblems(''))).toEqual(['body/reason'])
    expect(switchOffProblems('The agreement ended.')).toEqual([])
    expect(leadsChangeOf(false, true)).toBe('WIDEN')
    expect(leadsChangeOf(true, false)).toBe('NARROW')
    expect(leadsChangeOf(true, true)).toBe('NONE')
    const covered = { purpose: 'PERFORMANCE' as const, basis: 'UNION_AGREEMENT' as const, basisCoversLeads: true, leadsSeeFigures: false, switchedOffAt: null }
    expect(leadsChangeProblems({ gate: covered, leadsSeeFigures: true, reason: 'Leads coach their team.' })).toEqual([])
    expect(paths(leadsChangeProblems({ gate: covered, leadsSeeFigures: true }))).toEqual(['body/reason'])
    expect(paths(leadsChangeProblems({ gate: { ...covered, basisCoversLeads: false }, leadsSeeFigures: true, reason: 'ok go' }))).toEqual(['body/leadsSeeFigures'])
    expect(leadsChangeProblems({ gate: { ...covered, leadsSeeFigures: true }, leadsSeeFigures: false })).toEqual([])
    expect(paths(leadsChangeProblems({ gate: null, leadsSeeFigures: true, reason: 'ok go' }))).toEqual(['gate'])
  })

  it('drift: a newer notice, DPIA or site basis is a note on the gate in force, never a block', () => {
    const recorded = { purpose: 'PERFORMANCE' as const, recordedNoticeId: NOTICE.id, recordedDpiaId: DPIA.id, recordedBasis: SITE_BASIS }
    expect(gateDriftNotes({ ...recorded, workerNoticeInForceId: NOTICE.id, dpiaInForceId: DPIA.id, siteBasis: SITE_BASIS })).toEqual([])
    expect(gateDriftNotes({ ...recorded, workerNoticeInForceId: null, dpiaInForceId: 'other', siteBasis: { kind: 'INL_AUTHORISATION', reference: 'INL 12' } })).toHaveLength(3)
  })

  it('says a closed gate in words, with the article', () => {
    expect(gateClosedWords('ATTENDANCE')).toMatch(/art\. 4 c\.2-3/)
    expect(gateClosedWords('PERFORMANCE')).toMatch(/art\. 4 c\.1/)
  })
})

describe('the minimum group size (ANA-075)', () => {
  it('is 3 or more (the database floor), 3 by default; lowering it widens', () => {
    expect(minimumGroupProblems(3)).toEqual([])
    expect(paths(minimumGroupProblems(2))).toEqual(['body/minimumGroupSize'])
    expect(paths(minimumGroupProblems(3.5))).toEqual(['body/minimumGroupSize'])
    expect(paths(minimumGroupProblems(51))).toEqual(['body/minimumGroupSize'])
    expect(minimumGroupOf(null)).toBe(3)
    expect(minimumGroupOf({ minimumGroupSize: 5 })).toBe(5)
    expect(minimumGroupChangeOf(5, 3)).toBe('WIDEN')
    expect(minimumGroupChangeOf(3, 5)).toBe('NARROW')
  })

  it('a group under the minimum never shows: figures and headcount emptied, an unknown headcount counts as too few', () => {
    expect(groupShown(3, 3)).toBe(true)
    expect(groupShown(2, 3)).toBe(false)
    expect(groupShown(null, 3)).toBe(false)
    // A setting below the floor never shows a smaller group.
    expect(groupShown(2, 1)).toBe(false)
    const { rows, hidden } = maskSmallGroups(
      [
        { key: 'L1', people: 6, figures: { pieces: 420, efficiency: '91.4' } },
        { key: 'L2', people: 2, figures: { pieces: 140, efficiency: '88.0' } },
        { key: 'L3', people: null, figures: { pieces: 70, efficiency: null } },
      ],
      3,
    )
    expect(hidden).toBe(2)
    expect(rows.map((entry) => [entry.row.key, entry.row.people, entry.row.figures, entry.tooFew, entry.words])).toEqual([
      ['L1', 6, { pieces: 420, efficiency: '91.4' }, false, null],
      ['L2', null, { pieces: null, efficiency: null }, true, TOO_FEW_WORDS],
      ['L3', null, { pieces: null, efficiency: null }, true, TOO_FEW_WORDS],
    ])
  })

  it('no list, filter, group or sort of people figures by a person (Owner answer W1)', () => {
    expect(personKeyProblems({ groupBy: ['lineId', 'shiftId'], filters: ['siteId'], sort: ['date'] })).toEqual([])
    expect(paths(personKeyProblems({ groupBy: ['employeeId'], filters: ['workerId'], sort: ['userId'] }))).toEqual(['query/groupBy/employeeId', 'query/filters/workerId', 'query/sort/userId'])
  })
})

describe("one person's figures: the worker and HR only (MES-249; Owner answer H3)", () => {
  const open = { open: true, leadsSeeFigures: false }
  const nobody = { isSubject: false, holdsFigureRole: false, leadsSubject: false }

  it('a closed gate refuses everyone, the worker too', () => {
    expect(personFigureAccess('PERFORMANCE', { open: false, leadsSeeFigures: true }, { ...nobody, isSubject: true })).toEqual({ allowed: false, code: 'GATE_CLOSED', words: gateClosedWords('PERFORMANCE') })
  })

  it('open: the worker (no reason), a named role (HR, with a reason), a lead only where the site lets leads see; nobody else', () => {
    expect(personFigureAccess('PERFORMANCE', open, { ...nobody, isSubject: true })).toEqual({ allowed: true, as: 'SELF', needsReason: false })
    expect(personFigureAccess('PERFORMANCE', open, { ...nobody, holdsFigureRole: true })).toEqual({ allowed: true, as: 'FIGURE_ROLE', needsReason: true })
    expect(personFigureAccess('PERFORMANCE', open, { ...nobody, leadsSubject: true })).toMatchObject({ allowed: false, code: 'NOT_ALLOWED' })
    expect(personFigureAccess('PERFORMANCE', { open: true, leadsSeeFigures: true }, { ...nobody, leadsSubject: true })).toEqual({ allowed: true, as: 'LEAD', needsReason: true })
    expect(personFigureAccess('ATTENDANCE', open, nobody)).toMatchObject({ allowed: false, code: 'NOT_ALLOWED', words: expect.stringMatching(/only by the worker/) })
  })

  it("someone else's figures need a reason from the list; the worker's own need none", () => {
    const hr = personFigureAccess('PERFORMANCE', open, { ...nobody, holdsFigureRole: true })
    expect(paths(openReasonProblems(hr, undefined, undefined))).toEqual(['body/reason'])
    expect(openReasonProblems(hr, 'PAY_QUERY', 'The worker asked about October.')).toEqual([])
    expect(paths(openReasonProblems(hr, 'CURIOSITY', 'x'.repeat(501)))).toEqual(['body/reason', 'body/note'])
    expect(openReasonProblems(personFigureAccess('PERFORMANCE', open, { ...nobody, isSubject: true }), undefined, undefined)).toEqual([])
  })

  it('the roles named are office roles of the tenant, each once; naming one more widens, removing one narrows', () => {
    const roles = [
      { key: 'custom.hr', audience: 'OFFICE' as const },
      { key: 'owner', audience: 'OFFICE' as const },
      { key: 'team_leader', audience: 'FLOOR' as const },
    ]
    expect(figureRoleKeysProblems(['custom.hr'], roles)).toEqual([])
    expect(paths(figureRoleKeysProblems(['custom.hr', 'custom.hr', 'team_leader', 'nobody', 'Bad Key'], roles))).toEqual([
      'body/figureRoleKeys/1',
      'body/figureRoleKeys/2',
      'body/figureRoleKeys/3',
      'body/figureRoleKeys/4',
    ])
    expect(figureRolesChangeOf([], ['custom.hr'])).toBe('WIDEN')
    expect(figureRolesChangeOf(['owner'], ['custom.hr'])).toBe('WIDEN')
    expect(figureRolesChangeOf(['owner', 'custom.hr'], ['custom.hr'])).toBe('NARROW')
    expect(figureRolesChangeOf(['custom.hr'], ['custom.hr'])).toBe('NONE')
  })

  it('says what the viewer sees before anything is read (PrivacyNote)', () => {
    expect(sightWords({ purpose: 'PERFORMANCE', gateOpen: false, level: 'GROUPS_ONLY', minimumGroup: 3, leadsSeeFigures: false })).toEqual([
      expect.stringMatching(/fewer than 3 people shows '—'/),
      gateClosedWords('PERFORMANCE'),
    ])
    expect(sightWords({ purpose: 'PERFORMANCE', gateOpen: true, level: 'ONE_PERSON_ON_REQUEST', minimumGroup: 5, leadsSeeFigures: false })[1]).toMatch(/every opening is recorded/)
  })
})

describe('a person decides (MES-281; D.Lgs. 152/1997 art. 1-bis)', () => {
  const SYSTEM = '00000000-0000-7000-8000-000000000000'
  it('refuses a decision about a worker that the system, a link or a portal makes', () => {
    expect(personDecidesProblems('SKILL_LEVEL', { audience: 'office', actorId: '0190a000-0000-7000-8000-00000000000a', systemActorId: SYSTEM })).toEqual([])
    expect(personDecidesProblems('ATTENDANCE_APPROVAL', { audience: 'floor', actorId: '0190a000-0000-7000-8000-00000000000b', systemActorId: SYSTEM })).toEqual([])
    for (const maker of [
      { audience: 'system', actorId: SYSTEM },
      { audience: 'office', actorId: SYSTEM },
      { audience: 'link', actorId: '0190a000-0000-7000-8000-00000000000c' },
      { audience: 'partner', actorId: '0190a000-0000-7000-8000-00000000000d' },
      { audience: 'office', actorId: null },
    ]) {
      expect(paths(personDecidesProblems('DISPATCH_ASSIGNMENT', { ...maker, systemActorId: SYSTEM }))).toEqual(['decidedBy/DISPATCH_ASSIGNMENT'])
    }
  })

  it('no automated system decides about workers, so no information pack is due; the rules say so', () => {
    expect(AUTOMATED_DECISIONS).toEqual([])
    expect(informationPackDue()).toBe(false)
    const facts = peopleDataFacts()
    expect(facts.map((fact) => fact.key)).toEqual(['PURPOSE_TAGS', 'FIELD_TAGS', 'LEGAL_GATE', 'GROUPS', 'ONE_PERSON', 'PERSON_DECIDES'])
    expect(facts.find((fact) => fact.key === 'PERSON_DECIDES')?.words).toMatch(/no information pack is due/)
    expect(purposesInOrder().map((entry) => entry.purpose)).toEqual([...PEOPLE_DATA_PURPOSES])
  })
})

describe('permissions, templates and events', () => {
  it('are declared in the people area; manage asks for a fresh code; opening figures is a write (read-only never holds it)', () => {
    expect(FACTORY_PERMISSIONS.get(PEOPLE_PRIVACY_VIEW)).toMatchObject({ area: 'people', risk: 'read' })
    expect(FACTORY_PERMISSIONS.get(PEOPLE_PRIVACY_MANAGE)).toMatchObject({ area: 'people', risk: 'stepUp' })
    expect(FACTORY_PERMISSIONS.get(PEOPLE_FIGURES_VIEW)).toMatchObject({ area: 'people', risk: 'write' })
  })

  it('the administrator and the production manager read the gates; only the owner switches them and opens one person\'s figures', () => {
    const holders = (permission: string) => ROLE_TEMPLATES.filter((template) => template.permissions.includes(permission as never)).map((template) => template.key).sort()
    expect(holders(PEOPLE_PRIVACY_VIEW)).toEqual(['admin', 'owner', 'production_manager', 'read_only'])
    expect(holders(PEOPLE_PRIVACY_MANAGE)).toEqual(['owner'])
    expect(holders(PEOPLE_FIGURES_VIEW)).toEqual(['owner'])
  })

  it('the events are in the catalogue, with no person and no basis text', () => {
    expect(EVENT_CATALOGUE.find('legal_gate.changed', 1)?.live).toMatchObject({ permission: 'people.privacy.view', floor: null })
    expect(EVENT_CATALOGUE.find('people_settings.privacy_changed', 1)?.live).toMatchObject({ permission: 'people.privacy.view' })
    expect(() =>
      EVENT_CATALOGUE.parse('legal_gate.changed', 1, {
        gateId: NOTICE.id,
        siteId: DPIA.id,
        purpose: 'ATTENDANCE',
        change: 'SWITCHED_ON',
        open: true,
        leadsSeeFigures: false,
        basisReference: 'RSU',
      }),
    ).toThrow()
  })
})

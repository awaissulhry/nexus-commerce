import type { Issue } from '../../core/errors'

/**
 * Purpose tags on worker data (B-W2b-27; features PLT-209 "data collected by floor tools carries its allowed purposes;
 * reports and AI that need per-person data check the tag and the union agreement setting", PLT-207 "fields are tagged
 * personal; tags drive field security, export, erasure and AI exclusions"; Statuto dei Lavoratori art. 4; GDPR arts. 5
 * (purpose limitation, minimisation), 25).
 *
 * The tags themselves sit beside each personal column in packages/factory-db's ownership files (`personal.columns`,
 * B-W2b-06): the database's column grants follow them (the partner never reads a personal column, the floor only for a
 * floor purpose). These are the same purposes as the API sees them, each with the rule it rests on and the legal gate
 * it needs at the site before a figure about ONE person may be read for it:
 *
 *   EMPLOYMENT   running the employment (who, contract, company, site, line, team, role)   no gate
 *   ATTENDANCE   working time and presence: clock-in, attendance days, the LUL calendar    the site's ATTENDANCE gate
 *   PERFORMANCE  one person's work figures: efficiency, labour records, My day             the site's PERFORMANCE gate
 *   PAY          pay and the payroll                                                       the gate of the data it is
 *                                                                                          computed from (piece pay:
 *                                                                                          PERFORMANCE and its own switch)
 *   SAFETY       health and safety at work: skills, training, authorisations (never health) no gate
 *   PRODUCTION   traceability of what was made and by whom                                  the site's floor rules
 *                                                                                          (B-W1-37), not a people gate
 *
 * A use outside a column's tags is refused (`purposeUseProblems`): a new use needs a new purpose, decided by a person,
 * never a quiet reuse (PLT-209 "prevents quiet misuse of scan data as performance surveillance").
 */

export const PEOPLE_DATA_PURPOSES = ['EMPLOYMENT', 'ATTENDANCE', 'PERFORMANCE', 'PAY', 'SAFETY', 'PRODUCTION'] as const
export type PeopleDataPurpose = (typeof PEOPLE_DATA_PURPOSES)[number]

/** The purposes that need a legal gate per site (factory-db enum PeoplePurpose; plan §12 "two purposes in one gate"). */
export const GATE_PURPOSES = ['ATTENDANCE', 'PERFORMANCE'] as const
export type GatePurpose = (typeof GATE_PURPOSES)[number]

export const isPeopleDataPurpose = (value: unknown): value is PeopleDataPurpose => (PEOPLE_DATA_PURPOSES as readonly unknown[]).includes(value)
export const isGatePurpose = (value: unknown): value is GatePurpose => (GATE_PURPOSES as readonly unknown[]).includes(value)

export interface PurposeRule {
  /** The purpose in words, for answers and the People data rules. */
  readonly words: string
  /** The rule it rests on. */
  readonly law: string
  /** The site's legal gate a figure about one person needs for this purpose; null: none of its own (see `note`). */
  readonly gate: GatePurpose | null
  /** What else holds it, when it has no gate of its own. */
  readonly note: string | null
  /** The floor's tools collect data for it (the floor role may read a personal column carrying it). */
  readonly floor: boolean
}

export const PURPOSE_RULES: Readonly<Record<PeopleDataPurpose, PurposeRule>> = Object.freeze({
  EMPLOYMENT: {
    words: 'Running the employment: who the person is, their contract, company, site, line, team and role.',
    law: 'GDPR art. 6(1)(b) and art. 88',
    gate: null,
    note: null,
    floor: false,
  },
  ATTENDANCE: {
    words: 'Working time and presence: clock-in and out, attendance days, overtime, absences and the LUL calendar.',
    law: 'Statuto dei Lavoratori art. 4 c.2 (the notice under c.3); D.Lgs. 66/2003; GDPR arts. 13, 35',
    gate: 'ATTENDANCE',
    note: null,
    floor: true,
  },
  PERFORMANCE: {
    words: "One person's work figures: efficiency, labour records and corrections, My day.",
    law: 'Statuto dei Lavoratori art. 4 c.1 (a union agreement or the Ispettorato\'s authorisation); GDPR arts. 5, 13, 35',
    gate: 'PERFORMANCE',
    note: null,
    floor: false,
  },
  PAY: {
    words: 'Pay and the payroll: piece rates, earnings, statements and the file for the labour consultant.',
    law: 'Codice civile arts. 2099-2101; GDPR art. 6(1)(b)',
    gate: null,
    note: 'Pay is computed from attendance (the ATTENDANCE gate) or from piece work (the PERFORMANCE gate and the piece-pay switch); it has no gate of its own.',
    floor: false,
  },
  SAFETY: {
    words: 'Health and safety at work: skills, training and machine authorisations; never health data.',
    law: 'D.Lgs. 81/2008; GDPR art. 9 kept out',
    gate: null,
    note: null,
    floor: true,
  },
  PRODUCTION: {
    words: 'Traceability: what was made, at which station, and by whom where the site names workers.',
    law: 'Statuto dei Lavoratori art. 4 c.1 for naming workers (Production › Settings); GDPR art. 13',
    gate: null,
    note: "Held by the site's floor rules: scans name a worker only where the site records a legal basis (Production › Settings).",
    floor: true,
  },
})

/** The site's legal gate a figure about one person needs for a purpose, or null. */
export const gateFor = (purpose: PeopleDataPurpose): GatePurpose | null => PURPOSE_RULES[purpose].gate

/**
 * Whether personal data tagged with `tags` may be used for `use` (PLT-209). A use outside the tags is refused in words;
 * an untagged column is not personal data for this check (the ownership files tag every personal column).
 */
export function purposeUseProblems(tags: readonly string[], use: PeopleDataPurpose, at = 'purpose'): Issue[] {
  const unknown = tags.filter((tag) => !isPeopleDataPurpose(tag))
  if (unknown.length > 0) return [{ path: at, message: `Unknown purpose tag${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}.` }]
  if (tags.length === 0 || tags.includes(use)) return []
  return [
    {
      path: at,
      message: `This data is kept for ${tags.map((tag) => tag.toLowerCase()).join(', ')}, not for ${use.toLowerCase()}: using it for another purpose needs a new purpose, decided by a person (GDPR art. 5(1)(b)).`,
    },
  ]
}

/**
 * The columns of a row that may be used for `use`, given each column's tags: the others are left out before anything is
 * answered (PLT-207: the tags drive what a purpose may read). Columns with no tags are not personal and pass.
 */
export function columnsForPurpose<Row extends Record<string, unknown>>(row: Row, tags: Readonly<Record<string, readonly string[]>>, use: PeopleDataPurpose): Partial<Row> {
  const kept: Record<string, unknown> = {}
  for (const [column, value] of Object.entries(row)) {
    const columnTags = tags[column]
    if (columnTags === undefined || columnTags.includes(use)) kept[column] = value
  }
  return kept as Partial<Row>
}

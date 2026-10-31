import { DEFAULT_QUALIFICATION_MODE, type QualificationMode } from '@nexus/factory-domain/people/skills/qualification'

/**
 * The site's qualification rule (B-W2b-39; MES-024 "blocked or warned (per setting)"; design production.dispatch "a held
 * drop with its reason, or a warning with an override reason (site rule)"): what a missing or Learning-only skill does at
 * a site. FREE: not checked; WARN: the work goes on, dispatch asks a reason, the team leader is told on the floor;
 * STRICT: held, a team leader may override it on the tablet with their PIN and a reason. A class of machine kept under
 * authorisation always needs one, whatever the rule (MES-246).
 *
 * THE ONE READER: dispatch (B-W2b-49), the tablet (B-W2b-46 / -69) and this module's check read the rule here. There is no
 * column for it yet: every site has the default (WARN). Where it belongs (B-W2b-53 owns the editor, Production › Floor
 * rules per site): `ProductionSettings.qualificationRule FloorRuleMode @default(WARN)`, one more field of
 * `modules/production/settings/floor-rules.ts` (FLOOR_RULE_FIELDS, read by `floorChecksFor(db, siteId)`). When it comes,
 * this reader reads that column and nothing else changes.
 */

export interface QualificationRule {
  readonly mode: QualificationMode
  /** True while the site has no rule of its own (today: always). */
  readonly isDefault: boolean
  readonly words: string
}

const WORDS: Readonly<Record<QualificationMode, string>> = {
  FREE: 'Skills are not checked at this site. A class of machine kept under authorisation still needs one.',
  WARN: 'A missing skill warns: the work may go on with a reason, and the team leader is told. A class of machine kept under authorisation always needs one.',
  STRICT: 'A missing skill holds the work: a team leader may override it with their PIN and a reason. A class of machine kept under authorisation always needs one.',
}

/** The rule of a site (null: no site known; the default). */
export async function qualificationRuleFor(_db: unknown, _siteId: string | null): Promise<QualificationRule> {
  const mode = DEFAULT_QUALIFICATION_MODE
  return { mode, isDefault: true, words: WORDS[mode] }
}

import { DEFAULT_QUALIFICATION_MODE, type QualificationMode } from '@nexus/factory-domain/people/skills/qualification'
import { QUALIFICATION_RULE_WORDS } from '@nexus/factory-domain/production/settings/floor-rules'
import type { CommandTx } from '../../../core/command'
import { siteFloorChecks } from '../../production/settings/floor-rules'

/**
 * The site's qualification rule (B-W2b-39, read from the site's row since B-W2b-81; MES-024 "blocked or warned (per
 * setting)"; design production.dispatch "a held drop with its reason, or a warning with an override reason (site rule)"):
 * what a missing or Learning-only skill does at a site. FREE: not checked; WARN: the work goes on, dispatch asks a reason,
 * the team leader is told on the floor; STRICT: held, a team leader may override it on the tablet with their PIN and a
 * reason. A class of machine kept under authorisation always needs one, whatever the rule (MES-246).
 *
 * THE ONE READER: dispatch (B-W2b-49), the tablet (B-W2b-46 / -69) and this module's check read the rule here. It is one
 * more of the site's floor rules (ProductionSettings.qualificationRule, edited in Production › Floor rules per site;
 * read through modules/production/settings/floor-rules.ts): office or floor scope (the floor role may read the column of
 * its own site's row).
 */

export interface QualificationRule {
  readonly mode: QualificationMode
  /** True while the site has no floor rules of its own (it runs on the default). */
  readonly isDefault: boolean
  readonly words: string
}

/** The rule of a site (null: no site known; the default). */
export async function qualificationRuleFor(db: Pick<CommandTx, 'productionSettings'>, siteId: string | null): Promise<QualificationRule> {
  const site = siteId === null ? null : await siteFloorChecks(db, siteId)
  const mode = site?.checks.qualificationRule ?? DEFAULT_QUALIFICATION_MODE
  return { mode, isDefault: site?.isDefault ?? true, words: QUALIFICATION_RULE_WORDS[mode] }
}

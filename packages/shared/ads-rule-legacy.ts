/**
 * W1 (2026-08-20) — LEGACY designation for advertising automation rules.
 *
 * Operator decision, 2026-08-20: every advertising `AutomationRule` that existed before this date
 * is LEGACY — none of the 51 were created by the operator. Provenance measured on prod
 * (`apps/api/scripts/_ra20-rule-provenance.mts`): 31 seeded by `template-seeder:advertising`
 * (2026-05-16 → 06-01), 20 created by generic `user` / `user:anonymous` actors in earlier build
 * sessions (2026-06-01 → 08-03). The newest pre-existing rule is 17 days older than the cutover,
 * so the split is unambiguous.
 *
 * LEGACY IS A LABEL, NOT A BEHAVIOUR. It changes no evaluation, no caps, no autonomy level — the
 * 9 enabled-AUTO legacy rules (including the deliberately cap-armed budget pair) keep running
 * exactly as armed. The label exists so the operator can see which rules they never authored and
 * triage them per-rule: disable, adopt, or recreate through the builder. A rule created through
 * the builder from the cutover onward is NOT legacy.
 *
 * Derived from `createdAt` rather than a schema column, deliberately: `createdAt` is immutable,
 * both rule endpoints already return it, and a migration is currently a deploy hazard while the
 * reporting session's `20260820d` migration is intentionally unapplied. If adopt/un-legacy
 * semantics are ever wanted, promote this to a nullable `legacyAt` column then.
 */

export const ADS_RULE_LEGACY_CUTOVER_ISO = '2026-08-20T00:00:00.000Z'

/** True when the rule predates the cutover. Accepts the ISO string both APIs serialise
 *  (`GET /advertising/automation-rules`, `GET /advertising/autonomy/rules`) or a Date.
 *  A row with no readable `createdAt` is NOT called legacy — absence of evidence stays absent. */
export function isLegacyRule(rule: { createdAt?: string | Date | null }): boolean {
  const raw = rule?.createdAt
  if (raw == null) return false
  const t = raw instanceof Date ? raw.getTime() : Date.parse(raw)
  if (!Number.isFinite(t)) return false
  return t < Date.parse(ADS_RULE_LEGACY_CUTOVER_ISO)
}

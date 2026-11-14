/**
 * The metric layer's rules the database holds (factory-db …_insights_depth_w2b_guards, B-W2b-381) read back from the
 * database's own words, pure: a version in force is never edited, a past version never changes and is never deleted, the
 * states move DRAFT → ACTIVE → SUPERSEDED or RETIRED, a reader reads a KPI in force, the owner is an office role, money
 * names its grain; a fact holds one number of a day that has begun. The routes of apps/factory-api modules/insights/kpis and
 * facts check these first in words; when a write still reaches a rule (a race: two people activating, a role archived
 * meanwhile), the API answers 409 in these words (core/errors) instead of a 500.
 */

export const KPI_REFUSAL_ISSUES = Object.freeze({
  inForce: 'refusal/IN_FORCE',
  ended: 'refusal/ENDED',
  kept: 'refusal/KEPT',
  state: 'refusal/STATE',
  notInForce: 'refusal/NOT_IN_FORCE',
  owner: 'body/ownerRoleId',
  grain: 'body/grain',
  words: 'body/words',
  records: 'body/sourceRecords',
  measures: 'body/measureKeys',
  facts: 'refusal/FACTS',
} as const)

const IN_FORCE = /^kpis: version \S+ of KPI \S+ is in force: it is never edited/
const ENDED = /^kpis: version \S+ of KPI \S+ is no longer in force/
const KEPT = /^kpis: version \S+ of KPI \S+ was in force .*never deleted/
const STATE = /^kpis: version \S+ of KPI \S+ (moves DRAFT → ACTIVE|is written as a DRAFT)/
const NOT_IN_FORCE = /^kpis: a reader reads a KPI that is in force/
const OWNER = /^kpis: KPI \S+ is owned by an office role that is not archived/
const GRAIN = /^kpis: KPI \S+ counts money: it names the grain/
const WORDS = /^kpis: version \S+ of KPI \S+ (has its name|says what it means|gives its formula|says what changed)/
const RECORDS = /^kpis: version \S+ of KPI \S+ names 1 to 20 records/
const MEASURES = /^kpis: version \S+ of KPI \S+ names up to 30 facts/
const FACTS = /^facts: /

/** The words and issue path of a refusal of the database's KPI and fact rules, or null when the message is another one. */
export function databaseKpiRefusal(message: string): { readonly path: string; readonly message: string } | null {
  if (IN_FORCE.test(message)) return { path: KPI_REFUSAL_ISSUES.inForce, message: 'This version is in force: it is never changed. Write a new version from it.' }
  if (ENDED.test(message)) return { path: KPI_REFUSAL_ISSUES.ended, message: 'This version is no longer in force: it is kept as it was, to explain old numbers.' }
  if (KEPT.test(message)) return { path: KPI_REFUSAL_ISSUES.kept, message: 'This version was in force: it explains old numbers and is never deleted. Only a draft is deleted.' }
  if (STATE.test(message)) return { path: KPI_REFUSAL_ISSUES.state, message: 'A version is written as a draft, then put in force, then superseded or withdrawn; it never goes back.' }
  if (NOT_IN_FORCE.test(message)) return { path: KPI_REFUSAL_ISSUES.notInForce, message: 'Only a KPI in force can be read by a dashboard, a report, an alert or a portal page.' }
  if (OWNER.test(message)) return { path: KPI_REFUSAL_ISSUES.owner, message: 'A KPI is owned by an office role that is not archived.' }
  if (GRAIN.test(message)) return { path: KPI_REFUSAL_ISSUES.grain, message: 'A KPI that counts money names the rights its value needs (price, cost or margin).' }
  if (WORDS.test(message)) return { path: KPI_REFUSAL_ISSUES.words, message: 'Its name, meaning and formula are written in Italian and in English, and what changed is said.' }
  if (RECORDS.test(message)) return { path: KPI_REFUSAL_ISSUES.records, message: 'Name 1 to 20 records it is computed from, each a table, each once.' }
  if (MEASURES.test(message)) return { path: KPI_REFUSAL_ISSUES.measures, message: 'Name up to 30 facts it reads, each once, by their measure key.' }
  if (FACTS.test(message)) return { path: KPI_REFUSAL_ISSUES.facts, message: 'The figures of a day are written only for a day that has begun, one number each, in the company’s currency: rebuild them again.' }
  return null
}

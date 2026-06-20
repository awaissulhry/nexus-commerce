/** Full-screen builder route, one per type (/builder/<slug>). Criteria-based rule types use
 *  the shared RuleBuilder; schedule types (Budget Schedule · Dayparting) use ScheduleBuilder. */
import { notFound } from 'next/navigation'
import { ruleTypeBySlug } from '../../_shared/ruleTypes'
import { RuleBuilder } from '../../_shared/RuleBuilder'
import { ScheduleBuilder } from '../../_schedule/ScheduleBuilder'

export const dynamic = 'force-dynamic'

// Schedule-type slugs render the dedicated ScheduleBuilder (Hourly Performance chart +
// weekly schedule table), not the criteria RuleBuilder. (Dayparting joins this set.)
const SCHEDULE_SLUGS = new Set(['budget-schedule', 'dayparting-schedule'])

export default async function Page({ params }: { params: Promise<{ type: string }> }) {
  const { type } = await params
  const rt = ruleTypeBySlug(type)
  if (!rt) notFound()
  if (SCHEDULE_SLUGS.has(rt.slug)) return <ScheduleBuilder slug={rt.slug} />
  return <RuleBuilder slug={rt.slug} />
}

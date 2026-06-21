/** Full-screen builder route, one per type (/builder/<slug>). Criteria-based rule types use
 *  the shared RuleBuilder; schedule types (Budget Schedule · Dayparting) use ScheduleBuilder. */
import { notFound } from 'next/navigation'
import { ruleTypeBySlug } from '../../_shared/ruleTypes'
import { RuleBuilder } from '../../_shared/RuleBuilder'
import { ScheduleBuilder } from '../../_schedule/ScheduleBuilder'
import { RankGoalBuilder } from '../../_rank/RankGoalBuilder'

export const dynamic = 'force-dynamic'

export default async function Page({ params }: { params: Promise<{ type: string }> }) {
  const { type } = await params
  const rt = ruleTypeBySlug(type)
  if (!rt) notFound()
  // RGD.0 — Dayparting Schedule now defaults to the rank-goal builder (which itself toggles to the
  // classic ScheduleBuilder via ?style=classic). Budget Schedule keeps the dedicated ScheduleBuilder.
  if (rt.slug === 'dayparting-schedule') return <RankGoalBuilder />
  if (rt.slug === 'budget-schedule') return <ScheduleBuilder slug={rt.slug} />
  return <RuleBuilder slug={rt.slug} />
}

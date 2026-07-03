/**
 * ER3.2 (delta 3) — edit-rule route.
 */
import { RuleEditor } from '../RuleEditor'

export const dynamic = 'force-dynamic'

export default async function Page({ params }: { params: Promise<{ ruleId: string }> }) {
  const { ruleId } = await params
  return <RuleEditor ruleId={ruleId} />
}

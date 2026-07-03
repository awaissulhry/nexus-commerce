/**
 * ER3.2 (delta 3) — new-rule route: templates via ?template=, duplicate via
 * ?from=<ruleId>.
 */
import { RuleEditor } from '../RuleEditor'

export const dynamic = 'force-dynamic'

export default async function Page({ searchParams }: { searchParams: Promise<{ template?: string; from?: string }> }) {
  const sp = await searchParams
  return <RuleEditor template={sp.template} fromRuleId={sp.from} />
}

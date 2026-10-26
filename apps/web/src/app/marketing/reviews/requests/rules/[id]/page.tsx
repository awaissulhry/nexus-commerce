// /marketing/reviews/requests/rules/<id> — Reviews › Requests › one rule (build spec §3.3c); `new` opens an empty rule.
// A full page (the DS Builder in page mode) inside the Reviews shell; the page renders its own PageHeader.
import type { Metadata } from 'next'
import { RuleEditorClient } from './_editor/RuleEditorClient'

export const metadata: Metadata = { title: 'Reviews · Request rule' }

export default async function RequestRulePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return <RuleEditorClient id={id} />
}

/** AX3.8 — Rule library page. */
import type { Metadata } from 'next'
import { RuleLibraryClient } from './RuleLibraryClient'

export const metadata: Metadata = { title: 'Amazon Ads · Rule library' }
export const dynamic = 'force-dynamic'

export default function RuleLibraryPage() {
  return (
    <div className="px-4 py-4">
      <RuleLibraryClient />
    </div>
  )
}

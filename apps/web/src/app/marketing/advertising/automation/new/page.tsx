/** AX3.8 — Rule builder page. */
import type { Metadata } from 'next'
import { Suspense } from 'react'
import { RuleBuilderClient } from './RuleBuilderClient'

export const metadata: Metadata = { title: 'Amazon Ads · New rule' }
export const dynamic = 'force-dynamic'

export default function NewRulePage() {
  return (
    <div className="px-4 py-4">
      <Suspense fallback={null}>
        <RuleBuilderClient />
      </Suspense>
    </div>
  )
}

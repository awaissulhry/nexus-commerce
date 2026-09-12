'use client'

import { Banner } from '@/design-system/components'
import { Pill } from '@/design-system/primitives'
import type { AliasGroup, ChannelScopeChannel, ChannelSheetRow } from './types'

interface AliasPublishControlProps {
  alias: AliasGroup
  rows: ChannelSheetRow[]
  channel: ChannelScopeChannel
  marketplace: string
  autoRun?: boolean
}

/** Information's saved, destination-scoped validation. Publishing is a separate workflow. */
export function AliasPublishControl({ alias, rows }: AliasPublishControlProps) {
  const selected = rows.filter(row => row.aliasId === alias.id)
  const problems = new Map<string, { label: string; message: string; count: number; error: boolean }>()
  for (const row of selected) for (const issue of row.readiness.issues) {
    const key = JSON.stringify([issue.key, issue.message, issue.severity])
    const group = problems.get(key) ?? { label: issue.label, message: issue.message, count: 0, error: issue.severity === 'error' }
    group.count += 1
    problems.set(key, group)
  }
  return <div className="nds-alias-publish">
    <Banner tone={selected.length === 0 ? 'neutral' : [...problems.values()].some(p => p.error) ? 'warning' : 'info'} title="Saved Information check">
      {selected.length} rows checked in this listing. These results cover Information fields. Publication eligibility and provider acceptance require their own checks.
    </Banner>
    {[...problems.entries()].map(([key, problem]) => <div key={key}>
      <Pill tone={problem.error ? 'danger' : 'warning'}>{problem.count} {problem.count === 1 ? 'row' : 'rows'}</Pill>{' '}
      <strong>{problem.label}</strong>: {problem.message}
    </div>)}
    {selected.length > 0 && !problems.size && <p>No field errors reported by the loaded Information schema.</p>}
    <p>Information edits are saved in Nexus. This check sends nothing to the provider.</p>
  </div>
}

'use client'

import { Card } from '@/design-system/components'
import { DataGrid, type Column } from '@/design-system/grid/datagrid'
import { Pill } from '@/design-system/primitives'
import { readinessMeta } from '@/design-system/grid/renderers/readiness'
import { useScopeReadiness, useStudioScope } from '../contracts'
import type { ReadinessMatrixEntry } from '../types'
import styles from './readiness.module.css'

type MatrixRow = { key: string; label: string; entries: Record<string, ReadinessMatrixEntry> }
function ReadinessValue({ entry, language }: { entry?: ReadinessMatrixEntry; language: string }) {
  if (!entry) return <span title={`This coordinate does not carry ${language.toUpperCase()}.`}>—</span>
  const meta = readinessMeta(entry.state, 'scope')
  return <Pill tone={meta.tone} title={entry.note} data-readiness-language={language} data-readiness-state={entry.state} data-readiness-pct={entry.pct ?? 'null'}>
    {meta.label} · {entry.pct === null ? '—' : `${entry.pct}%`}
  </Pill>
}

/** One index response feeds both tables and the scope bar. No readiness is computed in the browser. */
export function ReadinessPanel() {
  const readiness = useScopeReadiness()
  const { locale } = useStudioScope()
  if (readiness.status !== 'ready') return <Card header="Readiness" description={readiness.status === 'loading' ? 'Loading readiness…' : readiness.status === 'error' ? readiness.message : readiness.reason} />
  const entries = readiness.matrix
  const languages = [...new Set(entries.map(entry => entry.language))]
  const grouped = new Map<string, MatrixRow>()
  for (const entry of entries) {
    const row = grouped.get(entry.coordinateKey) ?? { key: entry.coordinateKey, label: entry.label, entries: {} }
    row.entries[entry.language] = entry; grouped.set(entry.coordinateKey, row)
  }
  const columns: Column<MatrixRow>[] = [
    { key: 'coordinate', label: 'Coordinate', width: 220, sticky: true, render: row => row.label },
    ...languages.map(language => ({ key: language, label: `${language.toUpperCase()}${language === locale ? ' · selected' : ''}`, render: (row: MatrixRow) => <ReadinessValue entry={row.entries[language]} language={language} /> })),
  ]
  const attention = entries.filter(entry => entry.state !== 'ready')
  return <div className={styles.panel}>
    <Card header="Readiness by language" padded={false} description="Required content for each destination and language. — means readiness could not be scored.">
      <DataGrid ariaLabel="Readiness matrix" keyboardScroll rows={[...grouped.values()]} rowKey={row => row.key} columns={columns} emptyState="Readiness has not been computed for this product." />
    </Card>
    <Card header="Needs attention" padded={false} description="Missing or invalid fields from the same readiness results.">
      <DataGrid ariaLabel="Needs attention by language" keyboardScroll rows={attention} rowKey={entry => `${entry.coordinateKey}:${entry.language}`} columns={[
        { key: 'coordinate', label: 'Coordinate', render: entry => entry.label },
        { key: 'language', label: 'Language', render: entry => entry.language.toUpperCase() },
        { key: 'state', label: 'Readiness', render: entry => <ReadinessValue entry={entry} language={entry.language} /> },
        { key: 'missing', label: 'Missing or invalid fields', render: entry => <div className={styles.missing}>{entry.missing.length
          ? [...new Set(entry.missing.map(field => field.field))].map((key, index) => {
            const fields = entry.missing.filter(field => field.field === key)
            return <span key={key} title={[...new Set(fields.map(field => field.reason))].join(' · ')}>{index > 0 ? ', ' : ''}{fields[0].label}</span>
          })
          : entry.note ?? 'Requirements could not be checked.'}</div> },
      ]} emptyState="Every computed destination and language is ready." />
    </Card>
  </div>
}

'use client'
import type { ProductRow } from '@/app/products/_types'
import type { CatalogLanguageProjection } from '@nexus/shared/products-grid'
import { ProvenanceMark, describeCellSource, readinessMeta } from '@/design-system/grid'
import { Tag } from '@/design-system/primitives'
import type { PageColumn } from './columns'
import { languageLabel } from './TranslateDialog'
import styles from './language.module.css'
const content = (row: ProductRow) => (row as ProductRow & { languageContent?: CatalogLanguageProjection }).languageContent
export function languageColumns(language: string): PageColumn[] {
  if (!language) return []
  return [
    ...(['title', 'description'] as const).map(field => ({ key: `${field}@${language}`, label: `${field === 'title' ? 'Title' : 'Description'} · ${languageLabel(language)}`, width: field === 'title' ? 260 : 340, sortable: true,
      value: (row: ProductRow) => content(row)?.[field].value ?? null,
      render: (row: ProductRow) => {
        const cell = content(row)?.[field], source = describeCellSource(cell)
        return <span className={styles.cell} title={source.tooltip}><ProvenanceMark provenance={source.member} from={source.from} /><span className={styles.value}>{String(cell?.value ?? '—')}</span></span>
      } })),
    { key: `readiness@${language}`, label: `Readiness · ${languageLabel(language)}`, width: 180, sortable: true,
      value: row => content(row)?.readiness.state ?? null,
      render: row => { const readiness = content(row)?.readiness; if (!readiness) return '—'; const meta = readinessMeta(readiness.state, 'scope'); return <Tag tone={meta.tone}>{meta.label} · {readiness.pct === null ? '—' : `${readiness.pct}%`}</Tag> } },
    { key: `fallback@${language}`, label: 'Falls back to source', width: 180, sortable: true, defaultHidden: true,
      value: row => content(row)?.fallsBackToSource ?? null, render: row => content(row)?.fallsBackToSource == null ? '—' : content(row)?.fallsBackToSource ? 'Yes' : 'No' },
  ]
}

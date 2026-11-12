'use client'

import { useMemo } from 'react'
import type { ColDef, ICellRendererParams } from '@nexus/ui/grid'
import { Pill } from '@nexus/ui/primitives'
import type { PartyRow } from '../../../parties/_shared/api'
import type { SupplierDocuments } from '../depth/api'
import { documentsCell, NS } from '../depth/model'
import { useT } from '../../../../lib/i18n/provider'

/**
 * The Suppliers list's Documents column (design sec:grid "documents (valid / expiring / missing)"), handed to the shared
 * parties list as a side column: what each supplier holds valid, expiring in 30 days, expired and missing, from one read
 * of the company's documents summary. "—" while it reads or when the read failed (the reason on hover); "None asked"
 * when nothing is asked of it or held.
 */
export function useDocumentsColumn(byParty: ReadonlyMap<string, SupplierDocuments> | null, problem: string | null): ColDef<PartyRow>[] {
  const t = useT(NS)
  return useMemo(() => {
    const DocumentsCell = ({ data }: ICellRendererParams<PartyRow>) => {
      if (!data) return null
      if (problem) return <span title={t(problem)}>—</span>
      if (!byParty) return <span aria-label={t('read.loading')}>—</span>
      const cell = documentsCell(byParty.get(data.id))
      if (!cell) return <span className="fw-spd-hint">{t('list.documents.none')}</span>
      return (
        <span className="fw-spd-docs-cell">
          <Pill tone={cell.tone}>{t(cell.words.key, cell.words.params)}</Pill>
        </span>
      )
    }
    return [{ colId: 'documents', headerName: t('list.documents.col'), sortable: false, flex: 1.4, minWidth: 190, cellRenderer: DocumentsCell }]
  }, [byParty, problem, t])
}

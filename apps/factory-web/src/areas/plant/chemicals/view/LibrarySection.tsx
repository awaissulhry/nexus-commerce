'use client'

import { useMemo } from 'react'
import { FileText, FileUp } from 'lucide-react'
import { EmptyState } from '@nexus/ui/components'
import { LawRef } from '@nexus/ui/components/LawRef/index'
import type { ColDef, ICellRendererParams } from '@nexus/ui/grid'
import { Button } from '@nexus/ui/primitives'
import { SDS_LAW } from '@nexus/factory-domain/safety/chemicals/rules'
import { useDsWords } from '../../../../lib/i18n/ds-parts'
import { ListFrame } from '../../../../list-frame/ListFrame'
import { siteColumn } from '../../../../shell/scope/scope-context'
import type { LibraryRow } from '../api'
import type { ChemicalsPageActions, ChemicalsPageModel } from '../view-model'
import { PAGE_KEYS, SectionFailed, SectionHead, SectionLoading, useDay, useWords } from './parts'

/** The SDS (PDF) tab of a sheet: a new window page (design plant.chemicals/tab:sds "Printable."). */
export const sdsHref = (prefix: string, chemicalId: string, sheetId: string): string => `${prefix}/plant/chemicals/sds?chemical=${encodeURIComponent(chemicalId)}&sheet=${encodeURIComponent(sheetId)}`

/**
 * The SDS library (design sec sds; QHS-278, REACH art. 35): the current sheet per product and language — Product, SDS version,
 * Revised on, Language, the versions it replaced (kept, never deleted), its PDF in a new tab — and, above it, the products in
 * use with no sheet at all (never left out in silence). Replace SDS (a new version) opens the chemical's window on it. The
 * tablets of the site keep these sheets for the cabinet QR (offline): the section says so.
 */
export function LibrarySection({ model, actions, onHelp }: { model: ChemicalsPageModel; actions?: ChemicalsPageActions | undefined; onHelp: () => void }) {
  const t = useWords()
  const ds = useDsWords()
  const day = useDay()
  const answer = model.library.status === 'ready' ? model.library.value : null
  const canManage = model.can.manage

  const columns = useMemo<ColDef<LibraryRow>[]>(() => {
    const FileCell = ({ data }: ICellRendererParams<LibraryRow>) =>
      data ? (
        <a className="fw-ch-cell" href={sdsHref(model.prefix, data.chemicalId, data.id)} target="_blank" rel="noopener noreferrer" aria-label={t('library.openPdf', { name: data.fileName, chemical: data.chemical })}>
          <span>
            <FileText size={13} aria-hidden /> {data.fileName}
          </span>
        </a>
      ) : null
    const ReplaceCell = ({ data }: ICellRendererParams<LibraryRow>) =>
      data ? (
        <Button size="sm" variant="quiet" heldReason={data.canManage && canManage ? null : t('held.manage')} aria-label={t('library.replaceNamed', { chemical: data.chemical, language: t(`lang.${data.language}`) })} onClick={() => actions?.onAddress?.({ open: data.chemicalId, mode: 'replace' })}>
          <FileUp size={13} aria-hidden /> {t('library.replace')}
        </Button>
      ) : null
    const site = siteColumn<LibraryRow>(model.scope, (row) => row.siteId, t('register.col.site'))
    return [
      { colId: 'chemical', headerName: t('library.col.chemical'), minWidth: 220, flex: 1.5, valueGetter: (params) => params.data?.chemical ?? '' },
      { colId: 'version', headerName: t('library.col.version'), minWidth: 110, flex: 0.6, valueGetter: (params) => params.data?.versionLabel ?? '' },
      { colId: 'revisedOn', headerName: t('library.col.revisedOn'), minWidth: 130, flex: 0.7, valueGetter: (params) => params.data?.revisedOn ?? '', valueFormatter: (params) => (params.data ? day(params.data.revisedOn) : '') },
      { colId: 'language', headerName: t('library.col.language'), minWidth: 120, flex: 0.6, valueGetter: (params) => (params.data ? t(`lang.${params.data.language}`) : '') },
      {
        colId: 'superseded',
        headerName: t('library.col.superseded'),
        minWidth: 190,
        flex: 1,
        valueGetter: (params) => (params.data ? (params.data.superseded.length === 0 ? t('library.noneSuperseded') : params.data.superseded.map((old) => t('library.supersededItem', { version: old.versionLabel, date: day(old.revisedOn) })).join(' · ')) : ''),
      },
      { colId: 'file', headerName: t('library.col.file'), minWidth: 200, flex: 1.2, valueGetter: (params) => params.data?.fileName ?? '', cellRenderer: FileCell },
      ...(site ? [site] : []),
      { colId: 'replace', headerName: '', minWidth: 150, flex: 0, sortable: false, pinned: 'right', valueGetter: () => '', cellRenderer: ReplaceCell },
    ]
  }, [t, day, model.prefix, model.scope, canManage, actions])

  const head = <SectionHead id="fw-ch-sds" title={t('library.title')} note={<LawRef law={SDS_LAW} plain={t('law.sds')} labels={ds.lawRef} />}><span className="fw-ch-muted">{t('library.offline')}</span></SectionHead>

  if (model.library.status === 'error') {
    return (
      <>
        {head}
        <SectionFailed title={t('library.failed')} problem={model.library.problem} onRetry={actions?.onRetryLibrary} />
      </>
    )
  }
  if (!answer) {
    return (
      <>
        {head}
        <SectionLoading rows={4} />
      </>
    )
  }

  return (
    <>
      {head}
      {answer.missing.length > 0 && (
        <div className="fw-ch-fieldset" role="group" aria-label={t('library.missingLabel')}>
          <span className="fw-ch-warn">{t('library.missing', { count: answer.missing.length })}</span>
          <ul className="fw-ch-picks">
            {answer.missing.map((row) => (
              <li key={row.chemicalId} className="fw-ch-pick">
                <span>{row.chemical}</span>
                <Button size="sm" variant="quiet" heldReason={row.canManage && canManage ? null : t('held.manage')} aria-label={t('library.addFirstNamed', { chemical: row.chemical })} onClick={() => actions?.onAddress?.({ open: row.chemicalId, mode: 'replace' })}>
                  {t('library.addFirst')}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <ListFrame<LibraryRow>
        label={t('library.label')}
        title={t('library.title')}
        listKey="plant.chemicals.2"
        rows={answer.sheets}
        rowId={(row) => row.id}
        columns={columns}
        count={t('library.count', { count: answer.sheets.length })}
        keys={PAGE_KEYS(t)}
        onHelp={onHelp}
        onOpen={(row) => actions?.onAddress?.({ open: row.chemicalId, sheet: row.id })}
        state={answer.sheets.length === 0 ? <EmptyState icon={<FileText size={22} aria-hidden />} title={t('library.emptyTitle')} description={t('library.empty')} /> : undefined}
        cards={{ fields: { chemical: { role: 'title' }, version: { role: 'subtitle' } } }}
      />
    </>
  )
}

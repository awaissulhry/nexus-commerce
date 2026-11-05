'use client'

import { useMemo } from 'react'
import { Archive, ArchiveRestore, ExternalLink, FileUp, Pencil } from 'lucide-react'
import { Banner, Field } from '@nexus/ui/components'
import { LawRef } from '@nexus/ui/components/LawRef/index'
import { PdfViewer } from '@nexus/ui/components/PdfViewer/index'
import { Button, Pill } from '@nexus/ui/primitives'
import { SDS_LAW, type QuantityUnit } from '@nexus/factory-domain/safety/chemicals/rules'
import { DetailModal, FileRow, Textarea, useDsWords } from '../../../../lib/i18n/ds-parts'
import { pdfViewerLabels } from '../../../../lib/pdf/labels'
import { useT } from '../../../../lib/i18n/provider'
import type { Chemical, Sheet } from '../api'
import { archiveHeld, draftChanged, draftProblems, placeOf, quantityOf, replaceHeld, replaceWords, sheetStateKey } from '../model'
import type { ChemicalsPageActions, ChemicalsPageModel, OpenState } from '../view-model'
import { ChemicalFields, SheetFields } from './AddChemicalDialog'
import { sdsHref } from './LibrarySection'
import { GhsMarks, SignalWord, useDay, useWords } from './parts'

const STATE_TONE = { MISSING: 'danger', OTHER_LANGUAGE: 'warning', OK: 'success' } as const

/**
 * The chemical's window (design pop:chem, a DetailModal: "Facts + SDS PdfViewer + roles + PPE needed", action Replace SDS,
 * J / K over the register's rows): the facts (supplier, GHS pictograms, signal word, H and P statements, where it is kept and
 * its cabinet, the most kept, the roles that use it, the PPE to handle it), every sheet — the current ones and the superseded
 * ones, kept — each shown in the viewer or opened in its own tab, and the PDF of the sheet chosen in the DS PdfViewer. Edit,
 * Replace SDS (a newer version; the older one superseded, kept) and Archive / Put back in use are its modes (`?do=`), each
 * held with the reason while it cannot run.
 */
export function ChemicalWindow({ model, state, actions }: { model: ChemicalsPageModel; state: OpenState; actions?: ChemicalsPageActions | undefined }) {
  const t = useWords()
  const shell = useT('shell')
  const ds = useDsWords()
  const day = useDay()
  const record = state.read.status === 'ready' ? state.read.value : null
  const chemical = record?.chemical ?? null
  const rows = model.register.status === 'ready' ? model.register.value.chemicals : null
  const ids = useMemo(() => (rows ? rows.map((row) => row.id) : []), [rows])
  const canManage = !!chemical && chemical.canManage && model.can.manage
  const manageHeld = !chemical ? t('common.reading') : canManage ? null : t('held.manage')
  const close = () => actions?.onAddress?.({ open: null })
  const back = () => actions?.onAddress?.({ mode: 'view' })

  let footer = null
  if (chemical && state.mode === 'edit' && state.draft) {
    const problems = draftProblems(state.draft, false)
    const held = state.busy ? t('held.busy') : problems[0] ? t(problems[0].key) : draftChanged(chemical, state.draft) ? null : t('held.nothingChanged')
    footer = (
      <>
        <Button onClick={back}>{t('common.back')}</Button>
        <Button variant="primary" heldReason={held} onClick={() => actions?.onSaveEdit?.()}>
          {t('edit.save')}
        </Button>
      </>
    )
  } else if (chemical && state.mode === 'replace') {
    const held = replaceHeld(chemical, state.sheet, model.today, state.busy)
    footer = (
      <>
        <Button onClick={back}>{t('common.back')}</Button>
        <Button variant="primary" heldReason={held ? t(held, { version: replaceWords(chemical, state.sheet).params.version ?? '' }) : manageHeld} onClick={() => actions?.onReplace?.()}>
          <FileUp size={14} aria-hidden /> {t('replace.save')}
        </Button>
      </>
    )
  } else if (chemical && state.mode === 'archive') {
    const held = archiveHeld(state.reason, state.busy)
    footer = (
      <>
        <Button onClick={back}>{t('common.back')}</Button>
        <Button variant="primary" heldReason={held ? t(held) : manageHeld} onClick={() => actions?.onArchive?.()}>
          <Archive size={14} aria-hidden /> {t('archive.save')}
        </Button>
      </>
    )
  } else if (chemical) {
    const archived = chemical.status !== 'ACTIVE'
    footer = (
      <>
        {archived ? (
          <Button heldReason={state.busy ? t('held.busy') : manageHeld} onClick={() => actions?.onRestore?.()}>
            <ArchiveRestore size={14} aria-hidden /> {t('restore.save')}
          </Button>
        ) : (
          <>
            <Button heldReason={manageHeld} onClick={() => actions?.onAddress?.({ mode: 'archive' })}>
              <Archive size={14} aria-hidden /> {t('archive.open')}
            </Button>
            <Button heldReason={manageHeld} onClick={() => actions?.onAddress?.({ mode: 'edit' })}>
              <Pencil size={14} aria-hidden /> {t('edit.open')}
            </Button>
          </>
        )}
        <Button variant="primary" heldReason={archived ? t('held.archived') : manageHeld} onClick={() => actions?.onAddress?.({ mode: 'replace' })}>
          <FileUp size={14} aria-hidden /> {t('replace.open')}
        </Button>
      </>
    )
  }

  return (
    <DetailModal
      open
      onClose={close}
      title={chemical?.name ?? t('chemical.noun')}
      subtitle={chemical ? `${t(`use.${chemical.use}`)} · ${chemical.site.name}` : undefined}
      meta={
        chemical ? (
          <span className="fw-ch-meta">
            <SignalWord word={chemical.signalWord} say={t} />
            <Pill tone={STATE_TONE[chemical.sheetState]} dot>
              {t(sheetStateKey(chemical.sheetState), { language: t(`lang.${chemical.language}`) })}
            </Pill>
            {chemical.status !== 'ACTIVE' && <Pill tone="neutral">{t(`status.${chemical.status}`)}</Pill>}
          </span>
        ) : undefined
      }
      nav={ids.includes(state.id) && state.mode === 'view' ? { ids, current: state.id, onGo: (id) => actions?.onAddress?.({ open: id }), noun: t('chemical.noun') } : undefined}
      loading={state.read.status === 'loading'}
      error={state.read.status === 'error' ? t(state.read.problem) : undefined}
      onRetry={actions?.onRetryOpen}
      footer={footer}
    >
      {chemical && record && (
        <div className="fw-ch-stack">
          {state.saved && <Banner tone="success" title={t(state.saved.key, state.saved.params ?? {})} />}
          {state.problem && !state.problem.field && <Banner tone="danger" title={t(state.problem.key)} />}
          {state.mode === 'edit' && state.draft ? (
            <ChemicalFields draft={state.draft} choices={state.choices} problem={state.problem} onDraft={(draft) => actions?.onEditDraft?.(draft)} />
          ) : state.mode === 'replace' ? (
            <ReplaceBody chemical={chemical} state={state} today={model.today} actions={actions} />
          ) : state.mode === 'archive' ? (
            <div className="fw-ch-form">
              <p className="fw-ch-muted">{t('archive.kept')}</p>
              <Field label={t('archive.reason')} required>
                <Textarea value={state.reason} rows={3} maxLength={500} onChange={(event) => actions?.onArchiveReason?.(event.target.value)} />
              </Field>
            </div>
          ) : (
            <div className="fw-ch-window">
              <div className="fw-ch-stack">
                <Facts chemical={chemical} />
                <section className="fw-ch-section" aria-labelledby="fw-ch-sheets">
                  <span className="fw-ch-row">
                    <h3 id="fw-ch-sheets" className="fw-ch-h3">
                      {t('window.sheets')}
                    </h3>
                    <LawRef law={SDS_LAW} plain={t('law.sds')} labels={ds.lawRef} />
                  </span>
                  {record.sheets.length === 0 ? (
                    <p className="fw-ch-muted">{t('window.noSheets')}</p>
                  ) : (
                    <div className="fw-ch-files">
                      {record.sheets.map((sheet) => (
                        <SheetRow key={sheet.id} sheet={sheet} shown={state.pdf?.sheetId === sheet.id} chemicalId={chemical.id} prefix={model.prefix} day={day} onShow={() => actions?.onShowSheet?.(sheet.id)} />
                      ))}
                    </div>
                  )}
                </section>
              </div>
              <div className="fw-ch-pdf">
                {!state.pdf ? (
                  <p className="fw-ch-muted">{record.sheets.length === 0 ? t('window.noPdf') : t('window.pickSheet')}</p>
                ) : state.pdf.read.status === 'ready' ? (
                  <PdfViewer src={state.pdf.read.value.bytes} title={state.pdf.read.value.fileName} fileName={state.pdf.read.value.fileName} labels={pdfViewerLabels(shell)} height="min(64vh, 680px)" />
                ) : state.pdf.read.status === 'error' ? (
                  <Banner
                    tone="warning"
                    title={t('window.pdfFailed')}
                    action={
                      <Button size="sm" onClick={() => actions?.onShowSheet?.(state.pdf!.sheetId)}>
                        {t('common.retry')}
                      </Button>
                    }
                  >
                    {t(state.pdf.read.problem)}
                  </Banner>
                ) : (
                  <p className="fw-ch-muted" role="status">
                    {t('window.pdfLoading')}
                  </p>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </DetailModal>
  )
}

/** The facts of the chemical (a definition list; codes as CLP writes them). */
function Facts({ chemical }: { chemical: Chemical }) {
  const t = useWords()
  const unit = (code: QuantityUnit) => t(`unit.${code}`)
  return (
    <dl className="fw-ch-facts">
      <dt>{t('window.supplier')}</dt>
      <dd>{chemical.supplier.name ?? t('register.noSupplier')}</dd>
      <dt>{t('window.pictograms')}</dt>
      <dd>
        <GhsMarks codes={chemical.ghsPictograms} say={t} big />
      </dd>
      <dt>{t('window.hazards')}</dt>
      <dd className="fw-ch-codes">{chemical.hazardStatements.join(' ') || '—'}</dd>
      <dt>{t('window.precautions')}</dt>
      <dd className="fw-ch-codes">{chemical.precautionStatements.join(' ') || '—'}</dd>
      <dt>{t('window.place')}</dt>
      <dd>{placeOf(chemical)}</dd>
      <dt>{t('window.maxQuantity')}</dt>
      <dd>{quantityOf(chemical, unit) ?? '—'}</dd>
      <dt>{t('window.roles')}</dt>
      <dd>{chemical.roles.map((role) => role.name).join(', ') || t('window.noRoles')}</dd>
      <dt>{t('window.ppe')}</dt>
      <dd>{chemical.ppe.map((item) => item.name).join(', ') || t('window.noPpe')}</dd>
      {chemical.note && (
        <>
          <dt>{t('window.note')}</dt>
          <dd>{chemical.note}</dd>
        </>
      )}
    </dl>
  )
}

/** One sheet: its file with version, language and day; current or superseded (when, by whom); show it, or its tab. */
function SheetRow({ sheet, shown, chemicalId, prefix, day, onShow }: { sheet: Sheet; shown: boolean; chemicalId: string; prefix: string; day: (value: string | null | undefined) => string; onShow: () => void }) {
  const t = useWords()
  const status = sheet.status === 'CURRENT' ? t('window.current', { version: sheet.versionLabel, language: t(`lang.${sheet.language}`), date: day(sheet.revisedOn) }) : t('window.superseded', { version: sheet.versionLabel, language: t(`lang.${sheet.language}`), date: day(sheet.revisedOn), when: day(sheet.supersededAt), by: sheet.supersededBy ?? t('window.someone') })
  return (
    <FileRow
      name={sheet.fileName}
      size={sheet.sizeBytes}
      status={status}
      actions={
        <>
          <Button size="sm" variant="quiet" heldReason={shown ? t('held.shown') : null} aria-label={t('window.showNamed', { name: sheet.fileName })} onClick={onShow}>
            {t('window.show')}
          </Button>
          <a className="fw-ch-row" href={sdsHref(prefix, chemicalId, sheet.id)} target="_blank" rel="noopener noreferrer" aria-label={t('window.tabNamed', { name: sheet.fileName })}>
            <ExternalLink size={13} aria-hidden /> {t('window.tab')}
          </a>
        </>
      }
    />
  )
}

/** Replace SDS: the new PDF and its facts, and what it will do in words (the sheet it supersedes, kept). */
function ReplaceBody({ chemical, state, today, actions }: { chemical: Chemical; state: OpenState; today: string; actions?: ChemicalsPageActions | undefined }) {
  const t = useWords()
  const words = replaceWords(chemical, state.sheet)
  return (
    <div className="fw-ch-form">
      <p className="fw-ch-muted">{t('replace.hint')}</p>
      <SheetFields draft={state.sheet} problem={state.problem} today={today} onDraft={(sheet, file) => actions?.onReplaceDraft?.(sheet, file)} />
      <Banner tone={words.key.startsWith('refusal.') ? 'warning' : 'info'} title={t(words.key, { ...words.params, language: t(`lang.${words.params.language ?? state.sheet.language}`) })} />
      <p className="fw-ch-muted">{t('replace.floor')}</p>
    </div>
  )
}

'use client'

import { useEffect, type ReactNode } from 'react'
import Link from 'next/link'
import { CircleCheck, CircleMinus, CircleX, Download, Lock, MoreHorizontal, Plus, Upload } from 'lucide-react'
import { Banner, Card, DateField, Disclosure, EmptyState, KeyValue, Menu, SummaryTable, type MenuItemDef } from '@nexus/ui/components'
import { Button, Spinner, Tag } from '@nexus/ui/primitives'
import { formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { isPageKey } from '../../../../quality/_shared/hooks'
import { CheckList, dash, Freshness, NoAccess, NoticeBanner, RecordFrame, RecordProblem, RecordSkeleton, Section } from '../../../../quality/_shared/parts'
import type { CertificateDetail, Coverage, MaterialOption, StyleFacts, StyleOption } from '../../api'
import {
  acceptsCoverage,
  acceptsPdf,
  coverageGrid,
  draftProblems,
  firstProblem,
  GATE_STOPS,
  holderOf,
  kindOf,
  lapseCells,
  rangeText,
  registerHeld,
  retainUntil,
  type CertificateRecordModel,
  type CheckModel,
  type CoverageDraft,
  type DraftField,
  type CertificateDraft,
  type RecordDialog,
  type RecordTab,
} from '../../model'
import { CertificateFields, CheckGarmentDialog } from '../../view/dialogs'
import { CertMessages, dateLocale, LeftTag, ShortcutsDialog, StatusPill, useDay, useProblemWords } from '../../view/parts'
import { certificateHref } from '../../view/CertificatesListView'
import { AddCoverageDialog, EndCoverageDialog, RegisterDialog, StatusDialog, useRegisterLines } from './dialogs'

export interface CertificateRecordActions {
  onDialog?: (dialog: RecordDialog | null) => void
  onRetry?: () => void
  onDock?: () => void
  onCopy?: (text: string) => void
  onDismissNotice?: () => void
  // a draft's details
  onEdit?: (open: boolean) => void
  onEditDraft?: (draft: CertificateDraft) => void
  onEditTouch?: (field: DraftField) => void
  onSaveEdit?: () => void
  // moves
  onRegister?: () => void
  onStatusReason?: (reason: string) => void
  onMove?: (move: 'suspend' | 'withdraw' | 'reinstate') => void
  // coverage
  onCoverageDraft?: (draft: CoverageDraft) => void
  onCoverageQuery?: (query: string) => void
  onCoverageStyle?: (style: StyleOption) => void
  onCoverageItem?: (item: MaterialOption) => void
  onAddCoverage?: () => void
  onEndReason?: (reason: string) => void
  onEndCoverage?: () => void
  // the lapse check
  onLapseDate?: (date: string) => void
  onLapseRun?: () => void
  // files
  onPdf?: (file: File) => void
  onDownload?: (fileId: string) => void
  // Check a garment
  onCheckQuery?: (query: string) => void
  onCheckStyle?: (style: StyleOption) => void
  onCheckClearStyle?: () => void
  onCheckPatch?: (patch: Partial<Pick<CheckModel, 'colourwayId' | 'size' | 'date'>>) => void
  onCheckRun?: () => void
}

/**
 * SCR-051 the certificate record (design compliance.certificates "Record: Certificate"; 00 §2.2; Owner L1: tabs in the
 * band): ‹ Certificates, "<number> · <standard> · class X", holder, notified body and model as meta, the status and the
 * validity in words, the next step as the primary — Register… on a draft (held with the first open check), Check a
 * garment on a valid one, Reinstate… on a suspended one — and ⋯ (Mark suspended…, Mark withdrawn…, Copy number, Keys).
 * Tabs: Coverage (what it covers per style: colourway × size, made-to-measure, the parts it covers; what it blocks when
 * it lapses), Notified body, Files (its PDF), Activity (the record panels). Fetches nothing: CertificateRecord.tsx does.
 */
export function CertificateRecordView({ model, actions, panels }: { model: CertificateRecordModel; actions?: CertificateRecordActions; panels?: ReactNode }) {
  return (
    <CertMessages>
      <Record model={model} actions={actions} panels={panels} />
    </CertMessages>
  )
}

function Record({ model, actions, panels }: { model: CertificateRecordModel; actions?: CertificateRecordActions; panels?: ReactNode }) {
  const t = useT('certificates')
  const back = { href: `${model.prefix}/compliance/certificates`, label: t('record.back') }
  if (!model.can.view) return <NoAccess title={t('noAccess.title')} body={t('noAccess.body')} />
  if (model.detail.problem)
    return (
      <RecordProblem
        problem={model.detail.problem}
        back={
          <Button size="sm" asChild>
            <Link href={back.href}>{t('record.backToList')}</Link>
          </Button>
        }
        onRetry={actions?.onRetry}
      />
    )
  if (!model.detail.value) return <RecordSkeleton />
  return <Ready certificate={model.detail.value} model={model} actions={actions} panels={panels} back={back} />
}

function Ready({ certificate, model, actions, panels, back }: { certificate: CertificateDetail; model: CertificateRecordModel; actions?: CertificateRecordActions; panels?: ReactNode; back: { href: string; label: string } }) {
  const t = useT('certificates')
  const can = model.can
  const dialog = model.dialog
  const holder = holderOf(certificate, model.companies, model.brands)
  const registerWhy = registerHeld(certificate, can, model.today)
  const manageHeld = can.manage ? null : t('held.manage')
  const tabs = [
    { id: 'coverage', label: t('tab.coverage'), count: certificate.coverage.filter((entry) => entry.status === 'ACTIVE').length },
    { id: 'body', label: t('tab.body') },
    { id: 'files', label: t('tab.files'), count: model.files?.value ? model.files.value.filter((file) => file.status === 'AVAILABLE').length : null },
    { id: 'activity', label: t('tab.activity') },
  ]

  // k: Check a garment, r: Register (a draft), ?: the keys; never while typing or in a dialog.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (dialog || !isPageKey(event)) return
      if (event.key === 'k') {
        event.preventDefault()
        actions?.onDialog?.({ kind: 'check' })
      } else if (event.key === 'r' && certificate.status === 'DRAFT') {
        event.preventDefault()
        actions?.onDialog?.({ kind: 'register' })
      } else if (event.key === '?') {
        event.preventDefault()
        actions?.onDialog?.({ kind: 'shortcuts' })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [actions, certificate.status, dialog])

  const primary =
    certificate.status === 'DRAFT' ? (
      <Button size="sm" variant="primary" heldReason={registerWhy ? t(registerWhy) : null} onClick={() => actions?.onDialog?.({ kind: 'register' })} aria-keyshortcuts="r">
        {t('action.register')}
      </Button>
    ) : certificate.status === 'SUSPENDED' ? (
      <Button size="sm" variant="primary" heldReason={manageHeld} onClick={() => actions?.onDialog?.({ kind: 'status', move: 'reinstate' })}>
        {t('action.reinstate')}
      </Button>
    ) : (
      <Button size="sm" variant={certificate.status === 'VALID' ? 'primary' : 'secondary'} heldReason={can.styles ? null : t('check.held.styles')} onClick={() => actions?.onDialog?.({ kind: 'check' })} aria-keyshortcuts="k">
        {t('check.open')}
      </Button>
    )
  const held = (ok: boolean) => (ok ? {} : { disabled: true, description: t('held.manage') })
  const more: MenuItemDef[] = [
    ...(certificate.status === 'VALID' ? [{ id: 'suspend', label: t('action.suspend'), onSelect: () => actions?.onDialog?.({ kind: 'status', move: 'suspend' }), ...held(can.manage) }] : []),
    ...(certificate.nextStatuses.includes('WITHDRAWN') ? [{ id: 'withdraw', label: t('action.withdraw'), tone: 'danger' as const, onSelect: () => actions?.onDialog?.({ kind: 'status', move: 'withdraw' }), ...held(can.manage) }] : []),
    ...(certificate.status === 'SUSPENDED' ? [{ id: 'reinstate', label: t('action.reinstate'), onSelect: () => actions?.onDialog?.({ kind: 'status', move: 'reinstate' }), ...held(can.manage) }] : []),
    ...(certificate.status !== 'DRAFT' ? [{ id: 'check', label: t('check.open'), onSelect: () => actions?.onDialog?.({ kind: 'check' }) }] : []),
    { id: 'files', label: t('action.files'), href: certificateHref(model.prefix, certificate.id, 'tab=files') },
    { id: 'copy', label: t('action.copyNumber'), onSelect: () => actions?.onCopy?.(certificate.number) },
    { id: 'sep', separator: true },
    { id: 'keys', label: t('keys.title'), onSelect: () => actions?.onDialog?.({ kind: 'shortcuts' }) },
  ]

  const title = (
    <span className="fw-ce-title">
      {certificate.number}{' '}
      <span className="fw-ce-title-sub fw-ce-hide-phone">
        · {certificate.standard}
        {certificate.ppeClass ? ` · ${t(kindOf(certificate.standard) === 'PROTECTOR' ? 'list.level' : 'list.class', { class: certificate.ppeClass })}` : ''}
      </span>
    </span>
  )
  const meta = (
    <span className="fw-q-tags">
      <span>{t(`holder.${holder.kind}`)}: {dash(holder.name)}</span>
      <span>· {t('record.bodyMeta', { number: certificate.notifiedBodyNumber, name: certificate.notifiedBodyName })}</span>
      {certificate.modelReference && <span>· {t('record.modelMeta', { model: certificate.modelReference })}</span>}
    </span>
  )
  const status = (
    <span className="fw-q-tags">
      <StatusPill status={certificate.status} />
      <LeftTag certificate={certificate} today={model.today} />
      <Freshness asOf={model.asOf} live={model.live} />
    </span>
  )

  const body = (() => {
    switch (model.tab as RecordTab) {
      case 'coverage':
        return <CoverageTab certificate={certificate} model={model} actions={actions} />
      case 'body':
        return <BodyTab certificate={certificate} model={model} />
      case 'files':
        return <FilesTab certificate={certificate} model={model} actions={actions} />
      case 'activity':
        return panels ?? <Section title={t('tab.activity')}>{<p className="fw-q-hint">{t(can.threads ? 'record.noPanels' : 'record.panelsHeld')}</p>}</Section>
    }
  })()

  return (
    <>
      <RecordFrame
        back={back}
        title={title}
        meta={meta}
        status={status}
        actions={
          <>
            {primary}
            <Menu align="right" label={<MoreHorizontal size={16} aria-hidden />} triggerProps={{ 'aria-label': t('record.more') }} items={more} />
          </>
        }
        tabs={tabs}
        active={model.tab}
        tabHref={(tab) => certificateHref(model.prefix, certificate.id, `tab=${tab}`)}
        dock={panels && model.tab !== 'activity' ? panels : undefined}
        dockOpen={model.dockOpen}
        onDock={actions?.onDock}
      >
        <div className="fw-q-stack">
          <NoticeBanner notice={model.notice} namespace="certificates" onDismiss={actions?.onDismissNotice} />
          <StateBanner certificate={certificate} />
          {body}
        </div>
      </RecordFrame>

      {dialog?.kind === 'register' && <RegisterDialog certificate={certificate} model={model} actions={actions} />}
      {dialog?.kind === 'status' && <StatusDialog certificate={certificate} move={dialog.move} model={model} actions={actions} />}
      {dialog?.kind === 'coverage' && <AddCoverageDialog certificate={certificate} model={model} actions={actions} />}
      {dialog?.kind === 'endCoverage' && <EndCoverageDialog certificate={certificate} coverageId={dialog.coverageId} model={model} actions={actions} />}
      {dialog?.kind === 'check' && model.check && (
        <CheckGarmentDialog
          model={model.check}
          can={can}
          today={model.today}
          actions={{ onQuery: actions?.onCheckQuery, onPickStyle: actions?.onCheckStyle, onClearStyle: actions?.onCheckClearStyle, onCheck: actions?.onCheckPatch, onRun: actions?.onCheckRun, onClose: () => actions?.onDialog?.(null) }}
        />
      )}
      <ShortcutsDialog
        open={dialog?.kind === 'shortcuts'}
        onClose={() => actions?.onDialog?.(null)}
        keys={[
          { keys: ['k'], does: t('keys.check') },
          { keys: ['r'], does: t('keys.register') },
          { keys: ['⌘', 'J'], does: t('keys.thread') },
          { keys: ['?'], does: t('keys.help') },
        ]}
      />
    </>
  )
}

/** What the state means now: registered (only its status changes), suspended, withdrawn or expired, with the body's words. */
function StateBanner({ certificate }: { certificate: CertificateDetail }) {
  const t = useT('certificates')
  const day = useDay()
  const reason = certificate.statusReason ? <p className="fw-q-hint fw-ce-data">{certificate.statusReason}</p> : null
  const since = certificate.statusChangedAt ? day(certificate.statusChangedAt.slice(0, 10)) : '—'
  switch (certificate.status) {
    case 'DRAFT':
      return <Banner tone="info" title={t('state.draft')} />
    case 'VALID':
      return certificate.daysToExpiry < 0 ? (
        <Banner tone="danger" title={t('state.pastValidity', { date: day(certificate.validTo) })} />
      ) : (
        <Banner tone="info" icon={<Lock size={16} aria-hidden />} title={t('state.registered')} />
      )
    case 'SUSPENDED':
      return (
        <Banner tone="warning" title={t('state.suspended', { date: since })}>
          {reason}
          <p className="fw-q-hint">{t('state.suspendedBlocks')}</p>
        </Banner>
      )
    case 'WITHDRAWN':
      return (
        <Banner tone="danger" title={t('state.withdrawn', { date: since })}>
          {reason}
        </Banner>
      )
    case 'EXPIRED':
      return (
        <Banner tone="danger" title={t('state.expired', { date: day(certificate.validTo) })}>
          <p className="fw-q-hint">{t('state.expiredBlocks')}</p>
        </Banner>
      )
  }
}

// ---- Coverage --------------------------------------------------------------------------------------------------------------

function CoverageTab({ certificate, model, actions }: { certificate: CertificateDetail; model: CertificateRecordModel; actions?: CertificateRecordActions }) {
  const t = useT('certificates')
  const can = model.can
  const active = certificate.coverage.filter((entry) => entry.status === 'ACTIVE')
  const ended = certificate.coverage.filter((entry) => entry.status === 'ARCHIVED')
  const styles = active.filter((entry) => entry.styleId)
  const items = active.filter((entry) => entry.itemId)
  const addHeld = !can.manage ? t('held.manage') : !acceptsCoverage(certificate.status) ? t('held.noCoverage', { status: t(`status.${certificate.status}`) }) : null
  return (
    <>
      <div className="fw-q-two">
        <DetailsCard certificate={certificate} model={model} actions={actions} />
        {certificate.status === 'DRAFT' ? <RegisterCard certificate={certificate} model={model} actions={actions} /> : <LapseCard certificate={certificate} model={model} actions={actions} />}
      </div>
      <Section
        title={t('coverage.title')}
        sub={t('coverage.intro')}
        actions={
          <Button size="sm" variant="primary" heldReason={addHeld} onClick={() => actions?.onDialog?.({ kind: 'coverage' })}>
            <Plus size={14} aria-hidden /> {t('coverage.add')}
          </Button>
        }
      >
        {active.length === 0 ? (
          <EmptyState title={t('coverage.empty.title')} description={t(certificate.status === 'DRAFT' ? 'coverage.empty.draft' : 'coverage.empty.body')} />
        ) : (
          <div className="fw-ce-coverages">
            {styles.map((coverage) => (
              <StyleCoverage key={coverage.id} coverage={coverage} style={coverage.styleId ? model.styles[coverage.styleId] : undefined} model={model} actions={actions} />
            ))}
            {items.length > 0 && (
              <div className="fw-ce-items">
                <h3 className="fw-ce-h3">{t('coverage.items')}</h3>
                <SummaryTable
                  label={t('coverage.items')}
                  stackOnPhone
                  columns={[t('coverage.col.item'), t('coverage.col.note'), t('coverage.col.since'), '']}
                  rows={items.map((coverage) => ({
                    id: coverage.id,
                    cells: [
                      coverage.item ? (
                        <span key="i" className="fw-q-cell">
                          {can.materials ? (
                            <Link className="fw-q-link fw-q-code" href={`${model.prefix}/products/materials/${encodeURIComponent(coverage.item.id)}`}>
                              {coverage.item.code}
                            </Link>
                          ) : (
                            <span className="fw-q-code">{coverage.item.code}</span>
                          )}
                          <span className="nds-summary-sub">{coverage.item.name}</span>
                        </span>
                      ) : (
                        '—'
                      ),
                      dash(coverage.note),
                      <Since key="s" at={coverage.createdAt} />,
                      <Button key="e" size="sm" variant="quiet" heldReason={can.manage ? null : t('held.manage')} onClick={() => actions?.onDialog?.({ kind: 'endCoverage', coverageId: coverage.id })}>
                        {t('coverage.end')}
                      </Button>,
                    ],
                  }))}
                />
              </div>
            )}
          </div>
        )}
        {ended.length > 0 && (
          <Disclosure summary={t('coverage.ended', { count: ended.length })}>
            <ul className="fw-q-lines">
              {ended.map((coverage) => (
                <li key={coverage.id}>
                  <span className="fw-q-code">{coverage.style?.code ?? coverage.item?.code ?? '—'}</span> {coverage.style?.name ?? coverage.item?.name ?? ''} · {t('coverage.endedOn')} <Since at={coverage.updatedAt} />
                  {coverage.note ? <span className="fw-q-hint"> · {coverage.note}</span> : null}
                </li>
              ))}
            </ul>
          </Disclosure>
        )}
      </Section>
    </>
  )
}

function Since({ at }: { at: string }) {
  const locale = useLocale()
  return <time dateTime={at}>{formatDateTime(at, { locale })}</time>
}

const CELL_ICON = {
  covered: <CircleCheck size={14} aria-hidden />,
  notCovered: <CircleX size={14} aria-hidden />,
  notOffered: <CircleMinus size={14} aria-hidden />,
} as const

/** One covered style: colourway × size (✓ covered / ✕ not covered / – not offered, words AND marks), its scope said in words. */
function StyleCoverage({ coverage, style, model, actions }: { coverage: Coverage; style: StyleFacts | null | undefined; model: CertificateRecordModel; actions?: CertificateRecordActions }) {
  const t = useT('certificates')
  const can = model.can
  const ref = coverage.style
  const styleLink = ref ? (
    <Link className="fw-q-link fw-q-code" href={`${model.prefix}/products/styles/${encodeURIComponent(ref.id)}?tab=compliance`}>
      {ref.code}
    </Link>
  ) : (
    <span className="fw-q-code">—</span>
  )
  const grid = style ? coverageGrid(coverage, style) : null
  const scope = (
    <span className="fw-q-tags">
      <Tag tone="info">{coverage.colourwayIds.length === 0 ? t('coverage.allColours') : t('coverage.someColours', { count: coverage.colourwayIds.length })}</Tag>
      <Tag tone="info">{coverage.sizes.length === 0 ? t('coverage.wholeRange') : t('coverage.someSizes', { sizes: rangeText(coverage.sizes) })}</Tag>
      <Tag tone={coverage.allowsMadeToMeasure ? 'success' : 'neutral'}>{t(coverage.allowsMadeToMeasure ? 'coverage.mtm' : 'coverage.noMtm')}</Tag>
    </span>
  )
  return (
    <Card padded>
      <div className="fw-ce-style">
        <div className="fw-q-section-head">
          <div className="fw-q-section-title">
            <h3 className="fw-ce-h3">
              {styleLink} <span className="fw-ce-title-sub">{ref?.name}</span>
            </h3>
            {scope}
          </div>
          <Button size="sm" variant="quiet" heldReason={can.manage ? null : t('held.manage')} onClick={() => actions?.onDialog?.({ kind: 'endCoverage', coverageId: coverage.id })}>
            {t('coverage.end')}
          </Button>
        </div>
        {coverage.note && <p className="fw-q-hint">{coverage.note}</p>}
        {style === undefined ? (
          <p className="fw-q-loading">
            <Spinner size={12} /> {t('coverage.loadingStyle')}
          </p>
        ) : style === null || !grid ? (
          <p className="fw-q-hint">{t(can.styles ? 'coverage.styleFailed' : 'coverage.styleHeld')}</p>
        ) : grid.rows.length === 0 ? (
          <p className="fw-q-hint">{t('coverage.noColourways')}</p>
        ) : (
          <>
            <div className="fw-ce-scroll">
              <table className="fw-ce-grid" aria-label={t('coverage.gridLabel', { style: style.code })}>
                <thead>
                  <tr>
                    <th scope="col" className="fw-ce-corner">
                      {t('coverage.colourway')}
                    </th>
                    {grid.sizes.map((size) => (
                      <th key={size} scope="col">
                        {size}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {grid.rows.map((row) => (
                    <tr key={row.id}>
                      <th scope="row">
                        <span className="fw-q-code">{row.code}</span> <span className="fw-ce-hide-phone fw-q-hint">{row.name}</span>
                        {row.archived && <Tag tone="neutral">{t('coverage.archivedColourway')}</Tag>}
                      </th>
                      {row.cells.map((cell) => (
                        <td key={cell.size} className={`fw-ce-cell is-${cell.state}`} aria-label={t('coverage.cell', { colourway: row.code, size: cell.size, state: t(`cell.${cell.state}`) })}>
                          {CELL_ICON[cell.state]}
                          <span className="fw-ce-cell-word">{t(`cellShort.${cell.state}`)}</span>
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="fw-q-hint">{t('coverage.counts', { covered: grid.covered, offered: grid.offered })}</p>
          </>
        )}
      </div>
    </Card>
  )
}

/** The certificate as typed from the notified body's paper; a draft's details are edited here (Save with the version). */
function DetailsCard({ certificate, model, actions }: { certificate: CertificateDetail; model: CertificateRecordModel; actions?: CertificateRecordActions }) {
  const t = useT('certificates')
  const day = useDay()
  const words = useProblemWords()
  const holder = holderOf(certificate, model.companies, model.brands)
  const edit = model.edit
  if (edit) {
    const first = firstProblem(draftProblems(edit.draft))
    const held = first ? words(first) : edit.busy ? t('held.busy') : null
    return (
      <Section
        title={t('details.title')}
        sub={t('details.editing')}
        actions={
          <>
            <Button size="sm" onClick={() => actions?.onEdit?.(false)}>
              {t('common.back')}
            </Button>
            <Button size="sm" variant="primary" heldReason={held} onClick={() => actions?.onSaveEdit?.()}>
              {edit.busy ? <Spinner size={12} /> : null} {t('details.save')}
            </Button>
          </>
        }
      >
        <CertificateFields model={{ draft: edit.draft, touched: edit.touched, companies: model.companies, brands: model.brands }} onDraft={actions?.onEditDraft} onTouch={actions?.onEditTouch} />
        {edit.problem && (
          <Banner tone="danger" title={t(edit.problem)}>
            {edit.lines.length > 0 && (
              <ul className="fw-q-lines">
                {edit.lines.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            )}
          </Banner>
        )}
      </Section>
    )
  }
  return (
    <Section
      title={t('details.title')}
      sub={t(certificate.status === 'DRAFT' ? 'details.draft' : 'details.registered')}
      actions={
        certificate.status === 'DRAFT' ? (
          <Button size="sm" heldReason={model.can.manage ? null : t('held.manage')} onClick={() => actions?.onEdit?.(true)}>
            {t('details.edit')}
          </Button>
        ) : undefined
      }
    >
      <KeyValue
        columns={2}
        labelCase="sentence"
        items={[
          { label: t('field.standard'), value: certificate.standard, hint: t(`kind.${kindOf(certificate.standard)}`) },
          { label: t(kindOf(certificate.standard) === 'PROTECTOR' ? 'field.level' : 'field.class'), value: dash(certificate.ppeClass) },
          { label: t('field.number'), value: certificate.number },
          { label: t('field.holder'), value: dash(holder.name), hint: t(`holder.${holder.kind}`) },
          { label: t('field.bodyName'), value: certificate.notifiedBodyName, hint: certificate.notifiedBodyNumber },
          { label: t('field.model'), value: dash(certificate.modelReference) },
          { label: t('field.validFrom'), value: day(certificate.validFrom) },
          { label: t('field.validTo'), value: day(certificate.validTo), hint: <LeftTag certificate={certificate} today={model.today} /> },
          ...(certificate.note ? [{ label: t('field.note'), value: certificate.note }] : []),
        ]}
      />
    </Section>
  )
}

/** What a draft needs before Register (the same checklist the confirm shows). */
function RegisterCard({ certificate, model, actions }: { certificate: CertificateDetail; model: CertificateRecordModel; actions?: CertificateRecordActions }) {
  const t = useT('certificates')
  const checks = useRegisterLines(certificate, model.today)
  const why = registerHeld(certificate, model.can, model.today)
  return (
    <Section
      title={t('register.title')}
      sub={t('register.intro')}
      actions={
        <Button size="sm" variant="primary" heldReason={why ? t(why) : null} onClick={() => actions?.onDialog?.({ kind: 'register' })}>
          {t('action.register')}
        </Button>
      }
    >
      <CheckList checks={checks} label={t('register.title')} />
    </Section>
  )
}

/**
 * What it blocks when it lapses (the lapse check): on a chosen day — the day after its last valid day by default — the
 * certificate gate is asked about every garment this certificate covers; what it would refuse, why, and what that stops
 * (the work order's release, the garment label on the floor, the final release and the shipment).
 */
function LapseCard({ certificate, model, actions }: { certificate: CertificateDetail; model: CertificateRecordModel; actions?: CertificateRecordActions }) {
  const t = useT('certificates')
  const locale = useLocale()
  const day = useDay()
  const lapse = model.lapse
  const { cells, capped } = lapseCells(certificate, Object.fromEntries(Object.entries(model.styles).map(([id, style]) => [id, style ?? undefined])))
  const stylesLoading = certificate.coverage.some((entry) => entry.status === 'ACTIVE' && entry.styleId && model.styles[entry.styleId] === undefined)
  const covering = certificate.status !== 'WITHDRAWN'
  const held = !covering ? t('lapse.held.withdrawn') : !model.can.styles ? t('check.held.styles') : stylesLoading ? t('held.busy') : cells.length === 0 ? t('lapse.held.nothing') : lapse.state === 'running' ? t('held.busy') : null
  const summary = lapse.summary
  return (
    <Section title={t('lapse.title')} sub={t('lapse.intro')}>
      <div className="fw-ce-lapse-ask">
        <span className="fw-ce-date">
          <DateField value={lapse.date} onChange={(value) => actions?.onLapseDate?.(value)} locale={dateLocale(locale)} placeholder={t('date.notSet')} clearLabel={t('date.clear')} clearable={false} id="fw-ce-lapse-date" />
        </span>
        <Button size="sm" onClick={() => actions?.onLapseDate?.(model.today)}>
          {t('lapse.today')}
        </Button>
        <Button size="sm" variant="primary" heldReason={held} onClick={() => actions?.onLapseRun?.()}>
          {lapse.state === 'running' ? <Spinner size={12} /> : null} {t('lapse.run', { count: cells.length })}
        </Button>
      </div>
      <p className="fw-q-hint">{t('lapse.garments', { count: cells.length })}{capped ? ` ${t('lapse.capped')}` : ''}</p>
      <div role="status" aria-live="polite" className="fw-ce-lapse">
        {lapse.state === 'running' && (
          <p className="fw-q-loading">
            <Spinner size={12} /> {t('lapse.running', { done: lapse.done, total: lapse.total })}
          </p>
        )}
        {lapse.state === 'failed' && <Banner tone="danger" title={t('lapse.failed')} />}
        {lapse.state === 'done' && summary && (
          <>
            <Banner tone={summary.refused > 0 ? 'danger' : 'success'} title={summary.refused > 0 ? t('lapse.refused', { count: summary.refused, total: summary.total, date: day(lapse.date) }) : t('lapse.allCovered', { total: summary.total, date: day(lapse.date) })}>
              {summary.refused > 0 && <p className="fw-q-hint">{t('lapse.stopsIntro')}</p>}
              {summary.refused > 0 && (
                <ul className="fw-ce-stops" aria-label={t('lapse.stopsLabel')}>
                  {GATE_STOPS.map((stop) => (
                    <li key={stop}>{t(`stop.${stop}`)}</li>
                  ))}
                </ul>
              )}
              {summary.unknown > 0 && <p className="fw-q-hint">{t('lapse.unknown', { count: summary.unknown })}</p>}
            </Banner>
            <ul className="fw-ce-groups">
              {summary.groups.map((group) => (
                <li key={`${group.styleId}-${group.colourwayCode}-${group.outcome}-${group.codes.join(',')}-${group.coveredBy ?? ''}`} className={`fw-ce-group is-${group.outcome}`}>
                  <span className="fw-q-cell-row">
                    <Tag tone={group.outcome === 'refused' ? 'danger' : group.outcome === 'unknown' ? 'neutral' : 'success'}>{t(`lapse.outcome.${group.outcome}`)}</Tag>
                    <span className="fw-q-code">{group.styleCode}</span>
                    <span>{group.colourwayCode}</span>
                    <span className="fw-q-hint">{t('lapse.sizes', { sizes: group.sizes.join(', ') })}</span>
                  </span>
                  {group.outcome === 'refused' && <span>{group.codes.map((code) => t(`gate.${code}`)).join(' · ')}</span>}
                  {group.outcome === 'covered' && group.coveredBy && <span className="fw-q-hint">{t(group.coveredBy === certificate.number ? 'lapse.stillThis' : 'lapse.coveredBy', { number: group.coveredBy })}</span>}
                  {group.messages.length > 0 && <span className="fw-q-hint fw-ce-data">{group.messages.join(' ')}</span>}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
      <p className="fw-q-hint">{t('lapse.notServed')}</p>
    </Section>
  )
}

// ---- Notified body -----------------------------------------------------------------------------------------------------

function BodyTab({ certificate, model }: { certificate: CertificateDetail; model: CertificateRecordModel }) {
  const t = useT('certificates')
  const q = useT('quality')
  const day = useDay()
  const others = model.sameBody
  return (
    <div className="fw-q-two">
      <Section title={t('body.title')} sub={t('body.intro')}>
        <KeyValue
          labelCase="sentence"
          items={[
            { label: t('body.name'), value: certificate.notifiedBodyName },
            { label: t('body.number'), value: <span className="fw-q-num">{certificate.notifiedBodyNumber}</span>, hint: t('body.numberHint') },
          ]}
        />
        <span className="fw-q-tags">
          <Tag tone="neutral">{t('law.annexV')}</Tag>
        </span>
      </Section>
      <Section title={t('body.others')}>
        {!others || (!others.value && !others.problem) ? (
          <p className="fw-q-loading">
            <Spinner size={12} /> {q('common.loading')}
          </p>
        ) : others.problem ? (
          <p className="fw-q-hint">{q(others.problem)}</p>
        ) : others.value!.length === 0 ? (
          <p className="fw-q-hint">{t('body.noOthers')}</p>
        ) : (
          <SummaryTable
            label={t('body.others')}
            stackOnPhone
            columns={[t('csv.number'), t('csv.standard'), t('list.col.valid'), t('list.col.status')]}
            rows={others.value!.map((other) => ({
              id: other.id,
              cells: [
                <Link key="n" className="fw-q-link fw-q-code" href={certificateHref(model.prefix, other.id)}>
                  {other.number}
                </Link>,
                other.standard,
                t('list.validRange', { from: day(other.validFrom), to: day(other.validTo) }),
                <StatusPill key="s" status={other.status} />,
              ],
            }))}
          />
        )}
      </Section>
    </div>
  )
}

// ---- Files -------------------------------------------------------------------------------------------------------------

function FilesTab({ certificate, model, actions }: { certificate: CertificateDetail; model: CertificateRecordModel; actions?: CertificateRecordActions }) {
  const t = useT('certificates')
  const q = useT('quality')
  const day = useDay()
  const can = model.can
  const files = model.files
  const pdfs = (files?.value ?? []).filter((file) => file.kind === 'CERTIFICATE')
  const others = (files?.value ?? []).filter((file) => file.kind !== 'CERTIFICATE')
  const uploadHeld = !can.manage ? t('held.manage') : !can.upload ? t('held.upload') : !acceptsPdf(certificate.status) ? t('files.held.status', { status: t(`status.${certificate.status}`) }) : model.busy ? t('held.busy') : null
  const until = retainUntil(certificate.validTo)
  const fileRows = (list: typeof pdfs) =>
    list.map((file) => ({
      id: file.id,
      cells: [
        <span key="n" className="fw-q-cell">
          <span className="fw-q-code">{file.originalName}</span>
          <span className="nds-summary-sub">{t(`fileStatus.${file.status === 'AVAILABLE' ? 'AVAILABLE' : file.status === 'QUARANTINED' ? 'QUARANTINED' : 'PENDING'}`)}</span>
        </span>,
        t('files.size', { kb: Math.max(1, Math.round(file.sizeBytes / 1024)) }),
        <Since key="d" at={file.createdAt} />,
        file.status === 'AVAILABLE' ? (
          <Button key="g" size="sm" variant="quiet" onClick={() => actions?.onDownload?.(file.id)}>
            <Download size={13} aria-hidden /> {t('files.download')}
          </Button>
        ) : (
          '—'
        ),
      ],
    }))
  return (
    <div className="fw-q-two">
      <Section
        title={t('files.title')}
        sub={t(certificate.hasPdf ? 'files.hasPdf' : 'files.noPdf')}
        actions={
          <label className="fw-ce-upload">
            <Button size="sm" variant={certificate.hasPdf ? 'secondary' : 'primary'} heldReason={uploadHeld} onClick={(event) => (event.currentTarget.parentElement?.querySelector('input') as HTMLInputElement | null)?.click()}>
              {model.busy ? <Spinner size={12} /> : <Upload size={14} aria-hidden />} {t(certificate.hasPdf ? 'files.addAnother' : 'files.upload')}
            </Button>
            <input
              type="file"
              hidden
              accept=".pdf,application/pdf"
              aria-label={t('files.upload')}
              onChange={(event) => {
                const file = event.target.files?.[0]
                if (file) actions?.onPdf?.(file)
                event.target.value = ''
              }}
            />
          </label>
        }
      >
        {!can.filesRead ? (
          <p className="fw-q-hint">{t('files.readHeld')}</p>
        ) : !files || (!files.value && !files.problem) ? (
          <p className="fw-q-loading">
            <Spinner size={12} /> {q('common.loading')}
          </p>
        ) : files.problem ? (
          <p className="fw-q-hint">{q(files.problem)}</p>
        ) : pdfs.length === 0 ? (
          <EmptyState title={t('files.empty.title')} description={t('files.empty.body')} />
        ) : (
          <SummaryTable label={t('files.title')} stackOnPhone density="roomy" columns={[t('files.col.name'), t('files.col.size'), t('files.col.added'), '']} rows={fileRows(pdfs)} />
        )}
        {others.length > 0 && <SummaryTable label={t('files.others')} stackOnPhone density="roomy" columns={[t('files.col.name'), t('files.col.size'), t('files.col.added'), '']} rows={fileRows(others)} />}
      </Section>
      <Section title={t('files.retention.title')}>
        <p>{until ? t('files.retention.body', { years: 10, date: day(until) }) : '—'}</p>
        <p className="fw-q-hint">{t('files.retention.added')}</p>
      </Section>
    </div>
  )
}

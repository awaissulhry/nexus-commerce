'use client'

import { useState } from 'react'
import Link from 'next/link'
import { ArrowRight, CircleCheck, CircleMinus, CircleX, Download, ListTodo, Upload } from 'lucide-react'
import { Banner, Card, EmptyState, Field, KeyValue, SummaryTable } from '@nexus/ui/components'
import { Button, Input, Pill, RadioCard, Select, Spinner, Tag } from '@nexus/ui/primitives'
import { FileDropzone, Modal } from '../../../../../lib/i18n/ds-parts'
import { formatDate } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { TaskNewDialog } from '../../../../../record-panels/view/TaskNewDialog'
import type { CoverageCell, LanguageStatus, StyleComplianceView, StyleTypeChanges, StyleView } from '../../api'
import { CELL_TONE, CHECK_TONE, documentFileProblem, revisionInView } from '../../model'
import type { StyleRecordActions, StyleRecordViewModel } from '../../record/record-model'

const DOC_TONE = { CURRENT: 'success', OLDER_REVISION: 'warning', MISSING: 'danger' } as const

/**
 * SCR-045 Compliance of the revision in view: the PPE classification in words, every check with what it stops
 * (production, labels, shipping), the certificate coverage per colourway × size with its certificates and their
 * validity, the garment label the revision names (a draft names an active template here), the signed EU declaration
 * of conformity and the user information leaflet per language (upload a signed PDF, download the current one; older
 * versions are kept), and how the garments are traced. The certificates and label templates themselves are kept in
 * Compliance; this tab reads them for the style.
 */
export function ComplianceTab({ style, model, actions }: { style: StyleView; model: StyleRecordViewModel; actions?: StyleRecordActions }) {
  const t = useT('products')
  if (model.compliance.status === 'loading' || model.compliance.status === 'idle')
    return (
      <Card padded aria-busy="true">
        <p className="fw-st-hint" role="status">
          <Spinner size={14} /> {t('compliance.loading')}
        </p>
      </Card>
    )
  if (model.compliance.status === 'error')
    return <Banner tone="danger" title={t('compliance.failed')} action={<Button size="sm" onClick={() => actions?.onReload?.()}>{t('common.retry')}</Button>}>{t(model.compliance.problem)}</Banner>
  const compliance = model.compliance.value
  const dialog = model.dialog?.kind === 'upload' ? model.dialog : null
  return (
    <div className="fw-st-stack-lg">
      <div className="fw-st-pair">
        <ChecksCard compliance={compliance} model={model} style={style} />
        <ClassCard compliance={compliance} style={style} model={model} />
      </div>
      <CoverageCard compliance={compliance} model={model} />
      <TypeChangesCard model={model} actions={actions} />
      <DocumentsCard compliance={compliance} model={model} actions={actions} />
      <div className="fw-st-pair">
        <LabelCard compliance={compliance} style={style} model={model} actions={actions} />
        <TrackingCard style={style} model={model} actions={actions} />
      </div>
      {dialog && <UploadDialog compliance={compliance} model={model} actions={actions} kind={dialog.documentKind} language={dialog.language} />}
      {model.dialog?.kind === 'tellCompliance' && model.typeChanges.status === 'ready' && <TellComplianceDialog style={style} changes={model.typeChanges.value} certificateId={model.dialog.certificateId} model={model} actions={actions} />}
    </div>
  )
}

function ChecksCard({ compliance, model, style }: { compliance: StyleComplianceView; model: StyleRecordViewModel; style: StyleView }) {
  const t = useT('products')
  const blocked = compliance.checks.filter((check) => check.state === 'BLOCKED').length
  const revision = compliance.revision
  return (
    <Card header={t('compliance.checks.title')} description={revision ? t('compliance.checks.intro', { revision: revision.revision, status: t(`revisionStatus.${revision.status}`) }) : t('compliance.checks.noRevision')}>
      <ul className="fw-st-checklist">
        {compliance.checks.map((check) => (
          <li key={check.code} className={`fw-st-check ${check.state === 'OK' ? 'is-ok' : check.state === 'BLOCKED' ? 'is-blocked' : ''}`}>
            {check.state === 'OK' ? <CircleCheck size={14} aria-hidden /> : check.state === 'BLOCKED' ? <CircleX size={14} aria-hidden /> : <CircleMinus size={14} aria-hidden />}
            <span className="fw-st-cellstack">
              <span>{t(`complianceCheck.${check.code}.${check.state}`)}</span>
              {check.state === 'BLOCKED' && <span className="fw-st-hint">{t('release.blocks', { steps: check.blocks.map((step) => t(`blocks.${step}`)).join(', ') })}</span>}
            </span>
            <Pill tone={CHECK_TONE[check.state]}>{t(`checkState.${check.state}`)}</Pill>
          </li>
        ))}
      </ul>
      {blocked === 0 && <p className="fw-st-inline fw-st-ok">{t('compliance.checks.allOk')}</p>}
      {model.revisionId && compliance.revision && compliance.revision.id !== model.revisionId && (
        <p className="fw-st-hint">
          <Link className="fw-st-link" href={`${model.prefix}/products/styles/${style.id}?tab=compliance&rev=${compliance.revision.id}`}>
            {t('compliance.checks.other', { revision: compliance.revision.revision })}
          </Link>
        </p>
      )}
    </Card>
  )
}

function ClassCard({ compliance, style, model }: { compliance: StyleComplianceView; style: StyleView; model: StyleRecordViewModel }) {
  const t = useT('products')
  const c = compliance.classification
  const maker = compliance.documents.maker
  return (
    <Card
      header={t('compliance.class.title')}
      headerAction={
        model.can.manage ? (
          <Link className="fw-st-link" href={`${model.prefix}/products/styles/${style.id}?tab=overview`}>
            {t('compliance.class.change')}
          </Link>
        ) : undefined
      }
    >
      <KeyValue
        columns={2}
        labelCase="sentence"
        items={[
          { label: t('compliance.class.category'), value: t(`ppe.category.${c.category}`), hint: t(`ppe.why.${c.category}`) },
          { label: t('ppe.standard'), value: c.standard ?? '—', hint: c.part ? t('compliance.class.part', { part: c.part, edition: c.edition ?? '—' }) : undefined },
          { label: t('ppe.class'), value: c.ppeClass ?? '—', hint: c.partClass && c.partClass !== c.ppeClass ? t('compliance.class.partClass', { class: c.partClass }) : undefined },
          { label: t('compliance.class.maker'), value: maker ? maker.makerName : t(c.legalMaker === 'BRAND' ? 'compliance.class.brand' : 'compliance.class.company'), hint: maker?.makerAddress },
          { label: t('compliance.class.certificate'), value: t(c.certificateRequired ? 'common.yes' : 'common.no') },
          { label: t('compliance.class.documents'), value: t(c.documentsRequired ? 'common.yes' : 'common.no') },
        ]}
      />
    </Card>
  )
}

// ---- W2a (B-W2a-66): changes that may need the notified body ------------------------------------------------------------------

const REVIEW_TONE = { OPEN: 'warning', NOTIFIED: 'info', APPROVED: 'success', REFUSED: 'danger', NOT_NEEDED: 'neutral' } as const

/**
 * Style › Compliance › Changes that may need the notified body (design style.cp.change, W2a; PRD-285, Reg. (EU) 2016/425
 * Annex V 7.2): what the revision in view changes in the outer leather, its thickness, a protector model, the seams or the
 * lining against the type each covering certificate approved (a draft: found now; a released revision: its review), each
 * change as before → after (a composed ChangeValue), whether its class label is held, and "Tell Compliance" (a task on
 * the style). Hidden when nothing relevant changed.
 */
function TypeChangesCard({ model, actions }: { model: StyleRecordViewModel; actions?: StyleRecordActions }) {
  const t = useT('products')
  const part = model.typeChanges
  if (part.status === 'error')
    return <Banner tone="warning" title={t('typeChange.failed')} action={<Button size="sm" onClick={() => actions?.onReload?.()}>{t('common.retry')}</Button>} />
  if (part.status !== 'ready') return null
  const relevant = part.value.certificates.filter((entry) => entry.changes.length > 0 || entry.reviews.some((review) => review.holdsLabel))
  if (relevant.length === 0) return null
  const revision = part.value.revision
  const held = !model.can.tellCompliance ? t('typeChange.held.task') : null
  return (
    <Card header={t('typeChange.title')} description={t(revision?.status === 'DRAFT' ? 'typeChange.introDraft' : 'typeChange.introReleased', { revision: revision?.revision ?? '—' })}>
      <div className="fw-st-stack">
        {relevant.map((entry) => {
          const review = entry.reviews[0] ?? null
          return (
            <Banner
              key={entry.certificate.id}
              tone={entry.labelHeld ? 'warning' : 'info'}
              title={t(entry.labelHeld ? 'typeChange.banner.held' : review ? 'typeChange.banner.reviewed' : 'typeChange.banner.found', { number: entry.certificate.number, body: entry.certificate.notifiedBodyNumber, compared: entry.comparedRevision?.revision ?? '—' })}
              action={
                <span className="fw-st-inline">
                  <Button size="sm" asChild>
                    <Link href={`${model.prefix}/compliance/certificates/${encodeURIComponent(entry.certificate.id)}?tab=renewals`}>{t('typeChange.open')}</Link>
                  </Button>
                  {!review && (
                    <Button size="sm" variant="primary" heldReason={held} onClick={() => actions?.onDialog?.({ kind: 'tellCompliance', certificateId: entry.certificate.id })}>
                      <ListTodo size={14} aria-hidden /> {t('typeChange.tell')}
                    </Button>
                  )}
                </span>
              }
            >
              <ul className="fw-st-changes" aria-label={t('typeChange.list', { number: entry.certificate.number })}>
                {entry.changes.map((change, index) => (
                  <li key={index}>
                    <strong>{t(`typeChange.kind.${change.kind}`)}</strong> <span className="fw-st-code">{change.before}</span> <ArrowRight size={12} aria-label={t('typeChange.to')} /> <span className="fw-st-code">{change.after}</span>
                  </li>
                ))}
              </ul>
              {review && (
                <p className="fw-st-inline">
                  <Pill tone={REVIEW_TONE[review.status]} dot>
                    {t(`typeChange.status.${review.status}`)}
                  </Pill>
                  <span className="fw-st-hint">{t(review.holdsLabel ? 'typeChange.labelHeld' : 'typeChange.labelFree')}</span>
                </p>
              )}
              {!review && <p className="fw-st-hint">{t('typeChange.atRelease')}</p>}
            </Banner>
          )
        })}
      </div>
      <p className="fw-st-hint">{t('typeChange.law')}</p>
    </Card>
  )
}

/** "Tell Compliance": the ONE New task dialog, filled with the change (a task on the style, for a person who keeps it). */
function TellComplianceDialog({ style, changes, certificateId, model, actions }: { style: StyleView; changes: StyleTypeChanges; certificateId: string; model: StyleRecordViewModel; actions?: StyleRecordActions }) {
  const t = useT('products')
  const entry = changes.certificates.find((item) => item.certificate.id === certificateId)
  if (!entry) return null
  const revision = changes.revision?.revision ?? '—'
  const lines = entry.changes.map((change) => `${t(`typeChange.kind.${change.kind}`)}: ${change.before} → ${change.after}`)
  return (
    <TaskNewDialog
      recordLabel={`${style.code} · ${style.name}`}
      people={model.taskPeople ?? { status: 'loading' }}
      me={null}
      held={model.can.tellCompliance ? null : t('typeChange.held.task')}
      busy={model.busy}
      initial={{
        title: t('typeChange.task.title', { code: style.code, revision }),
        description: [t('typeChange.task.description', { number: entry.certificate.number, body: entry.certificate.notifiedBodyNumber, revision, compared: entry.comparedRevision?.revision ?? '—' }), ...lines].join('\n'),
        checklist: [t('typeChange.task.step1', { body: entry.certificate.notifiedBodyNumber }), t('typeChange.task.step2')].join('\n'),
      }}
      onCreate={(draft) => actions?.onTellCompliance?.(draft)}
      onClose={() => actions?.onDialog?.(null)}
    />
  )
}

function CoverageCard({ compliance, model }: { compliance: StyleComplianceView; model: StyleRecordViewModel }) {
  const t = useT('products')
  const locale = useLocale()
  const coverage = compliance.coverage
  const [open, setOpen] = useState<CoverageCell | null>(null)
  if (!coverage.required)
    return (
      <Card header={t('compliance.coverage.title')}>
        <EmptyState title={t(compliance.classification.isPpe ? 'coverage.notRequired' : 'coverage.notPpe')} />
      </Card>
    )
  const counts = coverage.counts
  const cellOf = (colourwayId: string, size: string) => coverage.cells.find((cell) => cell.colourwayId === colourwayId && cell.size === size) ?? null
  return (
    <Card header={t('compliance.coverage.title')} description={t('compliance.coverage.intro', { date: formatDate(`${compliance.date}T12:00:00Z`, { locale }) })}>
      <div className="fw-st-stack">
        <span className="fw-st-inline">
          <Tag tone="success">{t('coverage.covered', { count: counts.covered })}</Tag>
          {counts.expiringSoon > 0 && <Tag tone="warning">{t('coverage.expiring', { count: counts.expiringSoon })}</Tag>}
          {counts.notCovered > 0 && <Tag tone="danger">{t('coverage.notCoveredCount', { count: counts.notCovered })}</Tag>}
          {counts.expired > 0 && <Tag tone="danger">{t('compliance.coverage.expired', { count: counts.expired })}</Tag>}
          {counts.suspended > 0 && <Tag tone="warning">{t('compliance.coverage.suspended', { count: counts.suspended })}</Tag>}
          <span className="fw-st-hint">{t('coverage.ofOffered', { count: counts.offered })}</span>
        </span>
        {coverage.colourways.length === 0 ? (
          <p className="fw-st-hint">{t('compliance.coverage.noColourways')}</p>
        ) : (
          <div className="fw-st-scroll">
            <table className="fw-st-matrix fw-st-coverage" aria-label={t('compliance.coverage.title')}>
              <thead>
                <tr>
                  <th scope="col" className="fw-st-matrix-corner">
                    {t('matrix.colourway')}
                  </th>
                  {coverage.sizes.map((size) => (
                    <th key={size} scope="col">
                      {size}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {coverage.colourways.map((colourway) => (
                  <tr key={colourway.id}>
                    <th scope="row">
                      <span className="fw-st-matrix-row">
                        <b>{colourway.code}</b> <span className="fw-st-hide-phone">{colourway.name}</span>
                      </span>
                    </th>
                    {coverage.sizes.map((size) => {
                      const cell = cellOf(colourway.id, size)
                      if (!cell) return <td key={size}>—</td>
                      return (
                        <td key={size} className={`is-cover-${cell.status.toLowerCase()}${cell.offered ? '' : ' is-closed'}`}>
                          <button
                            type="button"
                            className="fw-st-matrix-cell"
                            onClick={() => setOpen(cell)}
                            aria-label={t('compliance.coverage.cell', { colourway: colourway.code, size, status: t(`cellStatus.${cell.status}`), until: cell.certificate ? formatDate(`${cell.certificate.validTo}T12:00:00Z`, { locale }) : '—' })}
                          >
                            <Pill tone={!cell.offered ? 'neutral' : cell.status === 'COVERED' && cell.expiringSoon ? 'warning' : CELL_TONE[cell.status]}>
                              {cell.status === 'COVERED' ? (cell.expiringSoon ? t('compliance.coverage.daysLeft', { count: cell.daysToExpiry ?? 0 }) : t('compliance.coverage.ok')) : t(`cellShort.${cell.status}`)}
                            </Pill>
                          </button>
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="fw-st-hint">{t('compliance.coverage.legend')}</p>
        {coverage.certificates.length > 0 && (
          <div className="fw-st-scroll">
            <SummaryTable
              label={t('compliance.coverage.certificates')}
              stackOnPhone
              columns={[t('compliance.coverage.certificate'), t('ppe.standard'), t('compliance.coverage.body'), t('compliance.coverage.valid'), t('compliance.coverage.covers')]}
              rows={coverage.certificates.map((entry) => ({
                id: entry.coverageId,
                cells: [
                  <span key="n" className="fw-st-cellstack">
                    <Link className="fw-st-link" href={`${model.prefix}/compliance/certificates/${entry.certificate.id}`}>
                      <b>{entry.certificate.number}</b>
                    </Link>
                    <span className="nds-summary-sub">{t(`certStatus.${entry.certificate.status}`)}</span>
                  </span>,
                  `${entry.certificate.standard}${entry.certificate.ppeClass ? ` · ${entry.certificate.ppeClass}` : ''}`,
                  `${entry.certificate.notifiedBodyNumber} · ${entry.certificate.notifiedBodyName}`,
                  <span key="v" className="fw-st-cellstack">
                    <span>
                      {formatDate(`${entry.certificate.validFrom}T12:00:00Z`, { locale })} – {formatDate(`${entry.certificate.validTo}T12:00:00Z`, { locale })}
                    </span>
                    <span className={entry.certificate.daysToExpiry <= 60 ? 'fw-st-warn' : 'nds-summary-sub'}>{t('compliance.coverage.daysLeft', { count: entry.certificate.daysToExpiry })}</span>
                  </span>,
                  t('compliance.coverage.coversValue', { sizes: entry.sizes.join(', '), count: entry.colourwayIds.length }),
                ],
              }))}
            />
          </div>
        )}
      </div>
      {open && (
        <Modal open onClose={() => setOpen(null)} size="sm" title={t('compliance.coverage.cellTitle', { colourway: coverage.colourways.find((entry) => entry.id === open.colourwayId)?.code ?? '', size: open.size })} footer={<Button onClick={() => setOpen(null)}>{t('common.close')}</Button>}>
          <div className="fw-st-dialog">
            <span className="fw-st-inline">
              <Pill tone={CELL_TONE[open.status]}>{t(`cellStatus.${open.status}`)}</Pill>
              {!open.offered && <Tag tone="neutral">{t('compliance.coverage.notOffered')}</Tag>}
            </span>
            {open.certificate && <p>{t('sku.certificate', { number: open.certificate.number, until: formatDate(`${open.certificate.validTo}T12:00:00Z`, { locale }) })}</p>}
            {open.reasons.length > 0 && (
              <ul className="fw-st-list">
                {open.reasons.map((reason, index) => (
                  <li key={index}>{t(`gate.${reason.code}`)}</li>
                ))}
              </ul>
            )}
            {open.status !== 'COVERED' && open.status !== 'NOT_REQUIRED' && <p className="fw-st-hint">{t('compliance.coverage.blocks')}</p>}
            {model.can.complianceView && <p className="fw-st-hint">{t('compliance.coverage.where')}</p>}
          </div>
        </Modal>
      )}
    </Card>
  )
}

function DocumentsCard({ compliance, model, actions }: { compliance: StyleComplianceView; model: StyleRecordViewModel; actions?: StyleRecordActions }) {
  const t = useT('products')
  const locale = useLocale()
  const docs = compliance.documents
  if (!docs.required)
    return (
      <Card header={t('compliance.docs.title')}>
        <p className="fw-st-hint">{t('compliance.docs.notRequired')}</p>
      </Card>
    )
  const revision = compliance.revision
  const held = !model.can.declarations ? t('compliance.docs.held.right') : !revision ? t('held.noRevision') : model.busy ? t('held.busy') : null
  const rows = (entries: readonly LanguageStatus[]) =>
    entries.map((entry) => ({
      id: `${entry.kind}:${entry.language}`,
      cells: [
        <b key="l">{entry.language.toUpperCase()}</b>,
        <span key="s" className="fw-st-cellstack">
          <Pill tone={DOC_TONE[entry.state]}>{t(`docState.${entry.state}`, { revision: entry.revision ?? 0 })}</Pill>
          {entry.pendingUpload && <span className="nds-summary-sub">{t('compliance.docs.pending')}</span>}
        </span>,
        entry.document ? (
          <span key="d" className="fw-st-cellstack">
            <span>{entry.document.number ?? entry.document.currentFile?.originalName ?? '—'}</span>
            <span className="nds-summary-sub">
              {entry.document.issuedAt ? t('compliance.docs.issued', { date: formatDate(entry.document.issuedAt, { locale }) }) : ''}
              {entry.document.versions > 1 ? ` · ${t('compliance.docs.versions', { count: entry.document.versions })}` : ''}
            </span>
          </span>
        ) : (
          '—'
        ),
        <span key="a" className="fw-st-inline">
          {entry.document?.currentFile && (
            <Button size="sm" variant="quiet" onClick={() => actions?.onDownload?.(entry.document!.id, entry.document!.currentFile!.id)} aria-label={t('compliance.docs.downloadOne', { language: entry.language.toUpperCase() })}>
              <Download size={13} aria-hidden /> {t('compliance.docs.download')}
            </Button>
          )}
          <Button size="sm" variant={entry.state === 'CURRENT' ? 'quiet' : 'secondary'} heldReason={held} onClick={() => actions?.onDialog?.({ kind: 'upload', documentKind: entry.kind, language: entry.language })} aria-label={t('compliance.docs.uploadOne', { language: entry.language.toUpperCase() })}>
            <Upload size={13} aria-hidden /> {t(entry.state === 'CURRENT' ? 'compliance.docs.newVersion' : 'compliance.docs.upload')}
          </Button>
        </span>,
      ],
    }))
  return (
    <Card
      header={t('compliance.docs.title')}
      description={revision ? t('compliance.docs.intro', { revision: revision.revision, languages: docs.expectedLanguages.map((language) => language.toUpperCase()).join(', ') || '—' }) : undefined}
      headerAction={
        <Button size="sm" heldReason={held} onClick={() => actions?.onDialog?.({ kind: 'upload', documentKind: 'DECLARATION_OF_CONFORMITY', language: '' })}>
          <Upload size={13} aria-hidden /> {t('compliance.docs.uploadOther')}
        </Button>
      }
    >
      <div className="fw-st-stack-lg">
        {(['DECLARATION_OF_CONFORMITY', 'USER_INFORMATION'] as const).map((kind) => {
          const entries = kind === 'DECLARATION_OF_CONFORMITY' ? docs.declarations : docs.leaflets
          return (
            <div key={kind} className="fw-st-stack">
              <h3 className="fw-st-h3">{t(`docKind.${kind}`)}</h3>
              {entries.length === 0 ? (
                <p className="fw-st-hint">{t('compliance.docs.noLanguages')}</p>
              ) : (
                <SummaryTable
                  label={t(`docKind.${kind}`)}
                  density="roomy"
                  stackOnPhone
                  columns={[t('compliance.docs.language'), t('compliance.docs.state'), t('compliance.docs.document'), t('compliance.docs.actions')]}
                  widths={['12%', '22%', '36%', undefined]}
                  align={[undefined, undefined, undefined, 'right']}
                  rows={rows(entries)}
                />
              )}
            </div>
          )
        })}
      </div>
      {docs.maker && <p className="fw-st-hint">{t('compliance.docs.maker', { name: docs.maker.makerName, address: docs.maker.makerAddress })}</p>}
    </Card>
  )
}

function LabelCard({ compliance, style, model, actions }: { compliance: StyleComplianceView; style: StyleView; model: StyleRecordViewModel; actions?: StyleRecordActions }) {
  const t = useT('products')
  const revision = compliance.revision
  const label = revision?.labelTemplate ?? null
  const viewing = revisionInView(style.revisions, model.revisionId)
  const canName = model.can.labels && viewing?.status === 'DRAFT' && style.status !== 'ARCHIVED'
  const templates = (model.libraries.labels ?? []).filter((template) => template.styleId === null || template.styleId === style.id)
  const [chosen, setChosen] = useState<string>(label?.id ?? '')
  return (
    <Card header={t('compliance.label.title')} description={t('compliance.label.intro')}>
      <div className="fw-st-stack">
        {label ? (
          <KeyValue
            columns={2}
            labelCase="sentence"
            items={[
              {
                label: t('compliance.label.template'),
                value: (
                  <Link className="fw-st-link" href={`${model.prefix}/compliance/labels/${label.id}`}>
                    {`${label.code} · ${t('revisions.rev', { revision: label.revision })}`}
                  </Link>
                ),
              },
              { label: t('compliance.label.status'), value: <Pill tone={label.status === 'ACTIVE' ? 'success' : 'warning'}>{t(`labelStatus.${label.status}`)}</Pill> },
              { label: t('compliance.label.languages'), value: label.languages.map((language) => language.toUpperCase()).join(', ') || '—' },
            ]}
          />
        ) : (
          <p className="fw-st-hint">{t('compliance.label.none', { revision: revision?.revision ?? 0 })}</p>
        )}
        {canName && (
          <Field label={t('compliance.label.name')} hint={model.libraries.labels === null ? t('compliance.label.loading') : templates.length === 0 ? t('compliance.label.noTemplates') : t('compliance.label.nameHint')}>
            <span className="fw-st-inline">
              <Select value={chosen} onChange={(event) => setChosen(event.target.value)} aria-label={t('compliance.label.name')}>
                <option value="">{t('compliance.label.noneChosen')}</option>
                {templates.map((template) => (
                  <option key={template.id} value={template.id}>
                    {template.code} · {t('revisions.rev', { revision: template.revision })} · {template.name}
                  </option>
                ))}
              </Select>
              <Button size="sm" heldReason={model.busy ? t('held.busy') : chosen === (label?.id ?? '') ? t('sku.gtinSame') : null} onClick={() => void actions?.onAssignLabel?.(chosen || null)}>
                {t('compliance.label.save')}
              </Button>
            </span>
          </Field>
        )}
        <p className="fw-st-hint">{t('compliance.label.where')}</p>
        {model.can.complianceView && (
          <span className="fw-st-inline">
            <Link className="fw-st-link" href={`${model.prefix}/compliance/labels?q=${encodeURIComponent(style.code)}`}>
              {t('compliance.label.open')}
            </Link>
            {model.can.labels && style.status !== 'ARCHIVED' && (
              <Link className="fw-st-link" href={`${model.prefix}/compliance/labels?new=1&style=${style.id}`}>
                {t('compliance.label.new')}
              </Link>
            )}
          </span>
        )}
      </div>
    </Card>
  )
}

function TrackingCard({ style, model, actions }: { style: StyleView; model: StyleRecordViewModel; actions?: StyleRecordActions }) {
  const t = useT('products')
  const [chosen, setChosen] = useState(style.garmentTracking)
  const editable = model.can.manage && style.status !== 'ARCHIVED'
  const held = !editable ? t(style.status === 'ARCHIVED' ? 'held.archived' : 'held.noManage') : chosen === style.garmentTracking ? t('sku.gtinSame') : model.busy ? t('held.busy') : null
  return (
    <Card header={t('compliance.tracking.title')}>
      <div className="fw-st-stack">
        <p>{t(`tracking.${style.tracking}`)}</p>
        {style.tracking === 'LOT' ? (
          <>
            <fieldset className="fw-st-choices">
              <legend className="fw-st-legend">{t('compliance.tracking.numbering')}</legend>
              {(['BATCH', 'SERIAL'] as const).map((tracking) =>
                editable ? (
                  <RadioCard
                    key={tracking}
                    variant="row"
                    name="fw-st-tracking"
                    value={tracking}
                    checked={chosen === tracking}
                    selected={chosen === tracking}
                    onChange={() => setChosen(tracking)}
                    title={t(`garmentTracking.${tracking}`)}
                    description={t(`garmentTracking.${tracking}_why`)}
                  />
                ) : (
                  tracking === style.garmentTracking && (
                    <p key={tracking}>
                      <b>{t(`garmentTracking.${tracking}`)}</b> — {t(`garmentTracking.${tracking}_why`)}
                    </p>
                  )
                ),
              )}
            </fieldset>
            {editable && (
              <span className="fw-st-inline">
                <Button size="sm" heldReason={held} onClick={() => void actions?.onGarmentTracking?.(chosen)}>
                  {t('compliance.tracking.save')}
                </Button>
              </span>
            )}
            <p className="fw-st-hint">{t('compliance.tracking.fixed')}</p>
          </>
        ) : (
          <p className="fw-st-hint">{t('compliance.tracking.none')}</p>
        )}
      </div>
    </Card>
  )
}

function UploadDialog({ compliance, model, actions, kind: firstKind, language: firstLanguage }: { compliance: StyleComplianceView; model: StyleRecordViewModel; actions?: StyleRecordActions; kind: 'DECLARATION_OF_CONFORMITY' | 'USER_INFORMATION'; language: string }) {
  const t = useT('products')
  const [kind, setKind] = useState(firstKind)
  const [language, setLanguage] = useState(firstLanguage)
  const [number, setNumber] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const revision = compliance.revision
  const held = !file
    ? t('compliance.upload.held.file')
    : !/^[a-z]{2}$/.test(language.trim().toLowerCase())
      ? t('compliance.upload.held.language')
      : !revision
        ? t('held.noRevision')
        : model.busy
          ? t('held.busy')
          : null
  const run = () => {
    if (held || !file) return
    void actions?.onUpload?.({ kind, language: language.trim().toLowerCase(), number: kind === 'DECLARATION_OF_CONFORMITY' ? number.trim() || null : null, file }).then((ok) => ok && actions?.onDialog?.(null))
  }
  return (
    <Modal
      open
      onClose={() => actions?.onDialog?.(null)}
      size="md"
      title={t('compliance.upload.title', { revision: revision?.revision ?? 0 })}
      footer={
        <>
          <Button onClick={() => actions?.onDialog?.(null)}>{t('common.back')}</Button>
          <Button variant="primary" heldReason={held} onClick={run}>
            {t('compliance.upload.go')}
          </Button>
        </>
      }
    >
      <div className="fw-st-dialog">
        <div className="fw-st-form-grid">
          <Field label={t('compliance.upload.kind')}>
            <Select value={kind} onChange={(event) => setKind(event.target.value as typeof kind)}>
              {(['DECLARATION_OF_CONFORMITY', 'USER_INFORMATION'] as const).map((entry) => (
                <option key={entry} value={entry}>
                  {t(`docKind.${entry}`)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('compliance.docs.language')} hint={t('compliance.upload.languageHint')}>
            <Input value={language} maxLength={2} onChange={(event) => setLanguage(event.target.value.toLowerCase())} autoFocus={!firstLanguage} />
          </Field>
          {kind === 'DECLARATION_OF_CONFORMITY' && (
            <Field label={t('compliance.upload.number')} hint={t('compliance.upload.numberHint')}>
              <Input value={number} maxLength={60} onChange={(event) => setNumber(event.target.value)} />
            </Field>
          )}
        </div>
        <FileDropzone
          accept=".pdf"
          maxBytes={20 * 1024 * 1024}
          hint={t('compliance.upload.hint')}
          onFiles={(files) => {
            const next = files[0] ?? null
            const refused = next ? documentFileProblem(next) : null
            setProblem(refused)
            setFile(refused ? null : next)
          }}
        />
        {file && <p className="fw-st-inline">{t('compliance.upload.chosen', { name: file.name })}</p>}
        {problem && <Banner tone="warning" title={t(problem)} />}
        <p className="fw-st-hint">{t('compliance.upload.what', { revision: revision?.revision ?? 0 })}</p>
      </div>
    </Modal>
  )
}

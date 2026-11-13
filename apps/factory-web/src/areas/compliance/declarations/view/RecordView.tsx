'use client'

import Link from 'next/link'
import { ExternalLink, Lock, MoreHorizontal, RefreshCw } from 'lucide-react'
import { Banner, Card, EmptyState, Field, KeyValue, Menu, SummaryTable, type MenuItemDef } from '@nexus/ui/components'
import { LawRef } from '@nexus/ui/components/LawRef/index'
import { PdfViewer } from '@nexus/ui/components/PdfViewer/index'
import { QrCode } from '@nexus/ui/components/QrCode/index'
import { Button, Input, Pill, SegmentedControl, Spinner } from '@nexus/ui/primitives'
import { formatPublicDocCode, publicDocCodeOf } from '@nexus/factory-domain/compliance/public-doc/code'
import { ConfirmPhraseField, DateField, EditModeBar, Modal, Textarea, Timeline, useDsWords } from '../../../../lib/i18n/ds-parts'
import { pdfViewerLabels } from '../../../../lib/pdf/labels'
import { useT } from '../../../../lib/i18n/provider'
import { CheckList, Freshness, RecordFrame, RecordProblem, RecordSkeleton, Section } from '../../../quality/_shared/parts'
import {
  checkHeld,
  editHeld,
  editOf,
  hasSignatory,
  issueChecks,
  issueHeld,
  LAW,
  packHref,
  pdfHref,
  recordAddressText,
  recordHref,
  saveHeld,
  translatable,
  translateHeld,
  typistsOf,
  withdrawHeld,
  withdrawPhrase,
  type RecordDoc,
  type RecordTab,
} from '../model'
import type { RecordActions, RecordModel } from '../view-model'
import { DeclarationsMessages, GateBanner, ProblemList, SourceTag, StatusPill, useDay, useLanguage, useWords } from './parts'
import { MultiSelect } from '../../../../lib/i18n/ds-parts' // B-W2b-F41: the DS parts in the page's language

/**
 * SCR-052-record — a declaration or a leaflet (design compliance.declarations › rec:Declaration; PRD-292, PRD-293, PRD-295,
 * PRD-300, PRD-350–354): the band (‹ Declarations & instructions, the number with kind, language and revision, its status and
 * origin, Issue — held with the reason: a generated document stays a draft until GATE-PPE-TEXTS — and ⋯ Translate, Withdraw,
 * Refresh, the PDF in a new tab, the public page, the style), then Content (every Annex IX point or Annex II 1.4 section with the
 * law it answers and where each value came from, typed in edit mode while a draft; the PDF beside the fields, one language at a
 * time), Languages, Versions by batch and Publication as link tabs. Fetches nothing: DeclarationRecord.tsx reads and writes.
 */
export function RecordView({ model, actions }: { model: RecordModel; actions?: RecordActions }) {
  return (
    <DeclarationsMessages>
      <Record model={model} actions={actions} />
    </DeclarationsMessages>
  )
}

function Record({ model, actions }: { model: RecordModel; actions?: RecordActions | undefined }) {
  const t = useWords()
  const q = useT('quality')
  const language = useLanguage()
  const back = { href: `${model.prefix}/compliance/declarations`, label: t('record.back') }
  if (!model.can.view) return <RecordProblem problem="problem.forbidden" back={<Link href={back.href}>{back.label}</Link>} />
  if (model.read.status === 'loading') return <RecordSkeleton />
  if (model.read.status === 'error') return <RecordProblem problem={model.read.problem === 'problem.notFound' || model.read.problem === 'problem.forbidden' ? model.read.problem : 'problem.unavailable'} back={<Link href={back.href}>{back.label}</Link>} onRetry={actions?.onRetry} />
  const record = model.read.value
  const { row } = record
  const tab = model.address.tab
  const base = recordHref(model.prefix, row.id)
  const issueReason = t(issueHeld(record))
  const translateWhy = translateHeld(record, ['x'], [], false)
  const withdrawWhy = record.may.withdraw ? null : record.generated ? (row.status !== 'DRAFT' ? 'held.notDraft' : 'held.generate') : 'held.signedWithdraw'
  const checkWhy = record.original ? checkHeld(record, model.userId, typistsOf(record)) : null
  const refreshWhy = !record.generated ? 'held.signedFile' : !record.may.refresh ? (row.status !== 'DRAFT' ? 'held.notDraft' : row.translationStatus === 'CHECKED' ? 'held.checkedEdit' : 'held.generate') : !model.online ? 'held.offline' : null
  const goDialog = (dialog: 'issue' | 'translate' | 'withdraw' | 'check' | 'refresh') => actions?.onAddress?.({ dialog })

  const more: MenuItemDef[] = [
    { id: 'pdf', label: t('record.pdf'), href: pdfHref(model.prefix, row.id), target: '_blank', icon: <ExternalLink size={14} aria-hidden /> },
    ...(record.publicAddress ? [{ id: 'public', label: t('record.public'), href: record.publicAddress, target: '_blank', icon: <ExternalLink size={14} aria-hidden /> } as MenuItemDef] : []),
    { id: 'style', label: t('record.style', { code: row.style.code }), href: `${model.prefix}/products/styles/${encodeURIComponent(row.styleId)}?tab=compliance` },
    { id: 'sep', separator: true } as MenuItemDef,
    { id: 'translate', label: t('record.translate'), disabled: !!translateWhy, description: translateWhy ? t(translateWhy) : undefined, onSelect: () => goDialog('translate') },
    { id: 'refresh', label: t('record.refresh'), disabled: !!refreshWhy, description: refreshWhy ? t(refreshWhy) : undefined, onSelect: () => goDialog('refresh') },
    { id: 'withdraw', label: t('record.withdraw'), disabled: !!withdrawWhy, description: withdrawWhy ? t(withdrawWhy) : undefined, onSelect: () => goDialog('withdraw') },
  ]
  const tabs: { id: RecordTab; label: string; count?: number | null }[] = [
    { id: 'content', label: t('tab.content') },
    { id: 'languages', label: t('tab.languages'), count: record.family.length },
    { id: 'batches', label: t('tab.batches'), count: record.batches.reduce((sum, group) => sum + group.batches.length, 0) },
    { id: 'publication', label: t('tab.publication') },
  ]

  return (
    <RecordFrame
      back={back}
      title={
        <>
          <span className="fw-q-code">{row.number ?? row.style.code}</span> · {t(`kindShort.${row.kind}`)} · {language(row.language)} · {t('common.rev', { revision: row.revision })}
        </>
      }
      meta={
        <span className="fw-q-cell-row">
          <span>{`${row.style.code} · ${row.style.name}`}</span>
          <span className="fw-q-hint">{t(`origin.${row.origin}`)}</span>
          <Freshness asOf={model.readAt} live={model.live} />
        </span>
      }
      status={
        <span className="fw-q-cell-row">
          <StatusPill status={row.status} />
          {record.generated && row.status === 'DRAFT' && <Pill tone="warning">{t('record.draftUntilChecked')}</Pill>}
          {row.translationStatus && <Pill tone={row.translationStatus === 'CHECKED' ? 'success' : 'info'}>{t(`translation.${row.translationStatus}`)}</Pill>}
        </span>
      }
      actions={
        <>
          {record.original && record.generated && row.status === 'DRAFT' && row.translationStatus !== 'CHECKED' && (
            <Button size="sm" heldReason={checkWhy ? t(checkWhy) : !model.online ? t('held.offline') : null} onClick={() => goDialog('check')}>
              {t('record.check')}
            </Button>
          )}
          <Button size="sm" variant="secondary" onClick={() => goDialog('issue')} aria-description={issueReason}>
            <Lock size={13} aria-hidden /> {t('record.issueReview')}
          </Button>
          <Menu align="right" label={<MoreHorizontal size={16} aria-hidden />} triggerProps={{ 'aria-label': t('record.more') }} items={more} />
        </>
      }
      tabs={tabs}
      active={tab}
      tabHref={(id) => `${base}${recordAddressText({ tab: id as RecordTab, dialog: null, edit: false })}`}
    >
      {!model.online && <Banner tone="warning" title={t('offline.title')}>{t('offline.body')}</Banner>}
      {model.notice && (
        <Banner
          tone={model.notice.tone}
          title={t(model.notice.key, { ...(model.notice.params ?? {}), count: model.notice.params?.count ?? 0 })}
          action={
            <Button size="sm" variant="quiet" onClick={() => actions?.onDismissNotice?.()}>
              {q('common.close')}
            </Button>
          }
        />
      )}
      {model.changedAt && (
        <Banner
          tone="info"
          title={t('record.changed')}
          action={
            <Button size="sm" onClick={() => actions?.onReload?.()}>
              {t('record.reload')}
            </Button>
          }
        />
      )}
      {record.generated && row.status === 'DRAFT' && <GateBanner prefix={model.prefix} styleId={row.styleId} kind={record.kind} compact />}
      {row.status === 'WITHDRAWN' && <Banner tone="warning" title={t('record.withdrawn')}>{t('record.withdrawnBody')}</Banner>}
      {model.problem && !model.address.dialog && <Banner tone="danger" title={t(model.problem.key)} />}
      {tab === 'content' && <ContentTab model={model} record={record} actions={actions} />}
      {tab === 'languages' && <LanguagesTab model={model} record={record} actions={actions} />}
      {tab === 'batches' && <BatchesTab model={model} record={record} />}
      {tab === 'publication' && <PublicationTab model={model} record={record} actions={actions} />}
      {model.address.dialog === 'issue' && <IssueDialog model={model} record={record} actions={actions} />}
      {model.address.dialog === 'translate' && <TranslateRecordDialog model={model} record={record} actions={actions} />}
      {model.address.dialog === 'withdraw' && <WithdrawDialog model={model} record={record} actions={actions} />}
      {model.address.dialog === 'check' && <CheckDialog model={model} record={record} actions={actions} />}
      {model.address.dialog === 'refresh' && <RefreshDialog model={model} record={record} actions={actions} />}
    </RecordFrame>
  )
}

// ---- Content -----------------------------------------------------------------------------------------------------------------

function ContentTab({ model, record, actions }: { model: RecordModel; record: RecordDoc; actions?: RecordActions | undefined }) {
  const t = useWords()
  const ds = useDsWords()
  const day = useDay()
  const draft = model.draft
  const editWhy = editHeld(record)
  const leaflet = record.kind === 'USER_INFORMATION'
  const changes = draft ? editOf(record, draft) : null
  const count = changes ? changes.parts.length + Object.keys(changes).length - 1 : 0
  const saveWhy = draft ? saveHeld(record, draft, model.busy) : null
  const { row } = record

  return (
    <div className="fw-dc-content">
      <div className="fw-dc-stack">
        {record.stale && (
          <Banner
            tone="warning"
            title={t('content.stale', { count: record.stale.parts.length })}
            action={
              record.may.refresh ? (
                <Button size="sm" onClick={() => actions?.onAddress?.({ dialog: 'refresh' })}>
                  <RefreshCw size={13} aria-hidden /> {t('record.refresh')}
                </Button>
              ) : undefined
            }
          >
            {record.stale.parts.length > 0 && <p className="fw-dc-p">{t('content.staleParts', { list: record.stale.parts.join(', ') })}</p>}
            {record.stale.lists?.positions && <p className="fw-dc-p">{t('content.staleProtectors')}</p>}
            {record.stale.lists?.spares && <p className="fw-dc-p">{t('content.staleSpares')}</p>}
          </Banner>
        )}
        <ProblemList problems={record.problems} kind={record.kind} />
        {!record.generated ? (
          <Section id="fw-dc-signed" title={t('content.signedTitle')} sub={t('content.signedSub')}>
            <KeyValue
              columns={2}
              labelCase="sentence"
              items={[
                { label: t('content.number'), value: row.number ?? '—' },
                { label: t('content.issued'), value: day(row.issuedAt) },
                { label: t('content.maker'), value: `${row.maker.name} · ${row.maker.address}` },
                { label: t('content.certificate'), value: row.certificate?.number ?? '—' },
                { label: t('content.standards'), value: row.standards.join(', ') || '—' },
                { label: t('content.signedBy'), value: [row.signedByName, row.signedByFunction, row.signedPlace, row.signedOn ? day(row.signedOn) : null].filter(Boolean).join(' · ') || '—' },
              ]}
            />
          </Section>
        ) : (
          <Section
            id="fw-dc-fields"
            title={t(leaflet ? 'content.sectionsTitle' : 'content.pointsTitle')}
            sub={<LawRef law={leaflet ? LAW.userInformation : LAW.doc} plain={t(leaflet ? 'law.userInformation' : 'law.doc')} href={LAW.href} labels={ds.lawRef} />}
            actions={
              draft ? null : (
                <Button size="sm" heldReason={editWhy ? t(editWhy) : !model.online ? t('held.offline') : null} onClick={() => actions?.onEdit?.(true)}>
                  {t('content.edit')}
                </Button>
              )
            }
          >
            {record.template && <p className="fw-dc-muted">{t('content.template', { template: record.template })}</p>}
            {record.parts.length === 0 ? (
              <EmptyState title={t('content.noParts')} />
            ) : (
              <ol className="fw-dc-points">
                {record.parts.map((part) => (
                  <li key={part.id} className={part.open ? 'fw-dc-point is-open' : 'fw-dc-point'}>
                    <span className="fw-dc-pointhead">
                      <b>{leaflet ? t(`section.${part.id}`) : t('part.point', { id: part.id })}</b>
                      <span className="fw-dc-muted">{leaflet ? t(part.law.startsWith('art.') ? 'part.article' : 'part.annexII', { point: part.law }) : t('part.annexIX', { point: part.law })}</span>
                      <SourceTag source={part.source} prefix={model.prefix} showLabel />
                    </span>
                    {draft ? (
                      <Textarea aria-label={leaflet ? t(`section.${part.id}`) : t('part.point', { id: part.id })} value={draft.parts[part.id] ?? ''} rows={part.text.length > 220 ? 5 : 3} maxLength={4000} onChange={(event) => actions?.onDraft?.({ ...draft, parts: { ...draft.parts, [part.id]: event.target.value } })} />
                    ) : (
                      <span className="fw-dc-pointtext">{part.text}</span>
                    )}
                    {part.values.length > 0 && (
                      <span className="fw-dc-values" aria-label={t('content.values')}>
                        {part.values.map((value, index) => (
                          <span key={`${value.field}-${index}`} className="fw-dc-value">
                    <SourceTag source={value.source} value={value.value} prefix={model.prefix} />
                    <span>{value.value}</span>
                  </span>
                        ))}
                      </span>
                    )}
                  </li>
                ))}
              </ol>
            )}
            {draft && hasSignatory(record) && (
              <fieldset className="fw-dc-fieldset">
                <legend>{t('content.signatory')}</legend>
                <div className="fw-dc-formgrid">
                  <Field label={t('content.signedByName')}>
                    <Input value={draft.signedByName} maxLength={200} onChange={(event) => actions?.onDraft?.({ ...draft, signedByName: event.target.value })} />
                  </Field>
                  <Field label={t('content.signedByFunction')}>
                    <Input value={draft.signedByFunction} maxLength={200} onChange={(event) => actions?.onDraft?.({ ...draft, signedByFunction: event.target.value })} />
                  </Field>
                  <Field label={t('content.signedPlace')}>
                    <Input value={draft.signedPlace} maxLength={200} onChange={(event) => actions?.onDraft?.({ ...draft, signedPlace: event.target.value })} />
                  </Field>
                  <Field label={t('content.signedOn')}>
                    <DateField value={draft.signedOn} onChange={(value) => actions?.onDraft?.({ ...draft, signedOn: value })} clearable />
                  </Field>
                </div>
              </fieldset>
            )}
            {draft && (
              <Field label={t('content.number')} hint={t('content.numberHint')}>
                <Input value={draft.number} maxLength={60} onChange={(event) => actions?.onDraft?.({ ...draft, number: event.target.value })} />
              </Field>
            )}
            {!draft && hasSignatory(record) && (
              <p className="fw-dc-muted">{row.signedByName ? t('content.signedAs', { name: row.signedByName, role: row.signedByFunction ?? '—', place: row.signedPlace ?? '—', date: day(row.signedOn) }) : t('content.noSignatory')}</p>
            )}
            {draft && (
              <EditModeBar
                count={count}
                onDiscard={() => actions?.onEdit?.(false)}
                onApply={() => actions?.onSave?.()}
                applyLabel={t('content.save')}
                busy={model.busy}
                applyHeldReason={saveWhy ? t(saveWhy) : null}
                saveShortcut
              />
            )}
          </Section>
        )}
        {leaflet && <ProtectorsPart record={record} />}
      </div>
      <PreviewPanel model={model} record={record} actions={actions} />
    </div>
  )
}

/** PRD-353 / PRD-354: where the protectors sit and the spare protectors that fit, certified at their level. */
function ProtectorsPart({ record }: { record: RecordDoc }) {
  const t = useWords()
  const day = useDay()
  return (
    <Section id="fw-dc-protectors" title={t('protectors.title')} sub={t('protectors.sub')}>
      {record.positions.length === 0 ? (
        <p className="fw-dc-muted">{t('protectors.none')}</p>
      ) : (
        <SummaryTable
          label={t('protectors.title')}
          stackOnPhone
          columns={[t('protectors.col.zone'), t('protectors.col.protector'), t('protectors.col.level'), t('protectors.col.sizes'), t('protectors.col.note')]}
          rows={record.positions.map((position) => ({
            id: position.placementId,
            cells: [t(`zone.${position.pocket}`), `${position.protector.code} · ${position.protector.name}`, `${position.standard} ${position.level}`, position.sizes.join(', ') || t('protectors.everySize'), position.note ?? '—'],
          }))}
        />
      )}
      <h3 className="fw-dc-h3">{t('spares.title')}</h3>
      {record.spares.length === 0 ? (
        <p className="fw-dc-muted">{t('spares.none')}</p>
      ) : (
        <SummaryTable
          label={t('spares.title')}
          stackOnPhone
          columns={[t('spares.col.protector'), t('spares.col.zones'), t('spares.col.level'), t('spares.col.certificate'), t('spares.col.placed')]}
          rows={record.spares.map((spare) => ({
            id: `${spare.itemId}-${spare.zones.join()}`,
            cells: [`${spare.code} · ${spare.name}`, spare.zones.map((zone) => t(`zone.${zone.toUpperCase()}`)).join(', '), `${spare.standard} ${spare.level}`, t('spares.validTo', { number: spare.certificate.number, date: day(spare.certificate.validTo) }), t(spare.placed ? 'spares.placed' : 'spares.alternate')],
          }))}
        />
      )}
    </Section>
  )
}

/** The PDF as it prints, beside the fields (design doc-preview): one language of the family at a time. */
function PreviewPanel({ model, record, actions }: { model: RecordModel; record: RecordDoc; actions?: RecordActions | undefined }) {
  const t = useWords()
  const shell = useT('shell')
  const preview = model.preview
  const shown = record.family.find((entry) => entry.id === preview?.documentId) ?? null
  return (
    <Card padded className="fw-dc-preview">
      <section aria-labelledby="fw-dc-preview-title" className="fw-dc-stack">
        <div className="fw-dc-head">
          <h2 id="fw-dc-preview-title" className="fw-dc-h">
            {t('preview.title')}
          </h2>
          <Link className="fw-dc-link" href={pdfHref(model.prefix, preview?.documentId ?? record.row.id)} target="_blank" rel="noopener">
            {t('preview.newTab')}
          </Link>
        </div>
        {record.family.length > 1 && (
          <SegmentedControl
            ariaLabel={t('preview.language')}
            size="sm"
            wrap
            value={preview?.documentId ?? record.row.id}
            onChange={(id) => actions?.onPreview?.(id)}
            options={record.family.map((entry) => ({ value: entry.id, label: entry.language.toUpperCase() }))}
          />
        )}
        <p className="fw-dc-muted">{record.generated ? t('preview.draftNote') : t('preview.signedNote')}</p>
        {!preview || !preview.pdf || preview.pdf.status === 'loading' ? (
          <p className="fw-dc-muted" role="status">
            <Spinner size={12} /> {t('preview.loading')}
          </p>
        ) : preview.pdf.status === 'error' ? (
          <EmptyState
            title={t(preview.pdf.problem === 'preview.noFile' ? 'preview.noFileTitle' : 'preview.failed')}
            description={t(preview.pdf.problem)}
            action={
              preview.pdf.problem === 'preview.noFile' ? undefined : (
                <Button size="sm" onClick={() => actions?.onRetryPreview?.()}>
                  {t('common.retry')}
                </Button>
              )
            }
          />
        ) : (
          <PdfViewer src={preview.pdf.value} title={`${shown?.language.toUpperCase() ?? ''} ${record.row.number ?? record.row.style.code}`} height="min(72vh, 820px)" labels={pdfViewerLabels(shell)} />
        )}
      </section>
    </Card>
  )
}

// ---- Languages ---------------------------------------------------------------------------------------------------------------

function LanguagesTab({ model, record, actions }: { model: RecordModel; record: RecordDoc; actions?: RecordActions | undefined }) {
  const t = useWords()
  const language = useLanguage()
  const translateWhy = translateHeld(record, ['x'], [], false)
  return (
    <div className="fw-dc-stack">
      <Section
        id="fw-dc-languages"
        title={t('languages.title')}
        sub={t('languages.sub')}
        actions={
          <Button size="sm" variant="primary" heldReason={translateWhy ? t(translateWhy) : !model.online ? t('held.offline') : null} onClick={() => actions?.onAddress?.({ dialog: 'translate' })}>
            {t('languages.add')}
          </Button>
        }
      >
        <SummaryTable
          label={t('languages.title')}
          stackOnPhone
          columns={[t('languages.col.language'), t('languages.col.status'), t('languages.col.translation'), t('languages.col.checkedBy'), t('languages.col.toType'), t('languages.col.market'), t('languages.col.next')]}
          rows={record.family.map((entry) => ({
            id: entry.id,
            cells: [
              <span key="l" className="fw-dc-cell">
                <Link className="fw-dc-link" href={recordHref(model.prefix, entry.id)}>
                  {language(entry.language)}
                </Link>
                <span className="fw-dc-muted">{entry.original ? t('grid.original') : t('grid.translation')}</span>
              </span>,
              <StatusPill key="s" status={entry.status} />,
              entry.translationStatus ? t(`translation.${entry.translationStatus}`) : '—',
              entry.checkedBy ?? '—',
              entry.toType.length === 0 ? t('languages.nothingToType') : t('languages.toType', { count: entry.toType.length, list: entry.toType.join(', ') }),
              entry.marketCode ?? t('languages.everyMarket'),
              entry.id === record.row.id ? (
                t('languages.thisOne')
              ) : (
                <Link key="o" className="fw-dc-link" href={`${recordHref(model.prefix, entry.id)}`}>
                  {t('languages.open')}
                </Link>
              ),
            ],
          }))}
        />
        {record.original && record.row.translationStatus === 'CHECKED' && record.generated && record.row.status === 'DRAFT' && (
          <p className="fw-dc-row">
            <span className="fw-dc-muted">{t('languages.checkedNote')}</span>
            <Button size="sm" variant="quiet" heldReason={record.may.edit || record.may.check || record.may.withdraw ? null : t('held.generate')} onClick={() => actions?.onBackToTranslator?.(record.row.id, record.row.version)}>
              {t('languages.undoCheck')}
            </Button>
          </p>
        )}
      </Section>
      {record.kind === 'USER_INFORMATION' && record.packs.length > 0 && (
        <Section id="fw-dc-packs" title={t('packs.title')} sub={t('packs.sub')}>
          <SummaryTable
            label={t('packs.title')}
            stackOnPhone
            columns={[t('packs.col.market'), t('packs.col.languages'), t('packs.col.live'), t('packs.col.missing')]}
            rows={record.packs.map((pack) => ({
              id: pack.market.code,
              cells: [
                `${pack.market.code} · ${pack.market.name}${pack.market.switchedOn ? '' : ` (${t('packs.off')})`}`,
                pack.languages.map((entry) => `${entry.language.toUpperCase()} ${t(`pack.${entry.state}`)}`).join(' · ') || '—',
                t(pack.live ? 'packs.liveYes' : 'packs.liveNo'),
                pack.missing.map((tag) => tag.toUpperCase()).join(', ') || '—',
              ],
            }))}
          />
        </Section>
      )}
    </div>
  )
}

// ---- Versions by batch --------------------------------------------------------------------------------------------------------

function BatchesTab({ model, record }: { model: RecordModel; record: RecordDoc }) {
  const t = useWords()
  const day = useDay()
  const groups = [...record.batches].sort((a, b) => b.revision - a.revision)
  return (
    <Section id="fw-dc-batches" title={t('batches.title')} sub={t('batches.sub')}>
      {groups.length === 0 ? (
        <EmptyState title={t('batches.noneTitle')} description={t('batches.none')} />
      ) : (
        <Timeline
          label={t('batches.title')}
          steps={groups.map((group) => ({
            key: `r${group.revision}`,
            tone: group.revision === record.row.revision ? 'success' : 'neutral',
            label: t('batches.revision', { revision: group.revision, count: group.batches.length }),
            at: group.batches[0]?.firstRecordedAt ?? null,
            detail: (
              <span className="fw-dc-stack">
                <span className="fw-dc-muted">{group.documents.map((document) => `${document.number ?? document.language.toUpperCase()} (${t(`status.${document.status}`)})`).join(' · ') || t('batches.noDocuments')}</span>
                {group.batches.map((batch) => (
                  <span key={batch.batchNumber} className="fw-dc-row">
                    <Link className="fw-dc-link" href={`${model.prefix}/compliance/evidence/batch/${encodeURIComponent(batch.batchNumber)}`}>
                      {t('batches.batch', { number: batch.batchNumber })}
                    </Link>
                    <span className="fw-dc-muted">{t('batches.recorded', { date: day(batch.firstRecordedAt) })}</span>
                    {(batch.shipments ?? []).map((shipment) => (
                      <span key={shipment.id} className="fw-dc-row">
                        <Link className="fw-dc-link" href={`${model.prefix}/warehouse/shipments/${encodeURIComponent(shipment.id)}`}>
                          {t('batches.ddt', { number: shipment.number })}
                        </Link>
                        {model.can.shipping && (
                          <Link className="fw-dc-link" href={packHref(model.prefix, shipment.id)} target="_blank" rel="noopener">
                            {t('batches.pack')}
                          </Link>
                        )}
                      </span>
                    ))}
                  </span>
                ))}
              </span>
            ),
          }))}
        />
      )}
      <p className="fw-dc-muted">{t('batches.kept')}</p>
    </Section>
  )
}

// ---- Publication --------------------------------------------------------------------------------------------------------------

function PublicationTab({ model, record, actions }: { model: RecordModel; record: RecordDoc; actions?: RecordActions | undefined }) {
  const t = useWords()
  const ds = useDsWords()
  const code = publicDocCodeOf(record.row.styleId)
  const address = record.publicAddress
  const shipments = [...new Map(record.batches.flatMap((group) => group.batches.flatMap((batch) => batch.shipments ?? [])).map((shipment) => [shipment.id, shipment])).values()]
  return (
    <div className="fw-dc-two">
      <Section id="fw-dc-public" title={t('publication.title')} sub={<LawRef law={LAW.docWithGoods} plain={t('law.docWithGoods')} href={LAW.href} labels={ds.lawRef} />}>
        {address ? (
          <div className="fw-dc-qr">
            <QrCode value={address} code={formatPublicDocCode(code)} label={t('publication.qr', { style: record.row.style.code })} size={168} labels={{ copy: t('publication.copy'), copied: t('publication.copied'), copyFailed: t('notice.copyFailed', { text: address }), loading: t('common.loading'), tooLong: t('publication.tooLong') }} />
            <span className="fw-dc-stack">
              <span className="fw-dc-code">{address}</span>
              <span className="fw-dc-muted">{record.kind === 'USER_INFORMATION' ? t('publication.leafletAddress') : record.publicLive ? t('publication.live') : t('publication.notLive')}</span>
              <span className="fw-dc-row">
                <Button size="sm" onClick={() => actions?.onCopy?.(address, 'address')}>
                  {t('publication.copy')}
                </Button>
                <a className="fw-dc-link" href={address} target="_blank" rel="noopener">
                  {t('publication.preview')}
                </a>
              </span>
            </span>
          </div>
        ) : (
          <p className="fw-dc-muted">{t('publication.none')}</p>
        )}
        <p className="fw-dc-muted">{t('publication.labels')}</p>
        <Link className="fw-dc-link" href={`${model.prefix}/compliance/labels?q=${encodeURIComponent(record.row.style.code)}`}>
          {t('publication.openLabels')}
        </Link>
        <p className="fw-dc-muted">{t('publication.portal')}</p>
      </Section>
      <Section id="fw-dc-packs-sent" title={t('publication.packsTitle')} sub={t('publication.packsSub')}>
        {shipments.length === 0 ? (
          <p className="fw-dc-muted">{t('publication.noShipments')}</p>
        ) : (
          <ul className="fw-dc-list">
            {shipments.map((shipment) => (
              <li key={shipment.id} className="fw-dc-row">
                <span>{t('batches.ddt', { number: shipment.number })}</span>
                {model.can.shipping ? (
                  <Link className="fw-dc-link" href={packHref(model.prefix, shipment.id)} target="_blank" rel="noopener">
                    {t('publication.openPack')}
                  </Link>
                ) : (
                  <span className="fw-dc-muted">{t('held.shipping')}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  )
}

// ---- dialogs -------------------------------------------------------------------------------------------------------------------

/** Issue (design pop:dc-issue): the review, and why a generated document is not issued here (GATE-PPE-TEXTS, Owner 11-09 B). */
function IssueDialog({ model, record, actions }: { model: RecordModel; record: RecordDoc; actions?: RecordActions | undefined }) {
  const t = useWords()
  const close = () => actions?.onAddress?.({ dialog: null })
  const checks = issueChecks(record)
  const held = issueHeld(record)
  return (
    <Modal
      open
      onClose={close}
      title={t('issue.title', { revision: record.row.revision })}
      size="lg"
      footer={
        <>
          <Button onClick={close}>{t('common.close')}</Button>
          <Button variant="primary" heldReason={t(held)}>
            {t('issue.do', { revision: record.row.revision })}
          </Button>
        </>
      }
    >
      <div className="fw-dc-form">
        {record.generated ? (
          <>
            <Banner tone="info" title={t('issue.gateTitle')}>
              <p className="fw-dc-p">{t('issue.gateBody')}</p>
              <Link className="fw-dc-link" href={`${model.prefix}/products/styles/${encodeURIComponent(record.row.styleId)}?tab=compliance`}>
                {t('gate.signedRoute')}
              </Link>
            </Banner>
            <CheckList label={t('issue.review')} checks={checks.map((check) => ({ id: check.id, state: check.state, text: t(check.key, { ...(check.params ?? {}), count: Number(check.params?.count ?? 0) }) }))} />
            <p className="fw-dc-muted">{t('issue.freeze', { revision: record.row.revision })}</p>
          </>
        ) : (
          <Banner tone="success" title={t(held)}>
            {t('issue.signedBody')}
          </Banner>
        )}
      </div>
    </Modal>
  )
}

function TranslateRecordDialog({ model, record, actions }: { model: RecordModel; record: RecordDoc; actions?: RecordActions | undefined }) {
  const t = useWords()
  const language = useLanguage()
  const close = () => actions?.onAddress?.({ dialog: null })
  const options = translatable(record, model.marketLanguages)
  const markets = [...new Set(record.packs.map((pack) => pack.market.code))]
  const held = translateHeld(record, model.translateLanguages, model.translatePacks, model.busy) ?? (!model.online ? 'held.offline' : null)
  return (
    <Modal
      open
      onClose={close}
      title={t('translate.title', { label: record.row.number ?? record.row.style.code })}
      size="md"
      footer={
        <>
          <Button onClick={close}>{t('common.cancel')}</Button>
          <Button variant="primary" heldReason={held ? t(held) : null} onClick={() => actions?.onTranslate?.()}>
            {t('translate.start', { count: model.translateLanguages.length + model.translatePacks.length })}
          </Button>
        </>
      }
    >
      <div className="fw-dc-form">
        <p className="fw-dc-p">{t('translate.body')}</p>
        <Field label={t('translate.languages')}>
          <MultiSelect ariaLabel={t('translate.languages')} options={options.map((tag) => ({ value: tag, label: language(tag) }))} value={[...model.translateLanguages]} onChange={(next) => actions?.onTranslateChoice?.(next, model.translatePacks)} placeholder={t('new.none')} formatLabel={(value) => value.map((tag) => tag.toUpperCase()).join(', ')} />
        </Field>
        {record.kind === 'USER_INFORMATION' && markets.length > 0 && (
          <Field label={t('new.packs')} hint={t('new.packsHint')}>
            <MultiSelect ariaLabel={t('new.packs')} options={markets.map((code) => ({ value: code, label: code }))} value={[...model.translatePacks]} onChange={(next) => actions?.onTranslateChoice?.(model.translateLanguages, next)} placeholder={t('new.none')} />
          </Field>
        )}
        <p className="fw-dc-muted">{t('translate.check')}</p>
        {model.problem && <Banner tone="danger" title={t(model.problem.key)} />}
      </div>
    </Modal>
  )
}

/** Withdraw (design pop:dc-withdraw): the reason and the typed confirm; batches already shipped keep it on record. */
function WithdrawDialog({ model, record, actions }: { model: RecordModel; record: RecordDoc; actions?: RecordActions | undefined }) {
  const t = useWords()
  const close = () => actions?.onAddress?.({ dialog: null })
  const phrase = withdrawPhrase(record, t('withdraw.word'))
  const held = withdrawHeld(record, model.reason, model.typed, phrase, model.busy) ?? (!model.online ? 'held.offline' : null)
  const translations = record.original ? 0 : record.family.filter((entry) => !entry.original && entry.status === 'DRAFT' && entry.origin === 'GENERATED').length
  return (
    <Modal
      open
      onClose={close}
      title={t('withdraw.title', { label: record.row.number ?? record.row.style.code })}
      size="md"
      footer={
        <>
          <Button onClick={close}>{t('common.cancel')}</Button>
          <Button variant="danger" heldReason={held ? t(held) : null} onClick={() => actions?.onWithdraw?.()}>
            {t('withdraw.do')}
          </Button>
        </>
      }
    >
      <div className="fw-dc-form">
        <p className="fw-dc-p">{t('withdraw.body')}</p>
        {translations > 0 && <Banner tone="warning" title={t('withdraw.translations', { count: translations })} />}
        <p className="fw-dc-muted">{t('withdraw.revision', { revision: record.row.revision, language: record.row.language.toUpperCase() })}</p>
        <Field label={t('withdraw.reason')} required>
          <Textarea value={model.reason} rows={3} maxLength={500} onChange={(event) => actions?.onReason?.(event.target.value)} />
        </Field>
        <ConfirmPhraseField phrase={phrase} value={model.typed} onChange={(value) => actions?.onTyped?.(value)} />
        {model.problem && <Banner tone="danger" title={t(model.problem.key)} />}
      </div>
    </Modal>
  )
}

/** Check a translation: a second person, never its author nor anyone who typed its words. */
function CheckDialog({ model, record, actions }: { model: RecordModel; record: RecordDoc; actions?: RecordActions | undefined }) {
  const t = useWords()
  const close = () => actions?.onAddress?.({ dialog: null })
  const held = checkHeld(record, model.userId, typistsOf(record)) ?? (model.busy ? 'held.busy' : !model.online ? 'held.offline' : null)
  return (
    <Modal
      open
      onClose={close}
      title={t('checkDialog.title', { language: record.row.language.toUpperCase() })}
      size="md"
      footer={
        <>
          <Button onClick={close}>{t('common.cancel')}</Button>
          <Button variant="primary" heldReason={held ? t(held) : null} onClick={() => actions?.onCheck?.()}>
            {t('checkDialog.do')}
          </Button>
        </>
      }
    >
      <div className="fw-dc-form">
        <p className="fw-dc-p">{t('checkDialog.body', { original: record.original?.language.toUpperCase() ?? '—' })}</p>
        <p className="fw-dc-muted">{t('checkDialog.stillDraft')}</p>
        {record.original && (
          <Link className="fw-dc-link" href={recordHref(model.prefix, record.original.id)} target="_blank" rel="noopener">
            {t('checkDialog.openOriginal')}
          </Link>
        )}
        {model.problem && <Banner tone="danger" title={t(model.problem.key)} />}
      </div>
    </Modal>
  )
}

/** Refresh: composed again from today's records; typed words are kept. */
function RefreshDialog({ model, record, actions }: { model: RecordModel; record: RecordDoc; actions?: RecordActions | undefined }) {
  const t = useWords()
  const close = () => actions?.onAddress?.({ dialog: null })
  const held = model.busy ? 'held.busy' : !record.may.refresh ? 'held.generate' : !model.online ? 'held.offline' : null
  return (
    <Modal
      open
      onClose={close}
      title={t('refresh.title')}
      size="md"
      footer={
        <>
          <Button onClick={close}>{t('common.cancel')}</Button>
          <Button variant="primary" heldReason={held ? t(held) : null} onClick={() => actions?.onRefresh?.()}>
            {t('record.refresh')}
          </Button>
        </>
      }
    >
      <div className="fw-dc-form">
        <p className="fw-dc-p">{t('refresh.body')}</p>
        {record.stale && record.stale.parts.length > 0 && <p className="fw-dc-muted">{t('content.staleParts', { list: record.stale.parts.join(', ') })}</p>}
        {model.problem && <Banner tone="danger" title={t(model.problem.key)} />}
      </div>
    </Modal>
  )
}


'use client'

import Link from 'next/link'
import { Plus, Trash2 } from 'lucide-react'
import { Banner, Field, KeyValue, SummaryTable } from '@nexus/ui/components'
import { Button, Checkbox, Input, Pill, Select, Spinner, Tag } from '@nexus/ui/primitives'
import { Combobox, DateField, DetailModal, Modal, ReviewChangesModal, Textarea } from '../../../../lib/i18n/ds-parts'
import { formatDateTime } from '../../../../lib/i18n/format'
import type { Locale } from '../../../../lib/i18n/locales'
import { useLocale } from '../../../../lib/i18n/provider'
import { TIME_ZONE } from '../../_shared/model'
import type { Publication, VersionDetail } from '../api'
import { CHANGE_REASONS } from '@nexus/factory-domain/people/piecerates/rates'
import { ackRows, actionHeld, dayText, minutesText, pieceOfDraft, rateText, reasonHeld, versionHeld } from '../model'
import type { PieceActions, PieceDialog, PieceModel } from '../view-model'
import { said, usePieceWords, type PieceWords } from './parts'
import { StatePill } from './RatesSection'


/** Who read it: each worker, when, how; names inside this one record only (composed: the DS has no AckTracker yet). */
export function AckTracker({ detail, prefix, t, locale }: { detail: VersionDetail; prefix: string; t: PieceWords; locale: Locale }) {
  const rows = ackRows(detail)
  if (rows.length === 0) return <p className="fw-pr8-hint">{t('ack.none')}</p>
  return (
    <SummaryTable
      label={t('ack.title')}
      columns={[t('ack.worker'), t('ack.read'), t('ack.how')]}
      stackOnPhone
      rows={rows.map((row) => ({
        id: row.workerId,
        cells: [
          row.employeeId ? (
            <Link key="name" className="fw-pp-link" href={`${prefix}/people/employees/${row.employeeId}?tab=pay`}>
              {row.name}
            </Link>
          ) : (
            row.name
          ),
          row.read ? formatDateTime(row.read.at, { locale, timeZone: TIME_ZONE }) : t('ack.notYet'),
          row.read ? t(`ack.${row.read.channel}`) : '—',
        ],
      }))}
    />
  )
}

/** Every pop-up of the rate table: the version's record, New rate version, Publish rates, the bulk confirm, and their small confirmations. */
export function RateDialogs({ model, actions }: { model: PieceModel; actions?: PieceActions | undefined }) {
  const { dialog } = model
  return (
    <>
      {model.version && <VersionRecord model={model} actions={actions} />}
      {dialog?.kind === 'version' && <VersionDialog model={model} dialog={dialog} actions={actions} />}
      {dialog?.kind === 'publish' && <PublishDialog model={model} dialog={dialog} actions={actions} />}
      {dialog?.kind === 'confirm' && <ConfirmReview dialog={dialog} actions={actions} />}
      {(dialog?.kind === 'cancelVersion' || dialog?.kind === 'withdraw') && <ReasonDialog dialog={dialog} actions={actions} />}
      {dialog?.kind === 'paper' && <PaperDialog dialog={dialog} actions={actions} />}
    </>
  )
}

function VersionRecord({ model, actions }: { model: PieceModel; actions?: PieceActions | undefined }) {
  const t = usePieceWords()
  const locale = useLocale()
  const read = model.version!
  const detail = read.status === 'ready' ? read.value : null
  const version = detail?.version
  const held = (action: keyof VersionDetail['actions']) => (detail ? said(t, actionHeld(detail.actions[action])) || null : null)
  return (
    <DetailModal
      open
      onClose={() => actions?.onOpenVersion(null)}
      title={detail ? t('record.title', { table: detail.table.code, version: detail.version.versionNo }) : t('record.loading')}
      {...(detail ? { subtitle: detail.table.name } : {})}
      loading={read.status === 'loading'}
      error={read.status === 'failed' ? said(t, read.problem) : undefined}
      onRetry={() => actions?.onRetry()}
      meta={
        version ? (
          <span className="fw-pp-chips">
            <StatePill row={version} t={t} locale={locale} />
            <Tag tone="neutral">{t(`why.${version.changeReason}`)}</Tag>
            {version.inForceToday && <Pill tone="success">{t('record.inForce')}</Pill>}
          </span>
        ) : undefined
      }
      actions={
        detail?.canManage ? (
          <span className="fw-pp-actions">
            {detail.actions.edit.allowed && (
              <Button size="sm" onClick={() => actions?.onEditRates(detail)}>
                {t('record.edit')}
              </Button>
            )}
            {detail.actions.publish.allowed && (
              <Button size="sm" variant="primary" onClick={() => actions?.onPublish(detail.version.id)}>
                {t('band.publish')}
              </Button>
            )}
            {version?.status === 'DRAFT' && (
              <Button size="sm" heldReason={held('putInForce')} onClick={() => actions?.onPutInForce()}>
                {t('record.putInForce')}
              </Button>
            )}
            {version?.status === 'PROVISIONAL' && (
              <Button size="sm" heldReason={held('confirm')} onClick={() => actions?.onConfirmVersion()}>
                {t('record.confirm')}
              </Button>
            )}
            {detail.actions.cancel.allowed && (
              <Button size="sm" variant="quiet" onClick={() => actions?.onCancelVersion()}>
                {t('record.cancel')}
              </Button>
            )}
          </span>
        ) : undefined
      }
    >
      {detail && version && (
        <div className="fw-pr8-stack">
          {!detail.payShown && <Banner tone="info" title={t('rates.payHidden')} />}
          <KeyValue
            columns={2}
            items={[
              { label: t('rates.effective'), value: `${dayText(version.effectiveFrom, locale)} – ${dayText(version.effectiveTo, locale) ?? t('rates.open')}` },
              { label: t('record.line'), value: detail.table.line ? `${detail.table.line.code} · ${detail.table.line.name}` : t('record.anyLine') },
              { label: t('rates.style'), value: detail.table.style ? `${detail.table.style.code} · ${detail.table.style.name}` : t('rates.general') },
              { label: t('rates.published'), value: dayText(version.publishedOn, locale) ?? t('rates.notPublished') },
              { label: t('rates.read'), value: t('rates.readBy', { read: version.readBy.read, of: version.readBy.of }) },
              ...(version.changeNote ? [{ label: t('record.note'), value: version.changeNote }] : []),
              ...(version.createdByName ? [{ label: t('record.by'), value: version.createdByName }] : []),
            ]}
          />
          <h3 className="fw-pr8-h3">{t('record.rates')}</h3>
          <SummaryTable
            label={t('record.rates')}
            stackOnPhone
            columns={[t('rates.operation'), t('rates.band'), t('rates.smv'), ...(detail.payShown ? [t('rates.perMinute'), t('rates.perPiece')] : []), t('rates.basis')]}
            align={['left', 'left', 'right', ...(detail.payShown ? (['right', 'right'] as const) : []), 'left']}
            rows={detail.rates.map((rate) => ({
              id: rate.id,
              cells: [`${rate.operation.code} · ${rate.operation.name}`, rate.sizeBand === 'ALL' ? t('rates.allSizes') : rate.sizeBand, minutesText(rate.standardMinutes, locale) ?? '—', ...(detail.payShown ? [rateText(rate.ratePerMinute, detail.table.currency, locale) ?? '—', rateText(rate.ratePerPiece, detail.table.currency, locale) ?? '—'] : []), t(`basis.${rate.basis}`)],
            }))}
          />
          <h3 className="fw-pr8-h3">{t('ack.title')}</h3>
          <AckTracker detail={detail} prefix={model.prefix} t={t} locale={locale} />
          {detail.publications.map((publication) => (
            <div key={publication.id} className="fw-pr8-row">
              <span className="fw-pr8-hint">
                {t(publication.status === 'PUBLISHED' ? 'publication.line' : 'publication.withdrawn', { day: dayText(publication.publishedAt.slice(0, 10), locale) ?? '', count: publication.workers.length, line: publication.line?.code ?? t('record.anyLine') })}
              </span>
              <a className="fw-pp-link" href={`${model.prefix}/people/piecerates/rate-sheet?version=${encodeURIComponent(version.id)}`} target="_blank" rel="noreferrer">
                {t('rates.print')}
              </a>
              {detail.canManage && publication.status === 'PUBLISHED' && publication.readBy.read < publication.readBy.of && (
                <Button size="sm" variant="quiet" onClick={() => actions?.onPaper(publication)}>
                  {t('publication.paper')}
                </Button>
              )}
              {detail.canManage && publication.status === 'PUBLISHED' && version.status === 'DRAFT' && (
                <Button size="sm" variant="quiet" onClick={() => actions?.onWithdraw(publication)}>
                  {t('publication.withdraw')}
                </Button>
              )}
            </div>
          ))}
        </div>
      )}
    </DetailModal>
  )
}

function VersionDialog({ model, dialog, actions }: { model: PieceModel; dialog: Extract<PieceDialog, { kind: 'version' }>; actions?: PieceActions | undefined }) {
  const t = usePieceWords()
  const locale = useLocale()
  const { draft, table, editing } = dialog
  const held = versionHeld(table ? { ...draft, tableId: table.name.trim() ? 'new' : '' } : draft, model.today)
  const currency = model.tables.find((row) => row.table.id === draft.tableId)?.table.currency ?? 'EUR'
  const options = (dialog.operations ?? []).map((row) => ({ value: row.id, label: `${row.code} · ${row.name}` }))
  return (
    <Modal
      open
      size="xl"
      onClose={() => actions?.onCloseDialog()}
      title={editing ? t('version.editTitle') : t('version.title')}
      footer={
        <>
          <Button variant="quiet" onClick={() => actions?.onCloseDialog()}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" heldReason={dialog.busy ? t('common.working') : held ? said(t, held) : null} onClick={() => actions?.onVersionSave()}>
            {editing ? t('version.saveRates') : t('version.create')}
          </Button>
        </>
      }
    >
      <div className="fw-pr8-stack">
        {dialog.problem && <Banner tone="danger" title={said(t, dialog.problem)} />}
        <p className="fw-pr8-hint">{t('version.lead')}</p>
        {!editing && (
          <>
            {!table ? (
              <Field label={t('version.table')} required>
                <span className="fw-pr8-row">
                  <Select value={draft.tableId} onChange={(event) => actions?.onVersionDraft({ tableId: event.target.value })}>
                    <option value="">{t('common.choose')}</option>
                    {model.tables.map((row) => (
                      <option key={row.table.id} value={row.table.id}>
                        {row.table.code} · {row.table.name}
                      </option>
                    ))}
                  </Select>
                  <Button size="sm" variant="quiet" onClick={() => actions?.onTableDraft({})}>
                    {t('version.newTable')}
                  </Button>
                </span>
              </Field>
            ) : (
              <div className="fw-pr8-grid">
                <Field label={t('version.tableName')} required>
                  <Input value={table.name} onChange={(event) => actions?.onTableDraft({ name: event.target.value })} />
                </Field>
                <Field label={t('version.tableCode')} required>
                  <Input value={table.code} onChange={(event) => actions?.onTableDraft({ code: event.target.value.toUpperCase() })} />
                </Field>
                <Field label={t('rates.style')} hint={dialog.styles.length === 0 ? t('version.noStyles') : undefined}>
                  <Select value={table.styleId} onChange={(event) => actions?.onTableDraft({ styleId: event.target.value })}>
                    <option value="">{t('rates.general')}</option>
                    {dialog.styles.map((row) => (
                      <option key={row.id} value={row.id}>
                        {row.code} · {row.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label={t('record.line')}>
                  <Select value={table.lineId} onChange={(event) => actions?.onTableDraft({ lineId: event.target.value })}>
                    <option value="">{t('record.anyLine')}</option>
                    {dialog.lines.map((row) => (
                      <option key={row.id} value={row.id}>
                        {row.code} · {row.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                {model.tables.length > 0 && (
                  <Button size="sm" variant="quiet" onClick={() => actions?.onTableDraft(null)}>
                    {t('version.pickTable')}
                  </Button>
                )}
              </div>
            )}
            <div className="fw-pr8-grid">
              <Field label={t('version.from')} required>
                <DateField value={draft.effectiveFrom} min={model.today} onChange={(value) => actions?.onVersionDraft({ effectiveFrom: value })} />
              </Field>
              <Field label={t('rates.why')} required>
                <Select value={draft.changeReason} onChange={(event) => actions?.onVersionDraft({ changeReason: event.target.value as typeof draft.changeReason })}>
                  <option value="">{t('common.choose')}</option>
                  {CHANGE_REASONS.map((reason) => (
                    <option key={reason} value={reason}>
                      {t(`why.${reason}`)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t('version.note')} required={draft.changeReason === 'CORRECTION'}>
                <Input value={draft.changeNote} onChange={(event) => actions?.onVersionDraft({ changeNote: event.target.value })} />
              </Field>
            </div>
            <div className="fw-pr8-grid">
              <Checkbox label={t('version.provisional')} checked={draft.provisional} onChange={(event) => actions?.onVersionDraft({ provisional: event.target.checked })} />
              {draft.provisional && (
                <Field label={t('version.trialEnds')} required>
                  <DateField value={draft.trialEndsOn} onChange={(value) => actions?.onVersionDraft({ trialEndsOn: value })} />
                </Field>
              )}
            </div>
          </>
        )}
        <h3 className="fw-pr8-h3">{t('record.rates')}</h3>
        {dialog.operations === null && (
          <p className="fw-pr8-hint" role="status">
            <Spinner size={12} /> {t('version.readingOperations')}
          </p>
        )}
        {draft.rates.map((rate) => {
          const piece = pieceOfDraft(rate)
          return (
            <div key={rate.key} className="fw-pr8-rate">
              <Field label={t('rates.operation')} required>
                {rate.operationId ? (
                  <Input value={rate.operationLabel} readOnly />
                ) : (
                  <Combobox
                    options={options}
                    onChange={(value) => {
                      const found = dialog.operations?.find((row) => row.id === value)
                      actions?.onRateDraft(rate.key, { operationId: value, operationLabel: found ? `${found.code} · ${found.name}` : '', standardMinutes: found?.standardMinutes ?? '' })
                    }}
                    placeholder={t('version.pickOperation')}
                  />
                )}
              </Field>
              <Field label={t('rates.band')}>
                <Input value={rate.sizeBand} onChange={(event) => actions?.onRateDraft(rate.key, { sizeBand: event.target.value })} />
              </Field>
              <Field label={t('rates.basis')}>
                <Select value={rate.basis} onChange={(event) => actions?.onRateDraft(rate.key, { basis: event.target.value as typeof rate.basis })}>
                  <option value="SMV_RATE">{t('basis.SMV_RATE')}</option>
                  <option value="FIXED">{t('basis.FIXED')}</option>
                </Select>
              </Field>
              <Field label={t('rates.smv')}>
                <Input value={rate.standardMinutes} inputMode="decimal" onChange={(event) => actions?.onRateDraft(rate.key, { standardMinutes: event.target.value })} />
              </Field>
              {rate.basis === 'SMV_RATE' ? (
                <Field label={t('rates.perMinute')}>
                  <Input value={rate.ratePerMinute} inputMode="decimal" onChange={(event) => actions?.onRateDraft(rate.key, { ratePerMinute: event.target.value })} />
                </Field>
              ) : (
                <Field label={t('rates.perPiece')}>
                  <Input value={rate.ratePerPiece} inputMode="decimal" onChange={(event) => actions?.onRateDraft(rate.key, { ratePerPiece: event.target.value })} />
                </Field>
              )}
              <Field label={t('version.makes')}>
                <span className="fw-pr8-num">{rate.basis === 'SMV_RATE' ? (rateText(piece, currency, locale) ?? '—') : '—'}</span>
              </Field>
              <Button size="sm" variant="quiet" aria-label={t('version.removeRate')} onClick={() => actions?.onRemoveRate(rate.key)}>
                <Trash2 size={14} aria-hidden />
              </Button>
            </div>
          )
        })}
        <div className="fw-pr8-row">
          <Button size="sm" onClick={() => actions?.onAddRate()}>
            <Plus size={14} aria-hidden /> {t('version.addRate')}
          </Button>
          {(dialog.operations?.length ?? 0) > 0 && (
            <Button size="sm" variant="quiet" onClick={() => actions?.onLibrary()}>
              {t('rates.copySmv')}
            </Button>
          )}
          {model.can.operations === false && <span className="fw-pr8-hint">{t('version.noOperations')}</span>}
          {draft.rates.length > 1 && (
            <label className="fw-pr8-row">
              <span className="fw-pr8-hint">{t('version.rateForAll')}</span>
              <Input value={dialog.rateForAll} inputMode="decimal" aria-label={t('version.rateForAll')} style={{ width: 96 }} onChange={(event) => actions?.onRateForAll(event.target.value)} />
            </label>
          )}
        </div>
      </div>
    </Modal>
  )
}

function PublishDialog({ model, dialog, actions }: { model: PieceModel; dialog: Extract<PieceDialog, { kind: 'publish' }>; actions?: PieceActions | undefined }) {
  const t = usePieceWords()
  const preview = dialog.preview.status === 'ready' ? dialog.preview.value : null
  const versions = model.tables.flatMap((row) => [row.next, row.current].filter((version): version is NonNullable<typeof version> => version !== null).map((version) => ({ id: version.id, label: `${row.table.code} · v${version.versionNo}` })))
  const drafts = model.tables.flatMap((row) => (model.rates?.status === 'ready' ? model.rates.value.rows.filter((rate) => rate.table.id === row.table.id && rate.version.status === 'DRAFT').map((rate) => ({ id: rate.version.id, label: `${row.table.code} · v${rate.version.versionNo}` })) : []))
  const open = model.version?.status === 'ready' ? [{ id: model.version.value.version.id, label: `${model.version.value.table.code} · v${model.version.value.version.versionNo}` }] : []
  const options = [...new Map([...open, ...drafts, ...versions].map((row) => [row.id, row])).values()]
  // A publication goes to those not told yet (the API's default): someone told already is listed, not told again.
  const count = preview?.newCount ?? 0
  const refused = preview?.refusal ? t(`refusal.${preview.refusal.code}`) : null
  return (
    <Modal
      open
      size="lg"
      onClose={() => actions?.onCloseDialog()}
      title={t('publish.title')}
      footer={
        <>
          <Button variant="quiet" onClick={() => actions?.onCloseDialog()}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" heldReason={dialog.busy ? t('common.working') : !preview ? t('common.reading') : refused ? refused : count === 0 ? t('publish.nobody') : !dialog.onFloor && !dialog.printed ? t('publish.noWay') : null} onClick={() => actions?.onPublishSave()}>
            {t('publish.apply', { count })}
          </Button>
        </>
      }
    >
      <div className="fw-pr8-stack">
        {dialog.problem && <Banner tone="danger" title={said(t, dialog.problem)} />}
        <p className="fw-pr8-hint">{t('publish.lead')}</p>
        <div className="fw-pr8-grid">
          <Field label={t('publish.version')} required>
            <Select value={dialog.versionId} onChange={(event) => actions?.onPublishDraft({ versionId: event.target.value })}>
              <option value="">{t('common.choose')}</option>
              {options.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('record.line')}>
            <Select value={dialog.lineId} onChange={(event) => actions?.onPublishDraft({ lineId: event.target.value })}>
              <option value="">{t('publish.wholeSite')}</option>
              {dialog.lines.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.code} · {row.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="fw-pr8-row">
          <Checkbox label={t('publish.onFloor')} checked={dialog.onFloor} onChange={(event) => actions?.onPublishDraft({ onFloor: event.target.checked })} />
          <Checkbox label={t('publish.printed')} checked={dialog.printed} onChange={(event) => actions?.onPublishDraft({ printed: event.target.checked })} />
        </div>
        {dialog.preview.status === 'failed' && <Banner tone="warning" title={said(t, dialog.preview.problem)} />}
        {dialog.preview.status === 'loading' && (
          <p className="fw-pr8-hint" role="status">
            <Spinner size={12} /> {t('common.reading')}
          </p>
        )}
        {preview && (
          <>
            <p className="fw-pr8-hint">{t('publish.who', { count: preview.count, fresh: preview.newCount })}</p>
            {preview.withoutEmployee > 0 && <Banner tone="warning" title={t('publish.noEmployee', { count: preview.withoutEmployee })} />}
            <div className="fw-pr8-workers">
              <SummaryTable label={t('publish.workers')} columns={[t('ack.worker'), t('publish.told')]} rows={preview.workers.map((row) => ({ id: row.workerId, cells: [row.name, t(row.alreadyTold ? 'publish.already' : 'publish.new')] }))} />
            </div>
          </>
        )}
      </div>
    </Modal>
  )
}

function ConfirmReview({ dialog, actions }: { dialog: Extract<PieceDialog, { kind: 'confirm' }>; actions?: PieceActions | undefined }) {
  const t = usePieceWords()
  const locale = useLocale()
  const rows = dialog.rows ?? []
  const refused = rows.filter((row) => row.refused)
  return (
    <ReviewChangesModal
      open
      onClose={() => actions?.onCloseDialog()}
      changes={rows.map((row) => ({ id: row.id, where: row.label, what: t('confirm.what'), now: t('state.provisionalUntil', { day: dayText(row.trial, locale) ?? '' }), next: t('state.CONFIRMED'), ...(row.refused ? { note: said(t, row.refused) } : {}) }))}
      state={dialog.review.phase === 'failed' ? { phase: 'failed', error: t(dialog.review.error) } : dialog.review}
      title={t('rates.confirmN', { count: dialog.rates })}
      summary={t('confirm.summary')}
      problems={refused.length > 0 ? [t('confirm.refused', { count: refused.length })] : []}
      saveLabel={t('rates.confirmN', { count: dialog.rates })}
      onSave={() => actions?.onConfirmRatesSave()}
    />
  )
}

function ReasonDialog({ dialog, actions }: { dialog: Extract<PieceDialog, { kind: 'cancelVersion' | 'withdraw' }>; actions?: PieceActions | undefined }) {
  const t = usePieceWords()
  const withdraw = dialog.kind === 'withdraw'
  return (
    <Modal
      open
      onClose={() => actions?.onCloseDialog()}
      title={t(withdraw ? 'publication.withdrawTitle' : 'record.cancelTitle')}
      footer={
        <>
          <Button variant="quiet" onClick={() => actions?.onCloseDialog()}>
            {t('common.keep')}
          </Button>
          <Button variant="danger" heldReason={dialog.busy ? t('common.working') : reasonHeld(dialog.reason) ? t('common.reasonHeld') : null} onClick={() => (withdraw ? actions?.onWithdrawSave() : actions?.onCancelVersionSave())}>
            {t(withdraw ? 'publication.withdraw' : 'record.cancel')}
          </Button>
        </>
      }
    >
      <div className="fw-pr8-stack">
        {dialog.problem && <Banner tone="danger" title={said(t, dialog.problem)} />}
        <Field label={t('common.why')} required>
          <Textarea value={dialog.reason} rows={2} onChange={(event) => actions?.onDialogReason(event.target.value)} />
        </Field>
      </div>
    </Modal>
  )
}

function PaperDialog({ dialog, actions }: { dialog: Extract<PieceDialog, { kind: 'paper' }>; actions?: PieceActions | undefined }) {
  const t = usePieceWords()
  const waiting = (dialog.publication as Publication).workers.filter((row) => !row.read)
  return (
    <Modal
      open
      onClose={() => actions?.onCloseDialog()}
      title={t('paper.title')}
      footer={
        <>
          <Button variant="quiet" onClick={() => actions?.onCloseDialog()}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" heldReason={dialog.busy ? t('common.working') : dialog.picked.length === 0 ? t('paper.held') : null} onClick={() => actions?.onPaperSave()}>
            {t('paper.apply', { count: dialog.picked.length })}
          </Button>
        </>
      }
    >
      <div className="fw-pr8-stack">
        {dialog.problem && <Banner tone="danger" title={said(t, dialog.problem)} />}
        <p className="fw-pr8-hint">{t('paper.lead')}</p>
        {waiting.map((row) => (
          <Checkbox key={row.workerId} label={row.name} disabled={!row.employeeId} checked={dialog.picked.includes(row.workerId)} onChange={(event) => actions?.onPaperPick(row.workerId, event.target.checked)} />
        ))}
      </div>
    </Modal>
  )
}


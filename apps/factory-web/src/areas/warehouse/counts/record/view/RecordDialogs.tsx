'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Search } from 'lucide-react'
import { Banner, Field, phraseMatchState, SummaryTable } from '@nexus/ui/components'
import { Button, Input, Select, Spinner, Toggle } from '@nexus/ui/primitives'
import { ConfirmPhraseField, Modal, Textarea } from '../../../../../lib/i18n/ds-parts'
import { formatDate } from '../../../../../lib/i18n/format'
import { useLocale } from '../../../../../lib/i18n/provider'
import { quantity } from '../../../../_shared/stock/model'
import type { CountRecord } from '../../api'
import { readCount } from '../../model'
import { Money, say, useWords } from '../../parts'
import type { CountRecordActions, CountRecordModel, FoundModel, RecordDialog } from '../../view-model'
import { lineWords } from './LinesTab'

/**
 * The count record's dialogs: Apply N differences (design cn-apply: the COUNT moves listed with ± quantity and, with the
 * cost grain, their value; "Reverse each move in Movements"), Year-end sign-off (cn-signoff: the count's number typed,
 * the valued list's language; it freezes the list as PDF and XLSX), Approve (the value against the limit, a note), Send
 * back (the reason, the suggested recounts asked at once), Give a reason (one or many lines), Found stock (a line for what
 * was found and not expected), Edit (team, note) and Cancel (the reason). Esc closes; the focus returns to the opener.
 * ⌘↵ confirms where the step is not held.
 */
export function RecordDialogs({ value, model, actions }: { value: CountRecord; model: CountRecordModel; actions?: CountRecordActions }) {
  const dialog = model.dialog
  if (!dialog) return null
  switch (dialog.kind) {
    case 'apply':
      return <ApplyDialog value={value} model={model} actions={actions} />
    case 'signOff':
      return <SignOffDialog value={value} model={model} dialog={dialog} actions={actions} />
    case 'found':
      return <FoundDialog value={value} model={model} found={dialog.found} actions={actions} />
    default:
      return <FormDialog value={value} model={model} dialog={dialog} actions={actions} />
  }
}

function Frame({ title, subtitle, held, confirm, danger, model, actions, children, size = 'md' }: { title: string; subtitle?: string; held: string | null; confirm: string; danger?: boolean; model: CountRecordModel; actions?: CountRecordActions; children: ReactNode; size?: 'sm' | 'md' | 'lg' }) {
  const t = useWords()
  const blocked = held ?? (model.busy ? t('held.busy') : null)
  const run = () => {
    if (!blocked) actions?.onConfirm?.()
  }
  return (
    <Modal
      open
      onClose={() => actions?.onDialog?.(null)}
      title={title}
      subtitle={subtitle}
      size={size}
      footer={
        <>
          <span className="grow" />
          <Button size="sm" onClick={() => actions?.onDialog?.(null)}>
            {t('stock:common.cancel')}
          </Button>
          <Button size="sm" variant={danger ? 'danger' : 'primary'} heldReason={blocked} onClick={run} aria-keyshortcuts="Meta+Enter Control+Enter">
            {model.busy ? <Spinner size={12} /> : null} {confirm}
          </Button>
        </>
      }
    >
      <form
        className="fw-cn-dialog"
        onSubmit={(event) => {
          event.preventDefault()
          run()
        }}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault()
            run()
          }
        }}
      >
        {model.problem && <Banner tone="danger" title={say(t, model.problem) ?? ''} />}
        {children}
      </form>
    </Modal>
  )
}

function FormDialog({ value, model, dialog, actions }: { value: CountRecord; model: CountRecordModel; dialog: RecordDialog; actions?: CountRecordActions }) {
  const t = useWords()
  const locale = useLocale()
  const set = (next: RecordDialog) => actions?.onDialog?.(next)
  switch (dialog.kind) {
    case 'edit':
      return (
        <Frame title={t('edit.title', { number: value.number })} held={null} confirm={t('edit.save')} model={model} actions={actions}>
          <Field label={t('new.team')} hint={t('new.teamHint')}>
            <Input autoFocus value={dialog.team} maxLength={120} onChange={(event) => set({ ...dialog, team: event.target.value })} />
          </Field>
          <Field label={t('new.note')}>
            <Textarea value={dialog.note} maxLength={1000} rows={3} onChange={(event) => set({ ...dialog, note: event.target.value })} />
          </Field>
        </Frame>
      )
    case 'cancel':
      return (
        <Frame title={t('cancel.title', { number: value.number })} held={dialog.reason.trim().length < 3 ? t('held.reasonFirst') : null} confirm={t('cancel.confirm')} danger model={model} actions={actions}>
          <p className="fw-cn-text">{t(value.status === 'DRAFT' ? 'cancel.draft' : 'cancel.started')}</p>
          <Field label={t('cancel.reason')} required>
            <Textarea autoFocus value={dialog.reason} maxLength={500} rows={3} onChange={(event) => set({ ...dialog, reason: event.target.value })} />
          </Field>
        </Frame>
      )
    case 'approve': {
      const held = say(t, value.actions.approve.allowed ? null : { key: value.approval.held === 'OWN_VARIANCE' ? 'held.ownVariance' : value.approval.held === 'NO_RIGHT' ? 'held.waitingApprover' : 'held.notSubmitted' })
      return (
        <Frame title={t('approve.title', { number: value.number })} held={held} confirm={t('approve.confirm')} model={model} actions={actions}>
          <p className="fw-cn-text">{t('approve.what', { count: value.summary.differing })}</p>
          {model.can.cost && value.summary.differenceAmount !== undefined && (
            <p className="fw-cn-text">
              {t('approve.value')} <Money minor={value.summary.differenceAmount} currency={value.currency} />
              {value.approval.limitAmount !== undefined && (
                <>
                  {' · '}
                  {t('approval.limit')} <Money minor={value.approval.limitAmount} currency={value.currency} />
                </>
              )}
            </p>
          )}
          {value.summary.unvalued > 0 && <Banner tone="warning" title={t('approve.unvalued', { count: value.summary.unvalued })} />}
          <Field label={t('approve.note')}>
            <Textarea autoFocus value={dialog.note} maxLength={1000} rows={2} onChange={(event) => set({ ...dialog, note: event.target.value })} />
          </Field>
          <p className="fw-cn-hint">{t('approve.next')}</p>
        </Frame>
      )
    }
    case 'sendBack': {
      const suggested = (model.diffs.items ?? []).filter((line) => line.recountSuggested).length
      return (
        <Frame title={t('sendBack.title', { number: value.number })} held={dialog.reason.trim().length < 3 ? t('held.reasonFirst') : null} confirm={t('sendBack.confirm')} model={model} actions={actions}>
          <p className="fw-cn-text">{t('sendBack.what')}</p>
          <Field label={t('sendBack.reason')} required>
            <Textarea autoFocus value={dialog.reason} maxLength={500} rows={3} onChange={(event) => set({ ...dialog, reason: event.target.value })} />
          </Field>
          <div className="fw-cn-row">
            <Toggle checked={dialog.recount && suggested > 0} disabled={suggested === 0} onChange={(next) => set({ ...dialog, recount: next })} aria-label={t('sendBack.recount', { count: suggested })} />
            <span>{t('sendBack.recount', { count: suggested })}</span>
          </div>
        </Frame>
      )
    }
    case 'reason': {
      const reasons = model.reasons ?? []
      const picked = reasons.find((reason) => reason.code === dialog.reasonCode)
      const held = !dialog.reasonCode ? t('held.pickReason') : picked?.needsDetail && dialog.reasonNote.trim() === '' ? t('held.reasonDetail') : null
      return (
        <Frame title={t('reason.title', { count: dialog.lineIds.length })} held={held} confirm={t('reason.confirm')} model={model} actions={actions}>
          <Field label={t('diff.col.reason')} required>
            <Select autoFocus value={dialog.reasonCode ?? ''} onChange={(event) => set({ ...dialog, reasonCode: event.target.value || null })}>
              <option value="">{t('diff.pickReason')}</option>
              {reasons.map((reason) => (
                <option key={reason.code} value={reason.code}>
                  {locale === 'en' ? reason.labelEn : reason.labelIt}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('reason.note')} required={!!picked?.needsDetail} hint={picked?.needsDetail ? t('reason.noteNeeded') : undefined}>
            <Textarea value={dialog.reasonNote} maxLength={500} rows={2} onChange={(event) => set({ ...dialog, reasonNote: event.target.value })} />
          </Field>
        </Frame>
      )
    }
    default:
      return null
  }
}

function ApplyDialog({ value, model, actions }: { value: CountRecord; model: CountRecordModel; actions?: CountRecordActions }) {
  const t = useWords()
  const locale = useLocale()
  const lines = model.diffs.items
  const held = say(t, value.actions.apply.allowed ? null : { key: value.status === 'SUBMITTED' && value.approvalRequired ? 'held.approveFirst' : model.can.apply ? 'held.notApproved' : 'held.noAdjust' })
  const rows = (lines ?? []).map((line) => {
    const words = lineWords(t, line)
    const moving = line.move
    const signedQuantity = moving ? `${moving.direction === 'IN' ? '+' : '−'}${quantity(moving.baseQuantity, locale, 4)} ${t(`stock:uom.${line.item.uom}`)}` : '—'
    const worth = line.differenceAmount === null || line.differenceAmount === undefined ? t('diff.noCost') : <Money minor={line.differenceAmount} currency={value.currency} signed />
    return {
      id: line.id,
      cells: [`${line.seq} · ${words.material}`, `${words.place}${words.tag !== '—' ? ` · ${words.tag}` : ''}`, signedQuantity, ...(model.can.cost ? [worth] : [])],
    }
  })
  const columns = [t('diff.col.line'), t('line.col.place'), t('apply.col.move'), ...(model.can.cost ? [t('diff.col.value')] : [])]
  return (
    <Frame title={t('apply.title', { count: value.summary.differing })} subtitle={value.number} held={held ?? (lines === null ? t('held.reading') : null)} confirm={t('apply.confirm')} model={model} actions={actions} size="lg">
      <p className="fw-cn-text">{t('apply.what', { count: value.summary.differing, date: value.snapshotAt ? formatDate(value.snapshotAt, { locale, timeZone: model.timeZone }) : '—' })}</p>
      {value.status === 'SUBMITTED' && !value.approvalRequired && <p className="fw-cn-hint">{t('apply.underLimit')}</p>}
      {lines === null ? (
        <p className="fw-cn-hint" role="status">
          <Spinner size={12} /> {t('record.partLoading', { part: t('tab.differences') })}
        </p>
      ) : (
        <div className="fw-cn-moves">
          <SummaryTable
            label={t('apply.tableLabel')}
            columns={columns}
            rows={rows}
            align={['left', 'left', 'right', 'right']}
            widths={model.can.cost ? ['36%', '30%', '17%', '17%'] : ['40%', '36%', '24%']}
            stackOnPhone
          />
        </div>
      )}
      {model.can.cost && value.summary.differenceAmount !== undefined && (
        <p className="fw-cn-text">
          {t('apply.total')} <Money minor={value.summary.differenceAmount} currency={value.currency} />
        </p>
      )}
      <Banner tone="info" title={t('apply.reversal')} />
    </Frame>
  )
}

function SignOffDialog({ value, model, dialog, actions }: { value: CountRecord; model: CountRecordModel; dialog: Extract<RecordDialog, { kind: 'signOff' }>; actions?: CountRecordActions }) {
  const t = useWords()
  const locale = useLocale()
  const state = phraseMatchState(dialog.phrase, value.number)
  const blocked = say(t, value.actions.signOff.allowed ? null : { key: !model.can.signOff ? 'held.noSignOff' : !model.can.cost ? 'held.noCostSignOff' : 'held.notApplied' })
  const held = blocked ?? (state !== 'match' ? t('signOff.typeFirst', { number: value.number }) : null)
  return (
    <Frame title={t('signOff.title')} subtitle={value.number} held={held} confirm={t('signOff.confirm')} model={model} actions={actions}>
      <p className="fw-cn-text">{t('signOff.what', { date: value.inventoryDate ? formatDate(value.inventoryDate, { locale, timeZone: model.timeZone }) : '—' })}</p>
      <ul className="fw-cn-list">
        <li>{t('signOff.freezes')}</li>
        <li>{t('signOff.files')}</li>
        <li>{t('signOff.final')}</li>
      </ul>
      <Field label={t('signOff.language')}>
        <Select value={dialog.language} onChange={(event) => actions?.onDialog?.({ ...dialog, language: event.target.value === 'en' ? 'en' : 'it' })}>
          <option value="it">{t('signOff.it')}</option>
          <option value="en">{t('signOff.en')}</option>
        </Select>
      </Field>
      {/* The DS ConfirmPhraseField (B-W2b-18): "Type CNT-… exactly to confirm" and its state, in the person's language. */}
      <ConfirmPhraseField phrase={value.number} value={dialog.phrase} onChange={(phrase) => actions?.onDialog?.({ ...dialog, phrase })} autoFocus />
      <p className="fw-cn-hint">{t('valued.law')}</p>
    </Frame>
  )
}

function FoundDialog({ value, model, found, actions }: { value: CountRecord; model: CountRecordModel; found: FoundModel; actions?: CountRecordActions }) {
  const t = useWords()
  const locale = useLocale()
  const draft = found.draft
  const [query, setQuery] = useState('')
  const typed = useRef(false)
  const latest = useRef(actions)
  latest.current = actions
  useEffect(() => {
    if (!typed.current) return
    const timer = setTimeout(() => latest.current?.onFind?.(query), 300)
    return () => clearTimeout(timer)
  }, [query])
  const item = draft.item
  const hide = found.hides?.find((entry) => entry.id === draft.hideId) ?? null
  const read = readCount(draft.counted, hide ? hide.baseArea : null)
  const reasons = model.reasons ?? []
  const picked = reasons.find((reason) => reason.code === draft.reasonCode)
  const held = !draft.locationId
    ? t('found.held.place')
    : !item
      ? t('found.held.material')
      : item.tracking === 'HIDE' && !draft.hideId
        ? t('found.held.hide')
        : read.problem
          ? t(read.problem)
          : read.value === null || Number(read.value) <= 0
            ? t('found.held.quantity')
            : picked?.needsDetail && draft.reasonNote.trim() === ''
              ? t('held.reasonDetail')
              : null
  return (
    <Frame title={t('found.title')} subtitle={value.number} held={held} confirm={t('found.confirm')} model={model} actions={actions} size="lg">
      <p className="fw-cn-hint">{t('found.what')}</p>
      <div className="fw-cn-form">
        <Field label={t('line.col.place')} required>
          <Select autoFocus value={draft.locationId ?? ''} disabled={found.places === null} onChange={(event) => actions?.onFound?.({ locationId: event.target.value || null })}>
            <option value="">{t('found.pickPlace')}</option>
            {(found.places ?? []).map((place) => (
              <option key={place.id} value={place.id}>
                {`${' '.repeat(place.depth)}${place.code} · ${place.name}`}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('new.material')} required hint={model.can.materials ? t('new.materialHint') : t('new.noMaterials')}>
          <Input
            type="search"
            leadingIcon={found.searching ? <Spinner size={12} /> : <Search size={13} aria-hidden />}
            disabled={!model.can.materials}
            placeholder={t('new.materialSearch')}
            value={query}
            onChange={(event) => {
              typed.current = true
              setQuery(event.target.value)
            }}
          />
        </Field>
        <Field label={t('new.materialPick')} required>
          <Select value={item?.id ?? ''} disabled={!found.found || found.found.length === 0} onChange={(event) => actions?.onFound?.({ item: found.found?.find((entry) => entry.id === event.target.value) ?? null })}>
            <option value="">{found.found === null ? t('new.searchFirst') : found.found.length === 0 ? t('new.noneFound') : t('found.pickMaterial')}</option>
            {item && !found.found?.some((entry) => entry.id === item.id) && <option value={item.id}>{`${item.code} · ${item.name}`}</option>}
            {(found.found ?? []).map((entry) => (
              <option key={entry.id} value={entry.id}>
                {`${entry.code} · ${entry.name}`}
              </option>
            ))}
          </Select>
        </Field>
        {item && found.colours && found.colours.length > 0 && (
          <Field label={t('found.colour')}>
            <Select value={draft.colourId ?? ''} onChange={(event) => actions?.onFound?.({ colourId: event.target.value || null })}>
              <option value="">{t('line.noColour')}</option>
              {found.colours.map((colour) => (
                <option key={colour.id} value={colour.id}>
                  {`${colour.code} · ${colour.name}`}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {item && item.tracking !== 'NONE' && (
          <Field label={t('new.lot')} required={item.tracking === 'HIDE'}>
            <Select value={draft.lotId ?? ''} disabled={found.lots === null} onChange={(event) => actions?.onFound?.({ lotId: event.target.value || null })}>
              <option value="">{t('found.noLot')}</option>
              {(found.lots ?? []).map((lot) => (
                <option key={lot.id} value={lot.id}>
                  {lot.code}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {item?.tracking === 'HIDE' && draft.lotId && (
          <Field label={t('found.hide')} required>
            <Select value={draft.hideId ?? ''} disabled={found.hides === null} onChange={(event) => actions?.onFound?.({ hideId: event.target.value || null })}>
              <option value="">{t('found.pickHide')}</option>
              {(found.hides ?? []).map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {`${entry.code} · ${quantity(entry.baseArea, locale)} ${t(`stock:uom.${item.baseUom}`)}`}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field label={t('found.counted')} required hint={item ? t('found.unit', { unit: t(`stock:uom.${item.baseUom}`) }) : undefined}>
          <Input inputMode="decimal" value={draft.counted} onChange={(event) => actions?.onFound?.({ counted: event.target.value })} />
        </Field>
        <Field label={t('diff.col.reason')}>
          <Select value={draft.reasonCode ?? ''} onChange={(event) => actions?.onFound?.({ reasonCode: event.target.value || null })}>
            <option value="">{t('diff.pickReason')}</option>
            {reasons.map((reason) => (
              <option key={reason.code} value={reason.code}>
                {locale === 'en' ? reason.labelEn : reason.labelIt}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('reason.note')} className="wide" required={!!picked?.needsDetail}>
          <Textarea value={draft.reasonNote} maxLength={500} rows={2} onChange={(event) => actions?.onFound?.({ reasonNote: event.target.value })} />
        </Field>
      </div>
    </Frame>
  )
}

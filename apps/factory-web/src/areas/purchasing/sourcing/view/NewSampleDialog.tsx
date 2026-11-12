'use client'

import { FilePlus2, Plus, Trash2 } from 'lucide-react'
import { Banner, Field } from '@nexus/ui/components'
import { Button, Input, Select, Spinner } from '@nexus/ui/primitives'
import type { SampleLineKind } from '@nexus/factory-domain/purchasing/sample-orders/rules'
import { KIND_WORDS } from '@nexus/factory-domain/sales/samples/rules'
import { Combobox, DateField, Modal, Textarea } from '../../../../lib/i18n/ds-parts'
import { useLocale } from '../../../../lib/i18n/provider'
import { createHeld, LINE_KINDS, materialOf, materialsFor, mayAddLine, type LineDraft, type Problem } from '../model'
import type { NewState, SourcingPageActions, SourcingPageModel } from '../view-model'
import { useWords } from './parts'

/**
 * New sample order (design pop new-sample, from the band's primary or `c`; Esc closes and returns the focus to the opener):
 * the supplier, where it is delivered (the only site needs no choice), the development project — the style, and one of its
 * open sample rounds or none — when the samples are wanted and words for the supplier; then what it buys, line by line: a
 * sample hide (of a leather), a swatch or a colour card, the material (and its colour), how much in one of its units, by when,
 * words of one's own. "Create draft" makes the draft (held with the reason while something is missing); its prices, the send
 * and the rest are the PO record's. Not counted in production spend: the dialog says so.
 */
export function NewSampleDialog({ model, state, actions }: { model: SourcingPageModel; state: NewState; actions?: SourcingPageActions | undefined }) {
  const t = useWords()
  const locale = useLocale()
  const language = locale === 'en' ? 'en' : 'it'
  const choices = state.choices.status === 'ready' ? state.choices.value : null
  const { draft } = state
  const held = createHeld({ draft, choices, can: model.can, companyId: model.companyId, busy: state.busy, today: model.today })
  const close = () => actions?.onAddress?.({ add: false })
  const style = choices?.styles.find((entry) => entry.id === draft.styleId) ?? null
  const problem: Problem | null = state.problem
  const at = (field: string, line: number | null = null): string | null => (problem && problem.field === field && problem.line === line ? t(problem.key) : null)

  return (
    <Modal
      open
      onClose={close}
      title={t('new.title')}
      size="lg"
      footer={
        <>
          <span className="fw-src-muted">{t('new.foot')}</span>
          <span className="fw-src-grow" />
          <Button onClick={close}>{t('common.cancel')}</Button>
          <Button variant="primary" heldReason={held ? t(held) : null} onClick={() => actions?.onCreate?.()}>
            {state.busy ? <Spinner size={12} /> : <FilePlus2 size={14} aria-hidden />} {t('new.create')}
          </Button>
        </>
      }
    >
      <form
        className="fw-src-form"
        onSubmit={(event) => {
          event.preventDefault()
          if (!held) actions?.onCreate?.()
        }}
      >
        {state.choices.status === 'loading' && (
          <p className="fw-src-muted" role="status">
            <Spinner size={12} /> {t('common.reading')}
          </p>
        )}
        {state.choices.status === 'error' && (
          <Banner
            tone="danger"
            title={t('new.choicesFailed')}
            action={
              <Button size="sm" onClick={() => actions?.onRetryChoices?.()}>
                {t('common.retry')}
              </Button>
            }
          >
            {t(state.choices.problem)}
          </Banner>
        )}
        {!model.can.manage && <Banner tone="info" title={t('held.manage')} />}
        {choices && !choices.complete && <Banner tone="warning" title={t('new.incomplete')} />}

        <div className="fw-src-fields">
          <Field label={t('field.supplier')} required error={at('partyId')}>
            {choices ? (
              <Combobox
                options={choices.suppliers.map((party) => ({ value: party.id, label: `${party.name} · ${party.code}` }))}
                value={draft.partyId ?? ''}
                placeholder={t('field.supplierPlaceholder')}
                onChange={(value) => actions?.onDraft?.({ ...draft, partyId: value || null })}
              />
            ) : (
              <span className="fw-src-muted">—</span>
            )}
          </Field>
          <Field label={t('field.site')} required error={at('siteId')} hint={choices && choices.sites.length === 1 ? t('field.siteOnly') : undefined}>
            <Select value={draft.siteId ?? ''} disabled={!choices || choices.sites.length < 2} onChange={(event) => actions?.onDraft?.({ ...draft, siteId: event.target.value || null })}>
              {(!choices || choices.sites.length !== 1) && <option value="">{t('field.sitePick')}</option>}
              {(choices?.sites ?? []).map((site) => (
                <option key={site.id} value={site.id}>
                  {site.code} · {site.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <div className="fw-src-fields">
          <Field label={t('field.style')} required hint={t('field.styleHint')} error={at('developmentStyleId')}>
            {choices ? (
              <Combobox
                options={choices.styles.map((entry) => ({ value: entry.id, label: `${entry.code} · ${entry.name}` }))}
                value={draft.styleId ?? ''}
                placeholder={t('field.stylePlaceholder')}
                onChange={(value) => actions?.onStyle?.(value || null)}
              />
            ) : (
              <span className="fw-src-muted">—</span>
            )}
          </Field>
          <Field label={t('field.round')} hint={style && style.rounds.length === 0 ? t('field.roundNone') : t('field.roundHint')} error={at('sampleRoundId')}>
            <Select value={draft.roundId ?? ''} disabled={!style || style.rounds.length === 0} onChange={(event) => actions?.onDraft?.({ ...draft, roundId: event.target.value || null })}>
              <option value="">{t('field.roundStyleOnly')}</option>
              {(style?.rounds ?? []).map((round) => (
                <option key={round.id} value={round.id}>
                  {t('project.round', { number: round.number, kind: KIND_WORDS[round.kind][language], round: round.roundNo })}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <div className="fw-src-fields">
          <Field label={t('field.requestedDate')} hint={t('field.requestedHint')} error={at('requestedDate')}>
            <DateField value={draft.requestedDate} min={model.today} onChange={(value) => actions?.onDraft?.({ ...draft, requestedDate: value })} />
          </Field>
          <Field label={t('field.note')} hint={t('field.noteHint')} error={at('note')}>
            <Textarea rows={2} maxLength={1000} value={draft.note} onChange={(event) => actions?.onDraft?.({ ...draft, note: event.target.value })} />
          </Field>
        </div>

        <fieldset className="fw-src-fieldset">
          <legend className="fw-src-h3">{t('lines.title')}</legend>
          <p className="fw-src-muted">{t('lines.hint')}</p>
          {draft.lines.map((line, index) => (
            <LineRow key={line.key} index={index} line={line} state={state} model={model} actions={actions} at={at} />
          ))}
          <span className="fw-src-row">
            <Button size="sm" heldReason={mayAddLine(draft) ? null : t('held.maxLines')} onClick={() => actions?.onAddLine?.()}>
              <Plus size={14} aria-hidden /> {t('lines.add')}
            </Button>
          </span>
        </fieldset>
        {problem && problem.field === null && <Banner tone="danger" title={t(problem.key)} />}
        {problem && problem.field !== null && <Banner tone="danger" title={t('new.refused')}>{t(problem.key)}</Banner>}
      </form>
    </Modal>
  )
}

function LineRow({ index, line, state, model, actions, at }: { index: number; line: LineDraft; state: NewState; model: SourcingPageModel; actions?: SourcingPageActions | undefined; at: (field: string, line?: number | null) => string | null }) {
  const t = useWords()
  const choices = state.choices.status === 'ready' ? state.choices.value : null
  const material = materialOf(choices, line.itemId)
  const set = (change: Partial<LineDraft>) => actions?.onLine?.(line.key, { ...line, ...change })
  return (
    <div className="fw-src-line" role="group" aria-label={t('lines.line', { n: index + 1 })}>
      <span className="fw-src-line-head">
        <b>{t('lines.line', { n: index + 1 })}</b>
        <Button size="sm" variant="quiet" heldReason={state.draft.lines.length === 1 ? t('held.lastLine') : null} aria-label={t('lines.remove', { n: index + 1 })} onClick={() => actions?.onRemoveLine?.(line.key)}>
          <Trash2 size={14} aria-hidden />
        </Button>
      </span>
      <div className="fw-src-line-fields">
        <Field label={t('field.what')} required>
          <Select value={line.what} onChange={(event) => actions?.onLineWhat?.(line.key, event.target.value as SampleLineKind)}>
            {LINE_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {t(`what.${kind}`)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('field.material')} required hint={line.what === 'HIDE' ? t('field.materialHide') : undefined} error={at('itemId', index)}>
          {choices ? (
            <Combobox
              options={materialsFor(choices, line.what).map((item) => ({ value: item.id, label: `${item.code} · ${item.name}` }))}
              value={line.itemId ?? ''}
              placeholder={t('field.materialPlaceholder')}
              onChange={(value) => actions?.onLineMaterial?.(line.key, value || null)}
            />
          ) : (
            <span className="fw-src-muted">—</span>
          )}
        </Field>
        {material && material.colours.length > 0 && (
          <Field label={t('field.colour')} error={at('itemColourId', index)}>
            <Select value={line.itemColourId ?? ''} onChange={(event) => set({ itemColourId: event.target.value || null })}>
              <option value="">{t('field.colourAny')}</option>
              {material.colours.map((colour) => (
                <option key={colour.id} value={colour.id}>
                  {colour.code} · {colour.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field label={t('field.quantity')} required error={at('quantity', index)}>
          <Input inputMode="decimal" value={line.quantity} onChange={(event) => set({ quantity: event.target.value })} />
        </Field>
        <Field label={t('field.unit')} required error={at('uom', index)}>
          <Select value={line.uom ?? ''} disabled={!material} onChange={(event) => set({ uom: (event.target.value || null) as LineDraft['uom'] })}>
            {!material && <option value="">{t('field.unitFirst')}</option>}
            {(material?.units ?? []).map((unit) => (
              <option key={unit} value={unit}>
                {t(`uom.${unit}`)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('field.needDate')} required error={at('needDate', index)}>
          <DateField value={line.needDate} min={model.today} onChange={(value) => set({ needDate: value })} />
        </Field>
        <Field label={t('field.description')} hint={t('field.descriptionHint')} error={at('description', index)}>
          <Input value={line.description} maxLength={200} onChange={(event) => set({ description: event.target.value })} />
        </Field>
      </div>
    </div>
  )
}

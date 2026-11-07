'use client'

import { useEffect, useRef, useState } from 'react'
import { Archive, Plus, Search } from 'lucide-react'
import { Banner, Field } from '@nexus/ui/components'
import { Button, Input, Select, Spinner } from '@nexus/ui/primitives'
import { Modal, Textarea } from '../../../../../lib/i18n/ds-parts'
import { costMinorOf } from '../../../_shared/model'
import { dieDraftHeld } from '../model'
import type { DiesActions, DiesDialog, DiesModel } from '../view-model'
import { sayDie, useDieWords } from './words'

/**
 * The register's dialogs (design plant.machines "Clicking dies"): New die (`c`, `?dnew=1`: the site when there are more,
 * the number stamped on it, the style it cuts — found by code or name —, a size of the style or every size, the piece and
 * the style's pattern piece when the pattern is in Nexus, the rack, material, supplier (parties.view) and cost (the cost
 * grain only), a note) and Retire (one or many, with the reason; a die refused is said one by one). Composed from the DS
 * Modal: the DS ActionConfirm speaks English only.
 */
export function DieDialogs({ model, actions }: { model: DiesModel; actions?: DiesActions }) {
  const dialog = model.dialog
  if (!dialog) return null
  if (dialog.kind === 'new') return <NewDie model={model} dialog={dialog} actions={actions} />
  return <RetireDies dialog={dialog} actions={actions} />
}

function useTyped(onFind: ((text: string) => void) | undefined, initial: string) {
  const [query, setQuery] = useState(initial)
  const typed = useRef(false)
  const latest = useRef(onFind)
  latest.current = onFind
  useEffect(() => {
    if (!typed.current) return
    const timer = setTimeout(() => latest.current?.(query), 300)
    return () => clearTimeout(timer)
  }, [query])
  return {
    query,
    type: (text: string) => {
      typed.current = true
      setQuery(text)
    },
  }
}

function NewDie({ model, dialog, actions }: { model: DiesModel; dialog: Extract<DiesDialog, { kind: 'new' }>; actions?: DiesActions }) {
  const t = useDieWords()
  const draft = dialog.draft
  const styleSearch = useTyped(actions?.onFindStyle, draft.style ? draft.style.code : '')
  const supplierSearch = useTyped(actions?.onFindSupplier, draft.supplier ? `${draft.supplier.code} · ${draft.supplier.legalName}` : '')
  const heldKey = dieDraftHeld(draft, model.can)
  const held = heldKey ? t(heldKey) : dialog.busy ? t('held.busy') : null
  const submit = () => !held && actions?.onSubmitDialog?.()
  const fieldError = (name: string) => (dialog.field === name ? t(`problem.field.${name}`) : undefined)
  const costProblem = draft.cost.trim() !== '' && costMinorOf(draft.cost) === undefined
  const sizes = dialog.choices?.sizes ?? draft.style?.sizes ?? []
  const pieces = dialog.choices?.pieces ?? []
  return (
    <Modal
      open
      onClose={() => actions?.onDialogClose?.()}
      title={t('newDie.title')}
      size="lg"
      footer={
        <>
          <span className="fw-pl-hint">{t('newDie.foot')}</span>
          <span className="fw-pl-grow" />
          <Button size="sm" onClick={() => actions?.onDialogClose?.()}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" variant="primary" heldReason={held} onClick={submit} aria-keyshortcuts="Meta+Enter Control+Enter">
            {dialog.busy ? <Spinner size={12} /> : <Plus size={14} aria-hidden />} {t('newDie.create')}
          </Button>
        </>
      }
    >
      <form
        className="fw-pl-dialog"
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault()
            submit()
          }
        }}
      >
        {dialog.problem && <Banner tone="danger" title={sayDie(t, dialog.problem) ?? ''} />}
        <div className="fw-pl-form">
          {model.sites.length > 1 && (
            <Field label={t('die.site')} required error={fieldError('siteId')}>
              <Select value={draft.siteId ?? ''} onChange={(event) => actions?.onDraft?.({ siteId: event.target.value || null })}>
                <option value="">{t('die.pickSite')}</option>
                {model.sites.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {`${entry.code} · ${entry.name}`}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <Field label={t('die.code')} required hint={t('die.codeHint')} error={fieldError('code')}>
            <Input value={draft.code} maxLength={40} autoFocus onChange={(event) => actions?.onDraft?.({ code: event.target.value.toUpperCase() })} />
          </Field>
          <Field label={t('die.styleSearch')} required hint={t('die.styleHint')}>
            <Input
              type="search"
              leadingIcon={dialog.styles === null && styleSearch.query.trim().length > 0 && !draft.style ? <Spinner size={12} /> : <Search size={13} aria-hidden />}
              value={styleSearch.query}
              placeholder={t('die.stylePlaceholder')}
              onChange={(event) => {
                styleSearch.type(event.target.value)
                if (event.target.value.trim() === '') actions?.onPickStyle?.(null)
              }}
            />
          </Field>
          <Field label={t('die.style')} required>
            <Select value={draft.style?.id ?? ''} disabled={!dialog.styles || dialog.styles.length === 0} onChange={(event) => actions?.onPickStyle?.(dialog.styles?.find((entry) => entry.id === event.target.value) ?? null)}>
              <option value="">{dialog.styles === null ? t('die.styleFirst') : dialog.styles.length === 0 ? t('die.noStyles') : t('die.pickStyle')}</option>
              {draft.style && !dialog.styles?.some((entry) => entry.id === draft.style?.id) && <option value={draft.style.id}>{`${draft.style.code} · ${draft.style.name}`}</option>}
              {(dialog.styles ?? []).map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {`${entry.code} · ${entry.name}`}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('die.size')} hint={draft.style ? t('die.sizeHint') : t('die.styleNeeded')} error={fieldError('size')}>
            <Select value={draft.size} disabled={!draft.style} onChange={(event) => actions?.onDraft?.({ size: event.target.value })}>
              <option value="">{t('die.everySize')}</option>
              {sizes.map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('die.patternPiecePick')} hint={draft.style && dialog.choices && pieces.length === 0 ? t('die.noPattern') : t('die.patternPieceHint')}>
            <Select
              value={draft.patternPieceId ?? ''}
              disabled={!draft.style || pieces.length === 0}
              onChange={(event) => {
                const piece = pieces.find((entry) => entry.id === event.target.value) ?? null
                actions?.onDraft?.({ patternPieceId: piece?.id ?? null, ...(piece && draft.piece.trim() === '' ? { piece: piece.name } : {}) })
              }}
            >
              <option value="">{t('die.noPatternPiece')}</option>
              {pieces.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {t('die.patternPiece', { piece: entry.name, revision: entry.revision })}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('die.piece')} required hint={t('die.pieceHint')} error={fieldError('piece')}>
            <Input value={draft.piece} maxLength={120} onChange={(event) => actions?.onDraft?.({ piece: event.target.value })} />
          </Field>
          <Field label={t('die.rack')} hint={t('die.rackHint')} error={fieldError('rackLocation')}>
            <Input value={draft.rackLocation} maxLength={120} onChange={(event) => actions?.onDraft?.({ rackLocation: event.target.value })} />
          </Field>
          <Field label={t('die.material')} hint={t('die.materialHint')} error={fieldError('material')}>
            <Input value={draft.material} maxLength={80} onChange={(event) => actions?.onDraft?.({ material: event.target.value })} />
          </Field>
          {model.can.parties && (
            <Field label={t('die.supplierSearch')} error={fieldError('supplierId')}>
              <Input
                type="search"
                leadingIcon={dialog.suppliers === null && supplierSearch.query.trim().length > 1 && !draft.supplier ? <Spinner size={12} /> : <Search size={13} aria-hidden />}
                value={supplierSearch.query}
                placeholder={t('die.supplierPlaceholder')}
                onChange={(event) => {
                  supplierSearch.type(event.target.value)
                  if (event.target.value.trim() === '') actions?.onDraft?.({ supplier: null })
                }}
              />
            </Field>
          )}
          {model.can.parties && (
            <Field label={t('die.supplier')}>
              <Select value={draft.supplier?.id ?? ''} disabled={!dialog.suppliers || dialog.suppliers.length === 0} onChange={(event) => actions?.onDraft?.({ supplier: dialog.suppliers?.find((entry) => entry.id === event.target.value) ?? null })}>
                <option value="">{dialog.suppliers === null ? t('die.supplierFirst') : dialog.suppliers.length === 0 ? t('die.noSuppliers') : t('die.noSupplier')}</option>
                {draft.supplier && !dialog.suppliers?.some((entry) => entry.id === draft.supplier?.id) && <option value={draft.supplier.id}>{`${draft.supplier.code} · ${draft.supplier.legalName}`}</option>}
                {(dialog.suppliers ?? []).map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {`${entry.code} · ${entry.legalName}`}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          {model.can.cost && (
            <Field label={t('die.cost')} hint={t('die.costHint')} error={costProblem ? t('die.costProblem') : fieldError('purchaseCost')}>
              <Input value={draft.cost} inputMode="decimal" prefix="€" onChange={(event) => actions?.onDraft?.({ cost: event.target.value })} />
            </Field>
          )}
          <Field label={t('die.note')} className="wide">
            <Textarea value={draft.note} rows={2} maxLength={1000} onChange={(event) => actions?.onDraft?.({ note: event.target.value })} />
          </Field>
        </div>
      </form>
    </Modal>
  )
}

function RetireDies({ dialog, actions }: { dialog: Extract<DiesDialog, { kind: 'retire' }>; actions?: DiesActions }) {
  const t = useDieWords()
  const held = dialog.reason.trim().length === 0 ? t('held.reasonNeeded') : dialog.busy ? t('held.busy') : null
  return (
    <Modal
      open
      onClose={() => actions?.onDialogClose?.()}
      title={dialog.dies.length === 1 ? t('retire.titleOne', { die: dialog.dies[0]!.code }) : t('retire.titleMany', { count: dialog.dies.length })}
      size="md"
      footer={
        <>
          <span className="fw-pl-grow" />
          <Button size="sm" onClick={() => actions?.onDialogClose?.()}>
            {t('common.back')}
          </Button>
          <Button size="sm" variant="danger" heldReason={held} onClick={() => !held && actions?.onSubmitDialog?.()}>
            {dialog.busy ? <Spinner size={12} /> : <Archive size={14} aria-hidden />} {t('retire.submit', { count: dialog.dies.length })}
          </Button>
        </>
      }
    >
      <div className="fw-pl-dialog">
        {dialog.problem && <Banner tone="danger" title={sayDie(t, dialog.problem) ?? ''} />}
        {dialog.refused.length > 0 && (
          <Banner tone="warning" title={t('retire.refusedTitle', { count: dialog.refused.length })}>
            <ul className="fw-pl-list">
              {dialog.refused.map((entry) => (
                <li key={entry.code}>
                  <span className="fw-pl-code">{entry.code}</span> — {sayDie(t, entry.words)}
                </li>
              ))}
            </ul>
          </Banner>
        )}
        <p className="fw-pl-h3">{t('retire.reach')}</p>
        <ul className="fw-pl-list">
          <li>{t('retire.reachKept')}</li>
          <li>{t('retire.reachFrozen')}</li>
        </ul>
        <p className="fw-pl-hint">{t('retire.reversal')}</p>
        {dialog.dies.length > 1 && <p className="fw-pl-text">{dialog.dies.map((die) => die.code).join(', ')}</p>}
        <Field label={t('retire.reason')} required>
          <Textarea value={dialog.reason} rows={2} maxLength={500} onChange={(event) => actions?.onRetireReason?.(event.target.value)} />
        </Field>
      </div>
    </Modal>
  )
}

'use client'

import { Banner, Field } from '@nexus/ui/components'
import { Button, Input, Select, Skeleton } from '@nexus/ui/primitives'
import { DECISION_LIMITS } from '@nexus/factory-domain/sales/sample-decisions/rules'
import { Modal, Textarea } from '../../../../lib/i18n/ds-parts'
import { SWATCH_KINDS, swatchDraftHeld, type Notice, type Phrase, type SwatchDraft, type SwatchKind, type SwatchOption } from '../model'
import { NoticeLine, useWords } from '../parts'

/**
 * F-PR-19 — "Add a swatch" (production plan §3 "Brand alone: … colour, leather, fabric, trims"; §5 Samples: the new kinds): on the
 * round's Approval tab, a swatch of a material sent to the round's customer for its answer — Colour, Leather, and the new Fabric
 * (a textile, lining, membrane or padding) and Trim (a trim, hardware, thread or label). The kind narrows the material picker to
 * the kinds the API takes (factory-domain SWATCH_MATERIAL_KINDS), then the material's colour. It is recorded unsent: "Mark sent",
 * then the customer's answer (or "Ask the customer"), as every swatch on the tab. The container reads the materials and colours.
 */
export interface SwatchModel {
  /** The round's number and the customer the swatch goes to (the round's, else the style's brand). */
  round: { number: string; customer: string | null }
  draft: SwatchDraft
  /** The materials of the kind's material kinds that match the search (null: being read). */
  materials: readonly SwatchOption[] | null
  /** The materials could not be read (a message key). */
  materialsProblem: string | null
  /** The picked material's colours (null: being read, or no material picked yet). */
  colours: readonly SwatchOption[] | null
  coloursProblem: string | null
  busy: boolean
  notice: Notice | null
  offline: boolean
}

export interface SwatchActions {
  onKind?: (kind: SwatchKind) => void
  /** Search the materials again with the typed words. */
  onFind?: (q: string) => void
  onMaterial?: (itemId: string) => void
  onDraft?: (patch: Partial<Pick<SwatchDraft, 'q' | 'itemColourId' | 'note'>>) => void
  onSubmit?: () => void
  onClose?: () => void
}

/** Why "Add swatch" is held now (null: it may be pressed). */
export function addSwatchHeld(model: Pick<SwatchModel, 'busy' | 'offline' | 'draft'>): Phrase | null {
  if (model.busy) return { key: 'common.working' }
  if (model.offline) return { key: 'held.offline' }
  return swatchDraftHeld(model.draft)
}

export function SwatchDialog({ model, actions }: { model: SwatchModel; actions?: SwatchActions }) {
  const { t, say } = useWords()
  const held = say(addSwatchHeld(model))
  const close = () => actions?.onClose?.()
  const draft = model.draft
  const pickedMaterial = draft.itemId !== ''
  return (
    <Modal
      open
      onClose={close}
      title={t('swatch.add.title')}
      subtitle={model.round.customer ? t('swatch.add.subtitle', { number: model.round.number, customer: model.round.customer }) : model.round.number}
      size="md"
      footer={
        <>
          <Button size="sm" variant="secondary" onClick={close}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" variant="primary" heldReason={held} onClick={() => actions?.onSubmit?.()}>
            {t('swatch.add.submit')}
          </Button>
        </>
      }
    >
      <div className="fw-smp-form">
        <Field label={t('swatch.add.kind')} required hint={t(`swatch.add.kindHint.${draft.kind}`)}>
          <Select size="sm" value={draft.kind} onChange={(event) => actions?.onKind?.(event.target.value as SwatchKind)}>
            {SWATCH_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {t(`swatch.${kind}`)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('swatch.add.material')} required>
          <div className="fw-smp-pick">
            <Input
              size="sm"
              type="search"
              aria-label={t('swatch.add.search')}
              placeholder={t('swatch.add.search')}
              value={draft.q}
              onChange={(event) => actions?.onDraft?.({ q: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  actions?.onFind?.(draft.q)
                }
              }}
            />
            {model.materials === null && !model.materialsProblem ? (
              <Skeleton height={32} />
            ) : (
              <Select size="sm" aria-label={t('swatch.add.material')} value={draft.itemId} onChange={(event) => actions?.onMaterial?.(event.target.value)}>
                <option value="">{model.materials && model.materials.length === 0 ? t('swatch.add.noMaterials') : t('swatch.add.pickMaterial')}</option>
                {(model.materials ?? []).map((material) => (
                  <option key={material.id} value={material.id}>
                    {material.code} · {material.name}
                  </option>
                ))}
              </Select>
            )}
          </div>
        </Field>
        <Field label={t('swatch.add.colour')} required hint={t('swatch.add.colourHint')}>
          {pickedMaterial && model.colours === null && !model.coloursProblem ? (
            <Skeleton height={32} />
          ) : (
            <Select size="sm" value={draft.itemColourId} disabled={!pickedMaterial} onChange={(event) => actions?.onDraft?.({ itemColourId: event.target.value })}>
              <option value="">{!pickedMaterial ? t('swatch.add.pickMaterialFirst') : model.colours && model.colours.length === 0 ? t('swatch.add.noColours') : t('swatch.add.pickColour')}</option>
              {(model.colours ?? []).map((colour) => (
                <option key={colour.id} value={colour.id}>
                  {colour.code} · {colour.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t('swatch.add.note')} hint={t('swatch.add.noteHint', { max: DECISION_LIMITS.swatchNote })}>
          <Textarea value={draft.note} rows={2} honourRows maxLength={DECISION_LIMITS.swatchNote} onChange={(event) => actions?.onDraft?.({ note: event.target.value })} />
        </Field>
        {model.materialsProblem && <Banner tone="danger" title={t('swatch.add.materialsFailed')}>{t(model.materialsProblem)}</Banner>}
        {model.coloursProblem && <Banner tone="danger" title={t('swatch.add.coloursFailed')}>{t(model.coloursProblem)}</Banner>}
        <p className="fw-smp-hint">{t('swatch.add.after')}</p>
        <NoticeLine notice={model.notice} />
      </div>
    </Modal>
  )
}

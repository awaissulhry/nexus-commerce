'use client'

import { Banner, Field } from '@nexus/ui/components'
import { Button, Input, Select, Spinner } from '@nexus/ui/primitives'
import { Modal } from '../../../../../lib/i18n/ds-parts'
import { useT } from '../../../../../lib/i18n/provider'
import type { CertCan } from '../../model'
import { useDay } from '../../view/parts'
import type { Depth } from '../api'
import { baseCandidates, baseHeld, bodyScopeFor, levelsDraftProblems, levelsHeld, pickableBodies, pickHeld, supplierHeld, supplierName, type DepthModel } from '../model'
import type { DepthActions } from '../use-depth'
import { DepthMessages, ScopeLine, useDepthT, useLevelWords } from './parts'

/** The depth dialogs of the record (Pick from the directory, Performance levels, Base certificate, Supplier of a part). */
export function DepthDialogs(props: { model: DepthModel; can: CertCan; actions?: DepthActions }) {
  const depth = props.model.depth.value
  if (!props.model.dialog || !depth) return null
  return (
    <DepthMessages>
      {props.model.dialog.kind === 'pickBody' && <PickBodyDialog depth={depth} {...props} />}
      {props.model.dialog.kind === 'levels' && <LevelsDialog depth={depth} {...props} />}
      {props.model.dialog.kind === 'base' && <BaseDialog depth={depth} {...props} />}
      {props.model.dialog.kind === 'supplier' && <SupplierDialog depth={depth} {...props} />}
    </DepthMessages>
  )
}

interface DialogProps {
  depth: Depth
  model: DepthModel
  can: CertCan
  actions?: DepthActions
}

function Refusal({ model }: { model: DepthModel }) {
  const d = useDepthT()
  if (!model.problem) return null
  return (
    <Banner tone="danger" title={d(model.problem)}>
      {model.lines.length > 0 && (
        <ul className="fw-cd-lines fw-ce-data">
          {model.lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
    </Banner>
  )
}

function Footer({ held, busy, label, onConfirm, onClose }: { held: string | null; busy: boolean; label: string; onConfirm?: () => void; onClose?: () => void }) {
  const d = useDepthT()
  return (
    <>
      <Button onClick={() => onClose?.()}>{d('common.back')}</Button>
      <Button variant="primary" heldReason={held} onClick={() => onConfirm?.()}>
        {busy ? <Spinner size={12} /> : null} {label}
      </Button>
    </>
  )
}

/** Pick from the directory (PRD-286): a draft takes the body's number and name; a registered certificate its own body once. */
function PickBodyDialog({ depth, model, actions }: DialogProps) {
  const d = useDepthT()
  const q = useT('quality')
  const offered = pickableBodies(depth, model.bodies?.value ?? null)
  const held = pickHeld(depth, model.draft, model.busy)
  const chosen = offered.find((body) => body.id === model.draft.bodyId) ?? null
  const loading = !depth.certificate.registered && (!model.bodies || (!model.bodies.value && !model.bodies.problem))
  return (
    <Modal open onClose={() => actions?.onDialog?.(null)} title={d('pick.title', { number: depth.certificate.number })} size="md" footer={<Footer held={held ? d(held) : null} busy={model.busy} label={d('pick.confirm')} onConfirm={actions?.onPickBody} onClose={() => actions?.onDialog?.(null)} />}>
      <div className="fw-cd-dialog">
        <p className="fw-q-hint">{d(depth.certificate.registered ? 'pick.introRegistered' : 'pick.introDraft', { number: depth.body.typed.number })}</p>
        {loading ? (
          <p className="fw-q-loading">
            <Spinner size={12} /> {q('common.loading')}
          </p>
        ) : model.bodies?.problem && !depth.certificate.registered ? (
          <Banner tone="danger" title={d('pick.failed')}>
            <p className="fw-q-hint">{q(model.bodies.problem)}</p>
          </Banner>
        ) : offered.length === 0 ? (
          <Banner tone="warning" title={d('pick.none', { number: depth.body.typed.number })}>
            <p className="fw-q-hint">{d('pick.noneHint')}</p>
          </Banner>
        ) : (
          <Field label={d('pick.body')} required>
            <Select autoFocus value={model.draft.bodyId} onChange={(event) => actions?.onDraft?.({ bodyId: event.target.value })}>
              <option value="">{d('pick.choose')}</option>
              {offered.map((body) => (
                <option key={body.id} value={body.id}>
                  {d('pick.option', { number: body.number, name: body.name, country: body.country })}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {chosen && <ScopeLine check={bodyScopeFor(chosen, depth.certificate.kind)} />}
        {chosen && !depth.certificate.registered && chosen.number !== depth.body.typed.number && <p className="fw-q-hint">{d('pick.fills', { number: chosen.number, typed: depth.body.typed.number })}</p>}
        {depth.certificate.registered && <p className="fw-q-hint">{d('pick.once')}</p>}
        <Refusal model={model} />
      </div>
    </Modal>
  )
}

/** Performance levels in the standard's vocabulary (PRD-290: EN 13594 level and KP; EN 1621 zones). */
function LevelsDialog({ depth, model, actions }: DialogProps) {
  const d = useDepthT()
  const words = useLevelWords()
  const problems = levelsDraftProblems(depth, model.draft.levels)
  const held = levelsHeld(depth, model.draft.levels, model.busy)
  const set = (key: string, value: string) => actions?.onDraft?.({ levels: { ...model.draft.levels, [key]: value } })
  return (
    <Modal open onClose={() => actions?.onDialog?.(null)} title={d('levels.dialog', { number: depth.certificate.number })} size="md" footer={<Footer held={held ? d(held) : null} busy={model.busy} label={d('levels.save')} onConfirm={actions?.onLevels} onClose={() => actions?.onDialog?.(null)} />}>
      <div className="fw-cd-dialog">
        <p className="fw-q-hint">{d(`levels.intro.${depth.levels.family}`)}</p>
        <div className="fw-cd-form">
          {depth.levels.properties.map((property, index) => (
            <Field key={property.key} label={words.property(property.key)} required={property.required} error={problems[property.key]}>
              <Select autoFocus={index === 0} value={model.draft.levels[property.key] ?? ''} onChange={(event) => set(property.key, event.target.value)}>
                <option value="">{d(property.required ? 'levels.choose' : 'levels.notStated')}</option>
                {property.values.map((value) => (
                  <option key={value} value={value}>
                    {words.value(property.key, value)}
                  </option>
                ))}
              </Select>
            </Field>
          ))}
        </div>
        {problems._ && <p className="fw-q-hint fw-ce-data">{problems._}</p>}
        {depth.certificate.registered && <p className="fw-q-hint">{d('levels.once')}</p>}
        <Refusal model={model} />
      </div>
    </Modal>
  )
}

/** An own-brand certificate's base (PRD-287): the factory's certificate in force, the same standard first. */
function BaseDialog({ depth, model, actions }: DialogProps) {
  const d = useDepthT()
  const day = useDay()
  const candidates = baseCandidates(depth)
  const held = baseHeld(depth, model.draft, model.busy)
  return (
    <Modal open onClose={() => actions?.onDialog?.(null)} title={d('own.dialog', { number: depth.certificate.number })} size="md" footer={<Footer held={held ? d(held) : null} busy={model.busy} label={d('own.confirm')} onConfirm={actions?.onBase} onClose={() => actions?.onDialog?.(null)} />}>
      <div className="fw-cd-dialog">
        <p className="fw-q-hint">{d('own.dialogIntro')}</p>
        {candidates.length === 0 ? (
          <Banner tone="warning" title={d('own.noCandidates')}>
            <p className="fw-q-hint">{d('own.noCandidatesHint')}</p>
          </Banner>
        ) : (
          <Field label={d('own.base')} required>
            <Select autoFocus value={model.draft.baseId} onChange={(event) => actions?.onDraft?.({ baseId: event.target.value })}>
              <option value="">{d('own.choose')}</option>
              {candidates.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {d('own.option', { number: candidate.number, standard: candidate.standard, to: day(candidate.validTo) })}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {depth.certificate.registered && <p className="fw-q-hint">{d('own.once')}</p>}
        <Refusal model={model} />
      </div>
    </Modal>
  )
}

/** A bought-in part's supplier (QHS-106): named once; its article code as the certificate names it. */
function SupplierDialog({ depth, model, can, actions }: DialogProps) {
  const d = useDepthT()
  const q = useT('quality')
  const dialog = model.dialog
  const part = dialog?.kind === 'supplier' ? depth.boughtIn.find((entry) => entry.coverageId === dialog.coverageId) : undefined
  if (!part) return null
  const held = supplierHeld(part, model.draft, can, model.busy)
  const suppliers = model.suppliers
  return (
    <Modal open onClose={() => actions?.onDialog?.(null)} title={d('supplier.title', { code: part.item?.code ?? '—' })} size="md" footer={<Footer held={held ? d(held) : null} busy={model.busy} label={d('supplier.confirm')} onConfirm={actions?.onSupplier} onClose={() => actions?.onDialog?.(null)} />}>
      <div className="fw-cd-dialog">
        <p className="fw-q-hint">{d('supplier.intro')}</p>
        {part.supplier ? (
          <Field label={d('parts.col.supplier')} hint={d('supplier.fixed')}>
            <Input value={part.supplier.name} readOnly aria-readonly="true" />
          </Field>
        ) : !can.parties ? (
          <p className="fw-q-hint">{d('supplier.held.parties')}</p>
        ) : !suppliers || (!suppliers.value && !suppliers.problem) ? (
          <p className="fw-q-loading">
            <Spinner size={12} /> {q('common.loading')}
          </p>
        ) : suppliers.problem ? (
          <p className="fw-q-hint">{q(suppliers.problem)}</p>
        ) : (
          <Field label={d('parts.col.supplier')} required hint={d('supplier.once')}>
            <Select autoFocus value={model.draft.supplierId} onChange={(event) => actions?.onDraft?.({ supplierId: event.target.value })}>
              <option value="">{d('supplier.choose')}</option>
              {suppliers.value!.map((supplier) => (
                <option key={supplier.id} value={supplier.id}>
                  {supplierName(supplier)}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field label={d('parts.col.article')} hint={d('supplier.articleHint')}>
          <Input value={model.draft.articleCode} maxLength={100} onChange={(event) => actions?.onDraft?.({ articleCode: event.target.value, supplierId: model.draft.supplierId || part.supplier?.id || '' })} />
        </Field>
        <Refusal model={model} />
      </div>
    </Modal>
  )
}

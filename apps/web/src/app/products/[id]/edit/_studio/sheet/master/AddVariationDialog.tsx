'use client'

/**
 * PES.2 / F4 — the COLLECT step of "Add variation".
 *
 * `PARAMETERISED_VERB_ORDER` is COLLECT → PREFLIGHT → CONFIRM → RUN, and this is the first of the
 * four: the operator says WHAT variation, and only then does the verb describe it. Collecting after
 * the confirm would mean confirming a question that had not been asked.
 *
 * It decides nothing. Validation is `addVariation.ts` (pure, tested); severity and wording are the
 * verb's preflight; the ask is the shared `ActionConfirm`. This file is a form.
 *
 * 🔴 The axis fields are built from `family.self.variationAxes` rather than typed by the operator.
 * A free-text "attributes" box would let one variation be `Colore: Nero` and the next `colore:
 * nero`, and the endpoint does NOT normalise case despite a comment saying it does — so the family
 * would silently split into two axes that look identical on screen.
 */
import { useEffect, useMemo, useState } from 'react'

import { Button, Input, Select } from '@/design-system/primitives'
import { Modal } from '@/design-system/components'

import { blocking, suggestSku, validateNewVariation, warnings, type NewVariationDraft } from './addVariation'
import { familyAxes, type FamilyResponse } from './family'

export interface AddVariationDialogProps {
  open: boolean
  family: FamilyResponse | null
  onCancel: () => void
  /** Hands the finished draft up; the verb takes it from there. */
  onCollected: (draft: NewVariationDraft) => void
}

const EMPTY: NewVariationDraft = { sku: '', name: '', axisValues: {} }

export function AddVariationDialog({ open, family, onCancel, onCollected }: AddVariationDialogProps) {
  const axes = useMemo(() => familyAxes(family), [family])
  const [draft, setDraft] = useState<NewVariationDraft>(EMPTY)
  // Whether the operator has taken over the SKU. Until they do it tracks the axis values, because a
  // suggestion that stops updating the moment you touch a colour is worse than no suggestion.
  const [skuTouched, setSkuTouched] = useState(false)

  useEffect(() => {
    if (open) { setDraft({ ...EMPTY, name: family?.self.name ?? '' }); setSkuTouched(false) }
  }, [open, family?.self.name])

  const suggested = suggestSku(family?.self.sku, draft.axisValues)
  const effective: NewVariationDraft = { ...draft, sku: skuTouched ? draft.sku : suggested }
  const problems = validateNewVariation(effective, family)
  const blockers = blocking(problems)
  const warns = warnings(problems)

  const setAxis = (axis: string, value: string) =>
    setDraft((d) => ({ ...d, axisValues: { ...d.axisValues, [axis]: value } }))

  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={`Add a child to ${family?.self.sku ?? 'this family'}`}
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={onCancel}>Cancel</Button>
          <Button variant="primary" disabled={blockers.length > 0} onClick={() => onCollected(effective)}>
            Review…
          </Button>
        </>
      }
    >
      <div className="nds-grid-confirm-block">
        {axes.length > 0 ? (
          <>
            <div className="nds-cell-strong">What makes it different</div>
            <div className="nds-addvar-axes">
              {axes.map((axis) => (
                <label key={axis} className="nds-addvar-field">
                  <span className="nds-cell-muted">{axis}</span>
                  <Input
                    value={draft.axisValues[axis] ?? ''}
                    onChange={(e) => setAxis(axis, e.target.value)}
                    placeholder={`e.g. ${axis === 'Taglia' ? 'L' : 'Nero'}`}
                    autoComplete="off"
                  />
                </label>
              ))}
            </div>
          </>
        ) : (
          <span className="nds-cell-muted">
            This family has no variation axes set, so there is nothing to tell children apart by yet.
          </span>
        )}
      </div>

      <div className="nds-grid-confirm-block">
        <div className="nds-cell-strong">Identity</div>
        <div className="nds-addvar-axes">
          <label className="nds-addvar-field">
            <span className="nds-cell-muted">SKU{!skuTouched && suggested ? ' · suggested from the axes' : ''}</span>
            <Input
              value={effective.sku}
              onChange={(e) => { setSkuTouched(true); setDraft((d) => ({ ...d, sku: e.target.value })) }}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <label className="nds-addvar-field">
            <span className="nds-cell-muted">Name</span>
            <Input value={draft.name} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} autoComplete="off" />
          </label>
          <label className="nds-addvar-field">
            <span className="nds-cell-muted">Base price</span>
            <Input value={draft.basePrice ?? ''} onChange={(e) => setDraft((d) => ({ ...d, basePrice: e.target.value }))} placeholder="0" inputMode="decimal" />
          </label>
          <label className="nds-addvar-field">
            <span className="nds-cell-muted">Stock</span>
            <Input value={draft.totalStock ?? ''} onChange={(e) => setDraft((d) => ({ ...d, totalStock: e.target.value }))} placeholder="0" inputMode="numeric" />
          </label>
        </div>
      </div>

      {(family?.children.length ?? 0) > 0 && (
        <div className="nds-grid-confirm-block">
          <div className="nds-cell-strong">Start from an existing child</div>
          <span className="nds-cell-muted">
            Copies that child&apos;s channel content and attributes, without its colour, size or identifiers.
          </span>
          {/* The DS Select takes children, not an options prop — it wraps the native element.
              🔴 Worded WITHOUT the literal element name: `ds-conformance-guard` matches the opening
              tag across the whole file INCLUDING COMMENTS, so the previous phrasing counted this DS
              usage as a hand-rolled native control and kept #601 red with nothing to fix. Writing
              this note is how I did it twice — the first rewording quoted the guard's own regex and
              scored again. A note about a thing is not the thing, and the guard cannot tell. */}
          <Select
            value={draft.copyFromProductId ?? ''}
            onChange={(e) => setDraft((d) => ({ ...d, copyFromProductId: e.target.value || undefined }))}
            aria-label="Start from an existing child"
          >
            <option value="">Start empty</option>
            {(family?.children ?? []).map((c) => <option key={c.id} value={c.id}>{c.sku}</option>)}
          </Select>
        </div>
      )}

      {(blockers.length > 0 || warns.length > 0) && (
        <div className="nds-grid-confirm-block">
          <ul className="nds-grid-confirm-list">
            {blockers.map((p, i) => <li key={`e${i}`} className="nds-grid-confirm-error">{p.message}</li>)}
            {warns.map((p, i) => <li key={`w${i}`} className="nds-grid-confirm-warn">{p.message}</li>)}
          </ul>
        </div>
      )}
    </Modal>
  )
}

'use client'

/**
 * RuleBuilder — a rule as condition rows joined by AND or OR (B-W2b-207, design part RuleBuilder): a quote's approval
 * rule, an option's rules, a chain. Each row picks what it checks, how it compares and the value (a number with its unit,
 * text, one choice or several, nothing for yes / no); the whole rule reads in plain words under the rows ("A quote needs
 * approval when margin is under 20 % or discount is over 15 %"); Apply is held while a row is incomplete, naming the first
 * ("Condition 2: enter a value").
 *
 *   <RuleBuilder label={t('rule')} fields={fields} value={draft} onChange={setDraft} onApply={save}
 *                lead={t('needsApprovalWhen')} locale="it-IT" labels={ds.ruleBuilder} />
 *
 * - Controlled: the page holds the draft (`value`, `onChange`) and saves it (`onApply`, or its own EditModeBar held by
 *   `ruleHeldReason`). `applyHeldReason` holds Apply for the page's reason (offline, no right) while the rows stay editable.
 * - `readOnly` (or no `onChange`): the rule drawn as words, not greyed inputs, with `readOnlyReason`.
 * - A field the person may not use (`heldReason`, a margin without the grain) is listed with its reason and cannot be
 *   picked. Keyboard: native controls in reading order; Add puts the focus on the new row, Remove on the row before.
 */
import { useEffect, useId, useMemo, useRef } from 'react'
import { Plus, Trash2 } from 'lucide-react'

import { mergeLabels } from '../../lib/labels'
import { Button } from '../../primitives/Button'
import { Checkbox } from '../../primitives/Checkbox'
import { Input } from '../../primitives/Input'
import { SegmentedControl } from '../../primitives/SegmentedControl'
import { Select } from '../../primitives/Select'
import { RULE_BUILDER_LABELS, type RuleBuilderLabels } from './RuleBuilderLabels'
import {
  newRuleRow,
  operatorNeedsValue,
  operatorsOf,
  operatorTakesMany,
  ruleHeldReason,
  rulePreview,
  ruleRowProblem,
  ruleRowText,
  withRuleField,
  withRuleOperator,
  type RuleCombinator,
  type RuleDraft,
  type RuleField,
  type RuleOperator,
  type RuleRow,
} from './ruleBuilderModel'
import './ruleBuilder.css'

export interface RuleBuilderProps {
  /** The rule's name ("Quote approval rule"). */
  label: string
  /** What a row may check, with its words and kind. */
  fields: readonly RuleField[]
  /** The rule now. */
  value: RuleDraft
  /** A change of any row or of AND / OR. Absent: the rule is drawn as words. */
  onChange?: (draft: RuleDraft) => void
  /** Apply the rule (held while a row is incomplete). Absent: no Apply (the page's EditModeBar applies). */
  onApply?: (draft: RuleDraft) => void
  /** Apply's words ("Save rule"). */
  applyLabel?: string
  /** The page's reason to hold Apply (offline: "your changes are kept on this page"; no right). */
  applyHeldReason?: string | null
  /** Draw the rule as words. */
  readOnly?: boolean
  /** Why it is read only ("Read-only: the rule is in use"). */
  readOnlyReason?: string | null
  /** The preview's words before the conditions ("A quote needs approval when"). */
  lead?: string | null
  /** The preview's words after them ("— block"). */
  outcome?: string | null
  /** The most rows (default 10). */
  maxRows?: number
  /** The page's language for numbers in the preview (default en-GB). */
  locale?: string
  className?: string
  labels?: Partial<RuleBuilderLabels>
}

export function RuleBuilder({
  label,
  fields,
  value,
  onChange,
  onApply,
  applyLabel,
  applyHeldReason,
  readOnly,
  readOnlyReason,
  lead,
  outcome,
  maxRows = 10,
  locale = 'en-GB',
  className,
  labels,
}: RuleBuilderProps) {
  const lw = mergeLabels(RULE_BUILDER_LABELS, labels)
  const id = useId()
  const fieldRefs = useRef(new Map<string, HTMLSelectElement>())
  const addRef = useRef<HTMLButtonElement>(null)
  const focusNext = useRef<string | null>(null)
  const counter = useRef(0)
  const formatNumber = useMemo(() => {
    const format = new Intl.NumberFormat(locale, { maximumFractionDigits: 6 })
    return (number: string) => format.format(Number(number))
  }, [locale])
  const editable = !!onChange && !readOnly
  const preview = rulePreview(value, fields, lw, { lead, outcome, formatNumber })
  const held = ruleHeldReason(value, fields, lw)
  const applyHeld = applyHeldReason ?? held
  const firstProblem = value.rows.find((row) => ruleRowProblem(row, fields) !== null)?.id ?? null

  useEffect(() => {
    const target = focusNext.current
    if (!target) return
    focusNext.current = null
    if (target === 'add') addRef.current?.focus()
    else fieldRefs.current.get(target)?.focus()
  }, [value.rows])

  const setRow = (rowId: string, next: (row: RuleRow) => RuleRow) => onChange?.({ ...value, rows: value.rows.map((row) => (row.id === rowId ? next(row) : row)) })
  const add = () => {
    counter.current += 1
    const row = newRuleRow(`${id}-r${counter.current}-${value.rows.length}`)
    focusNext.current = row.id
    onChange?.({ ...value, rows: [...value.rows, row] })
  }
  const remove = (index: number) => {
    const rows = value.rows.filter((_, at) => at !== index)
    focusNext.current = rows[Math.max(0, index - 1)]?.id ?? 'add'
    onChange?.({ ...value, rows })
  }

  if (!editable) {
    return (
      <section className={['nds-rb', 'is-read', className].filter(Boolean).join(' ')} aria-label={label}>
        {readOnlyReason ? <p className="nds-rb-note">{readOnlyReason}</p> : null}
        <ol className="nds-rb-read">
          {value.rows.map((row, index) => (
            <li key={row.id}>
              {index > 0 ? <span className="nds-rb-join">{value.combinator === 'and' ? lw.and : lw.or} </span> : null}
              {ruleRowText(row, index, fields, lw, formatNumber)}
            </li>
          ))}
        </ol>
        <div className="nds-rb-preview">
          <span className="nds-rb-sub">{lw.preview}</span>
          <p>{preview}</p>
        </div>
      </section>
    )
  }

  return (
    <fieldset className={['nds-rb', className].filter(Boolean).join(' ')}>
      <legend className="nds-rb-legend">{label}</legend>
      {value.rows.length > 1 ? (
        <div className="nds-rb-combinator">
          <span className="nds-rb-sub" id={`${id}-comb`}>
            {lw.combinator}
          </span>
          <SegmentedControl
            ariaLabel={lw.combinator}
            size="sm"
            wrap
            value={value.combinator}
            options={[
              { value: 'and', label: lw.all },
              { value: 'or', label: lw.any },
            ]}
            onChange={(combinator) => onChange?.({ ...value, combinator: combinator as RuleCombinator })}
          />
        </div>
      ) : null}
      <ol className="nds-rb-rows">
        {value.rows.map((row, index) => {
          const n = index + 1
          const field = fields.find((entry) => entry.id === row.field)
          const problem = ruleRowProblem(row, fields)
          const marked = row.id === firstProblem
          return (
            <li key={row.id} className="nds-rb-row" data-incomplete={problem ? 'true' : undefined}>
              {index > 0 ? (
                <span className="nds-rb-join" aria-hidden="true">
                  {value.combinator === 'and' ? lw.and : lw.or}
                </span>
              ) : null}
              <span className="nds-rb-rowname">{lw.row(n)}</span>
              <div className="nds-rb-controls">
                <Select
                  size="sm"
                  ref={(element) => {
                    if (element) fieldRefs.current.set(row.id, element)
                    else fieldRefs.current.delete(row.id)
                  }}
                  aria-label={lw.fieldOf(n)}
                  aria-invalid={marked && (problem === 'field' || problem === 'fieldHeld') ? true : undefined}
                  value={row.field ?? ''}
                  onChange={(event) => setRow(row.id, (current) => withRuleField(current, event.target.value || null, fields))}
                >
                  <option value="">{lw.pickField}</option>
                  {fields.map((option) => (
                    <option key={option.id} value={option.id} disabled={!!option.heldReason && option.id !== row.field}>
                      {option.heldReason ? `${option.label} — ${option.heldReason}` : option.label}
                    </option>
                  ))}
                </Select>
                {field ? (
                  <Select
                    size="sm"
                    aria-label={lw.operatorOf(n)}
                    aria-invalid={marked && problem === 'operator' ? true : undefined}
                    value={row.operator ?? ''}
                    onChange={(event) => setRow(row.id, (current) => withRuleOperator(current, (event.target.value || null) as RuleOperator | null))}
                  >
                    {!row.operator ? <option value="">{lw.pickOperator}</option> : null}
                    {operatorsOf(field).map((operator) => (
                      <option key={operator} value={operator}>
                        {lw.operatorNames[operator]}
                      </option>
                    ))}
                  </Select>
                ) : null}
                {field && row.operator && operatorNeedsValue(row.operator) ? (
                  <ValueControl row={row} field={field} n={n} invalid={marked && (problem === 'value' || problem === 'number' || problem === 'range' || problem === 'choice')} lw={lw} onValue={(next) => setRow(row.id, (current) => ({ ...current, value: next }))} />
                ) : null}
                <Button
                  size="sm"
                  variant="quiet"
                  className="nds-rb-remove"
                  aria-label={lw.removeRow(n)}
                  heldReason={value.rows.length === 1 ? lw.lastRow : null}
                  onClick={() => remove(index)}
                >
                  <Trash2 size={13} aria-hidden />
                </Button>
              </div>
            </li>
          )
        })}
      </ol>
      <div className="nds-rb-add">
        <Button ref={addRef} size="sm" heldReason={value.rows.length >= maxRows ? lw.maxRows(maxRows) : null} onClick={add}>
          <Plus size={13} aria-hidden /> {lw.addRow}
        </Button>
      </div>
      <div className="nds-rb-preview">
        <span className="nds-rb-sub">{lw.preview}</span>
        <p>{preview}</p>
      </div>
      {onApply ? (
        <div className="nds-rb-actions">
          {applyHeld ? <p className="nds-rb-held">{applyHeld}</p> : null}
          <Button size="sm" variant="primary" heldReason={applyHeld} onClick={() => onApply(value)}>
            {applyLabel ?? lw.apply}
          </Button>
        </div>
      ) : null}
    </fieldset>
  )
}

function ValueControl({
  row,
  field,
  n,
  invalid,
  lw,
  onValue,
}: {
  row: RuleRow
  field: RuleField
  n: number
  invalid: boolean
  lw: RuleBuilderLabels
  onValue: (value: string | readonly string[] | null) => void
}) {
  if (field.kind === 'choice' && operatorTakesMany(row.operator)) {
    const picked = Array.isArray(row.value) ? row.value : []
    return (
      <div className="nds-rb-many" role="group" aria-label={lw.valueOf(n)} aria-invalid={invalid || undefined}>
        {(field.options ?? []).map((option) => (
          <Checkbox
            key={option.value}
            label={option.label}
            checked={picked.includes(option.value)}
            onChange={(event) => onValue(event.target.checked ? [...picked, option.value] : picked.filter((value) => value !== option.value))}
          />
        ))}
      </div>
    )
  }
  const text = typeof row.value === 'string' ? row.value : ''
  if (field.kind === 'choice') {
    return (
      <Select size="sm" aria-label={lw.valueOf(n)} aria-invalid={invalid || undefined} value={text} onChange={(event) => onValue(event.target.value || null)}>
        <option value="">{lw.pickValue}</option>
        {(field.options ?? []).map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </Select>
    )
  }
  return (
    <Input
      size="sm"
      fieldClassName="nds-rb-value"
      inputMode={field.kind === 'number' ? 'decimal' : undefined}
      autoComplete="off"
      aria-label={lw.valueOf(n)}
      aria-invalid={invalid || undefined}
      suffix={field.kind === 'number' && field.unit ? field.unit : undefined}
      value={text}
      onChange={(event) => onValue(event.target.value)}
    />
  )
}

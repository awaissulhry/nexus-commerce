'use client'

/**
 * SizeFill — "Fill from the base by increment" (B-W2b-207, design part SizeColumns): the base size and its value, the
 * increment per size step, the values typed by hand kept (by default), the preview of every value that changes, and Fill
 * held while there is nothing to fill or the fill cannot be done — with the reason on screen. The page opens it (a Modal,
 * a popover, a drawer) and saves what `onApply` gives it.
 *
 *   <SizeFill sizes={range} base="M" values={line.bySize} unit="m²" overrides={typedSizes} locale="it-IT"
 *             onApply={(changes) => save(changes)} onCancel={close} labels={ds.sizeColumns} />
 */
import { useId, useMemo, useState } from 'react'
import { ArrowRight } from 'lucide-react'

import { mergeLabels } from '../../lib/labels'
import { Button } from '../../primitives/Button'
import { Checkbox } from '../../primitives/Checkbox'
import { Input } from '../../primitives/Input'
import { SIZE_COLUMNS_LABELS, type SizeColumnsLabels } from './SizeColumnsLabels'
import { fillFromBase, parseSizeValue, sizeValueOf, sizeValueText, type SizeFillChange, type SizeValue } from './sizeColumnsModel'
import './sizeColumns.css'

export interface SizeFillProps {
  /** The sizes in scale order. */
  sizes: readonly string[]
  /** The base size: its value is where the fill starts. */
  base: string | null | undefined
  /** The values now, by size (decimal strings or null). */
  values: Readonly<Record<string, string | number | null | undefined>>
  /** The unit (said beside the increment and in the base line). */
  unit?: string | null
  /** The sizes whose value was typed by hand (kept unless the person unticks "Keep"). */
  overrides?: readonly string[]
  /** The increment to start with (the grade rule's, the last one used). */
  defaultIncrement?: string
  /** The most decimals (default 4). */
  scale?: number
  /** The page's language for numbers (default en-GB). */
  locale?: string
  /** The changed values, to save. */
  onApply: (changes: SizeFillChange[]) => void
  onCancel?: () => void
  /** Why it cannot fill now (released revision, offline): Fill held with these words. */
  heldReason?: string | null
  headingLevel?: 2 | 3 | 4
  className?: string
  labels?: Partial<SizeColumnsLabels>
}

export function SizeFill({
  sizes,
  base,
  values,
  unit = null,
  overrides,
  defaultIncrement = '',
  scale = 4,
  locale = 'en-GB',
  onApply,
  onCancel,
  heldReason,
  headingLevel = 3,
  className,
  labels,
}: SizeFillProps) {
  const lw = mergeLabels(SIZE_COLUMNS_LABELS, labels)
  const id = useId()
  const [text, setText] = useState(defaultIncrement)
  const [keep, setKeep] = useState(true)
  const write = (value: SizeValue) => (value === null ? null : [sizeValueText(value, locale, scale), unit].filter(Boolean).join(' '))
  const normal = useMemo(() => {
    const out: Record<string, SizeValue> = {}
    for (const size of sizes) out[size] = sizeValueOf(values[size] ?? null)
    return out
  }, [sizes, values])
  const kept = (overrides ?? []).filter((size) => size !== base && sizes.includes(size))
  const increment = parseSizeValue(text, { scale, negative: true })
  const result = increment.ok && increment.value !== null ? fillFromBase({ sizes, base, values: normal, increment: increment.value, keep: keep ? kept : [] }) : null
  const changes = result?.ok ? result.changes : []
  const held =
    heldReason ??
    (!base || !sizes.includes(base)
      ? lw.fillNoBase
      : normal[base] === null
        ? lw.fillBaseMissing(base)
        : text.trim() === ''
          ? lw.fillNoIncrement
          : !increment.ok
            ? lw.fillNotNumber
            : result && !result.ok && result.problem === 'belowZero'
              ? lw.fillBelowZero(result.size ?? '')
              : changes.length === 0
                ? lw.fillNothing
                : null)
  const Heading = `h${headingLevel}` as 'h2' | 'h3' | 'h4'
  const baseValue = base ? write(normal[base] ?? null) : null

  return (
    <div className={['nds-sizefill', className].filter(Boolean).join(' ')} role="group" aria-labelledby={`${id}-title`}>
      <Heading id={`${id}-title`} className="nds-sizefill-title">
        {lw.fillTitle}
      </Heading>
      {base && baseValue ? <p className="nds-sizefill-base">{lw.fillBase(base, baseValue)}</p> : null}
      <div className="nds-sizefill-field">
        <label className="nds-sizefill-label" htmlFor={`${id}-inc`}>
          {lw.fillIncrement}
        </label>
        <Input
          id={`${id}-inc`}
          size="sm"
          inputMode="decimal"
          autoComplete="off"
          value={text}
          suffix={unit ?? undefined}
          aria-describedby={`${id}-hint`}
          aria-invalid={text.trim() !== '' && !increment.ok ? true : undefined}
          onChange={(event) => setText(event.target.value)}
        />
        <p id={`${id}-hint`} className="nds-sizefill-hint">
          {lw.fillIncrementHint}
        </p>
      </div>
      {kept.length > 0 ? <Checkbox checked={keep} onChange={(event) => setKeep(event.target.checked)} label={lw.fillKeep(kept.length)} /> : null}
      {changes.length > 0 ? (
        <div className="nds-sizefill-changes">
          <p className="nds-sizefill-count">{lw.fillChanges(changes.length)}</p>
          <ul className="nds-sizefill-list">
            {changes.map((change) => {
              const from = write(change.from)
              const to = write(change.to) ?? ''
              return (
                <li key={change.size} className="nds-sizefill-chip">
                  <span className="nds-sizefill-sr">{lw.fillChange(change.size, from, to)}</span>
                  <b aria-hidden="true">{change.size}</b>
                  <span className="nds-sizefill-from" aria-hidden="true">
                    {from ?? lw.missing}
                  </span>
                  <ArrowRight size={12} aria-hidden />
                  <span aria-hidden="true">{to}</span>
                </li>
              )
            })}
          </ul>
        </div>
      ) : null}
      {held ? <p className="nds-sizefill-held">{held}</p> : null}
      <div className="nds-sizefill-actions">
        <Button size="sm" variant="primary" heldReason={held} onClick={() => onApply(changes)}>
          {lw.fillApply}
        </Button>
        {onCancel ? (
          <Button size="sm" onClick={onCancel}>
            {lw.fillCancel}
          </Button>
        ) : null}
      </div>
    </div>
  )
}

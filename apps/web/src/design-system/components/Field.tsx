'use client'

import { Children, cloneElement, isValidElement, useId, type ReactElement, type ReactNode } from 'react'

export interface FieldProps {
  /** the visible label */
  label: ReactNode
  /** marks the field required: a red asterisk, and `required` is NOT inferred on the control */
  required?: boolean
  /** helper text under the control, wired to it with `aria-describedby` */
  hint?: ReactNode
  /** slot beside the label — pass an `<InfoTip>` */
  info?: ReactNode
  /**
   * Explicit id of the control. Usually unnecessary: a single element child is cloned with a
   * generated id so the label points at it. Pass this when the child is a fragment, a list, or
   * already carries an id you need to keep.
   */
  htmlFor?: string
  children: ReactNode
  className?: string
}

/**
 * Label + required marker + info slot + control + hint.
 *
 * Replaces SIX spellings of the same wrapper across the ads console — `.h10-spw-field`,
 * `.h10-aig-field`, `.h10-cd-field`, `.h10-bulk-field`, `.h10-ai-field`, `.pf-fld`. Five of the
 * six are `flex column` with a 4-7px gap; 6px is the plurality and what this uses.
 *
 * Two of its three colours fix a live AA failure rather than merely matching what is there:
 *
 *   label     #37495b 9.27:1  →  --nds-text-strong  9.87:1   rises
 *   required  #e0392b 4.38:1  →  --nds-danger-text  7.36:1   4.38 FAILED AA
 *   hint      grey-500 3.10:1 →  --nds-text-muted   5.01:1   3.10 FAILED AA badly
 *
 * The label is a real `<label htmlFor>`, which none of the six hand-rolled versions managed
 * consistently — `.pf-fld` and `.h10-ai-field` label with a bare `<span>`, so clicking the text
 * does nothing and a screen reader announces the control unlabelled.
 */
export function Field({ label, required, hint, info, htmlFor, children, className }: FieldProps) {
  const auto = useId()
  const hintId = hint != null ? `${auto}-hint` : undefined

  // Associate the label without making the caller invent an id. Only a single element child is
  // cloned, and an id it already carries always wins.
  let control = children
  let forId = htmlFor
  if (!forId && isValidElement(children) && Children.count(children) === 1) {
    const el = children as ReactElement<{ id?: string; 'aria-describedby'?: string }>
    forId = el.props.id ?? auto
    control = cloneElement(el, {
      id: forId,
      'aria-describedby': [el.props['aria-describedby'], hintId].filter(Boolean).join(' ') || undefined,
    })
  }

  return (
    <div className={['nds-field-w', className].filter(Boolean).join(' ')}>
      <label className="nds-field-lbl" htmlFor={forId}>
        {label}
        {required && (
          <span className="req" aria-hidden>
            *
          </span>
        )}
        {info != null && <span className="nds-field-info">{info}</span>}
      </label>
      {control}
      {hint != null && (
        <span className="nds-field-hint" id={hintId}>
          {hint}
        </span>
      )}
    </div>
  )
}

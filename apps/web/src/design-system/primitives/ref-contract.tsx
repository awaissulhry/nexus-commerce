/**
 * Compile-time proof that the form controls forward their refs.
 *
 * This file renders nothing and is never imported. It exists because the failure it guards is
 * SILENT: apps/web runs React 18.3.1 (its own nested copy — the 19.x at the repo root is hoisted
 * for something else), and on 18 a `ref` handed to a plain function component is dropped with no
 * warning and no type error at the CALL SITE. `ref.current` simply stays null and the imperative
 * focus never happens. Measured 2026-08-25: not one of the DS's 30 components forwarded a ref.
 *
 * The slots are `export const` rather than a `type`: the DS api-guard requires every exported
 * TYPE to be re-exported from the area barrel, and this file is not public API. Exporting the
 * consts satisfies `noUnusedLocals` without claiming barrel space.
 *
 * Each component is assigned to a `ForwardRefExoticComponent` slot, which a plain function cannot
 * satisfy — it has no `$$typeof`. tsc therefore fails the moment one is unwrapped, so the
 * regression cannot land quietly a second time.
 *
 * The first version of this file used `ForwardRefExoticComponent<P & RefAttributes<T>>` and was VACUOUS: a
 * plain function is assignable to that, because it may simply ignore the extra prop. It was
 * verified by unwrapping a component and confirming tsc still passed — a test that cannot fail is
 * worse than no test, since it reports safety that was never checked.
 */
import type { ForwardRefExoticComponent, RefAttributes } from 'react'
import { Button, type ButtonProps } from './Button'
import { Checkbox, type CheckboxProps } from './Checkbox'
import { Input, type InputProps } from './Input'
import { Radio, type RadioProps } from './Radio'
import { Select, type SelectProps } from './Select'
import { Textarea, type TextareaProps } from './Textarea'

export const _button: ForwardRefExoticComponent<ButtonProps & RefAttributes<HTMLButtonElement>> = Button
export const _checkbox: ForwardRefExoticComponent<CheckboxProps & RefAttributes<HTMLInputElement>> = Checkbox
export const _input: ForwardRefExoticComponent<InputProps & RefAttributes<HTMLInputElement>> = Input
export const _radio: ForwardRefExoticComponent<RadioProps & RefAttributes<HTMLInputElement>> = Radio
export const _select: ForwardRefExoticComponent<SelectProps & RefAttributes<HTMLSelectElement>> = Select
export const _textarea: ForwardRefExoticComponent<TextareaProps & RefAttributes<HTMLTextAreaElement>> = Textarea

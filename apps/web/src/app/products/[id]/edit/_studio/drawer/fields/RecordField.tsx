'use client'

/**
 * PES.4.3 — one attribute, with its provenance and its two verbs.
 *
 * The interaction is the one `InheritanceAwareField` (PIM B.2) established and the layout spec
 * kept: an inherited value reads as a GHOST — italic, dashed, quoting somewhere else — and
 * clicking it opens an input prefilled with what it was inheriting, so the operator edits a
 * starting point rather than an empty box. The first committed keystroke is what pins the
 * override; an operator who clicks in and clicks out again has changed nothing. A pinned value
 * reads as this scope's own and offers Reset, which returns it to inheritance.
 *
 * What is NOT mined from that component: its markup. It is Tailwind, it hard-codes `zinc-*`
 * colours that have no dark-mode answer, and it spells the two states differently from the eBay
 * cockpit's `FieldSourceBadge` next door. The wording, the chip and the tokens are one system
 * here — see `ProvenanceChip`.
 *
 * Writes leave through `onWrite` and nowhere else. That callback is the SHEET's mutator: the same
 * `PATCH /api/products/bulk` with the same `expectedVersion`, so a field saved here repaints its
 * cell in the grid behind and lands in the same audit row it would have from the sheet.
 */

import { ImpactProtectorsInput } from '../../sheet/ImpactProtectorsInput'
import { EbayPolicyInput, isEbayPolicyField } from '../../sheet/EbayPolicyInput'
import ProductTypePicker from '@/components/products/ProductTypePicker'
import { AttributeShapeInput } from '../../sheet/AttributeShapeInput'
import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { History, Pencil, Pin, RotateCcw } from 'lucide-react'
import { Field } from '@/design-system/components/Field'
import { Input } from '@/design-system/primitives/Input'
import { Select } from '@/design-system/primitives/Select'
import { Toggle } from '@/design-system/primitives/Toggle'
import { ToolbarButton } from '@/design-system/primitives/ToolbarButton'
import {
  isOwnValue,
  resolveLayer,
  type DrawerFormulas,
  type ReadinessIssue,
  type RecordWriteResult,
  type SheetColumn,
  type StudioCellValue,
} from '../types'
import {
  FORMULA_BLOCKED_REASON,
  FormulaGlyph,
  formulaAvailability,
  isFormulaDraft,
  type FormulaCandidate,
} from '@/design-system/grid'
import { ProvenanceChip } from './ProvenanceChip'
import { FormulaField } from './FormulaField'
import { HtmlField } from './HtmlField'
import { longTextState } from '@/design-system/grid/renderers/longTextState'
import { overCapNote } from '../format'
import { PressableRow } from '@/design-system/components/PressableRow'
import styles from '../drawer.module.css'

/** Idle autosave. There is no page Save, so a value typed and abandoned must still land. */
const IDLE_MS = 900

export interface RecordFieldProps {
  column: SheetColumn
  cell: StudioCellValue | undefined
  /** Ringed because the operator expanded from this cell. Deliberately NOT focused. */
  focused?: boolean
  /** Which projection this field is rendered in — decides whether a master write is cross-channel. */
  scopeKind?: 'master' | 'channel'
  /** Set when the field cannot be edited in this scope, e.g. a per-variant field on a parent row. */
  lockedReason?: string
  issue?: ReadinessIssue
  state?: RecordWriteResult
  /**
   * Every callback takes the COLUMN, so the parent can pass one stable function per handler
   * instead of minting a closure per field per render.
   *
   * 🔴 Measured by FE.1: opening the drawer re-rendered the same 96 fields FOUR times — 178.8ms of
   * 254ms, with `ToolbarButton ×192`, `Tooltip ×192`, `InfoTip ×100`. The cause was four fresh
   * arrows handed to each field on every render, which makes `memo` structurally unable to help:
   * the props differ by identity every time even when nothing about the field changed.
   */
  onWrite: (column: SheetColumn, value: unknown, intent: 'set' | 'pin') => void
  onReset: (column: SheetColumn) => void
  onHistory: (column: SheetColumn) => void

  /* ── D16 formulas (#708/#775). All optional together: a host that has not wired the seam gets a
     field with no formula affordances rather than a broken one, and `=` stays ordinary text. ── */
  /** The record's id — what the formula store keys on, alongside the column. */
  rowId?: string
  /** Supplied by the HOST sheet, which already owns `useCellFormulas`. See `DrawerFormulas`. */
  formulas?: DrawerFormulas
  /** What a `$reference` may name on this row, with values. Built ONCE per record by the pane. */
  candidates?: readonly FormulaCandidate[]
  /** A formula was stored: the value it produced is the server's to report, so the host refetches. */
  onFormulaSaved?: () => void
  /**
   * 🔴 Why this scope refuses writes WHOLESALE. Present = formula AUTHORING is suppressed here.
   *
   * A formula is a write, and it reaches the server through `DrawerFormulas.save` rather than
   * `onWrite` — so a host that refuses every write cannot stop it, and would otherwise show an
   * operator a live ƒ control directly under its own "this drawer is read-only" refusal. A stored
   * formula still DISPLAYS, read-only, so its rule stays readable. See `RecordDrawerProps`.
   */
  writesRefused?: string
}

function asText(v: unknown): string {
  if (v == null) return ''
  if (Array.isArray(v)) return v.join('\n')
  return String(v)
}

function RecordFieldImpl({
  column,
  cell,
  focused,
  scopeKind,
  lockedReason,
  issue,
  state,
  onWrite,
  onReset,
  onHistory,
  rowId,
  formulas,
  candidates,
  onFormulaSaved,
  writesRefused,
}: RecordFieldProps) {
  // PES.5 §3.2 sends `layer` and `pinned` per cell, so neither is derived here when the studio
  // read supplied them — the server knows which layer stores the value; this component was only
  // ever inferring it.
  const layer = resolveLayer(cell)
  const inherited = !isOwnValue(cell)
  const effective = asText(cell?.value)

  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(effective)
  const timer = useRef<number | undefined>(undefined)

  // Repaint from the server's answer whenever it changes underneath — a 409 refetch, a copy-across
  // from the compare pane, a sibling's edit arriving on the sheet. Not while the operator is
  // mid-edit: overwriting a half-typed value with the old one is the worst version of "live".
  useEffect(() => {
    if (!editing) setDraft(effective)
  }, [effective, editing])

  useEffect(() => () => window.clearTimeout(timer.current), [])

  const commit = useCallback(
    (value: unknown) => {
      window.clearTimeout(timer.current)
      // An operator who clicked into a ghost and clicked out again changed nothing. Writing here
      // would pin an override with the master's own value — a divergence that then stops tracking
      // master, invisibly, because someone tabbed through the form.
      if (asText(value) === effective) return
      // `pin` means "give this scope its own value", which a master-routed cell cannot do — the
      // write lands on the shared record either way. Sending `pin` would ask for an override the
      // contract says does not exist.
      const canPin = (column.writeTarget ?? cell?.writeTarget) !== 'master'
      onWrite(column, value, inherited && canPin ? 'pin' : 'set')
    },
    [column, effective, inherited, onWrite, cell?.writeTarget],
  )

  const scheduleCommit = useCallback(
    (value: unknown) => {
      window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => commit(value), IDLE_MS)
    },
    [commit],
  )

  // `cell.editable` is the server's answer for THIS coordinate; the column's is the family-wide
  // default. The narrower one wins, because a field editable on master can be locked on a channel.
  // `writable: false` outranks everything — the server is saying this write cannot be made yet,
  // whatever the column, the layer or the scope think.
  const editable =
    cell?.writable !== false &&
    (cell?.editable ?? column.editable) &&
    !lockedReason &&
    layer !== 'locked' &&
    layer !== 'mapped'
  const disabledReason =
    // The server's own sentence first: it knows why (a non-primary alias row, an unproven path)
    // and a generic "read-only" would replace a real explanation with a shrug.
    cell?.writeBlockedReason ??
    lockedReason ??
    (layer === 'locked'
      ? 'An identity field pinned to master — it cannot diverge per channel.'
      : layer === 'mapped'
        ? 'Derived by the mapping engine. Change the rule at /channels/mapping, not the value here.'
        : !(cell?.editable ?? column.editable)
          ? 'This field is read-only in this scope.'
          : undefined)

  /* ── D16 formulas (#708/#775) ─────────────────────────────────────────────────────────────── */
  /* Both halves or neither: a `rowId` with no seam cannot read a formula, and a seam with no
     `rowId` cannot key one. Collapsing them here keeps every use below a single check. */
  const formulaSeam = formulas && rowId ? formulas : null
  const storedExpr = formulaSeam && rowId ? formulaSeam.exprFor(rowId, column.key) : null
  /* 🔴 The "already holds a formula" arm lives in `formulaAvailability`, not here: rules change, and
     a cell whose column has since left the allow-list must still open its formula — refusing would
     leave the operator looking at a computed value whose rule they can neither read nor remove. */
  const availability = formulaAvailability({
    formulaWritable: column.formulaWritable,
    hasStoredFormula: storedExpr != null,
  })
  const [formulaMode, setFormulaMode] = useState(false)
  /**
   * 🔴 A formula is a WRITE, and it does not travel through `onWrite` — so a host that refuses every
   * write cannot stop it, and would otherwise offer a live ƒ control directly under its own
   * "this drawer is read-only" refusal. Both behaviours deliberate, contradicting each other on one
   * screen. PES.3's channel scope is exactly that host.
   */
  const formulaWritesRefused = writesRefused != null
  /* A STORED formula still shows when writes are refused — read-only, so the rule stays readable.
     Hiding it would leave the operator looking at a computed value whose rule they cannot see,
     which is the hazard `formulaAvailability`'s "always available when stored" arm prevents. What
     is suppressed is AUTHORING: entering formula mode, and the ƒ and remove controls below. */
  const showFormula =
    formulaSeam != null && editable && (storedExpr != null || (formulaMode && !formulaWritesRefused))
  /* Typed `=` on a column the writer refuses. The `=` stays ordinary text and the reason is printed
     under the field — the alternative, swallowing the keystroke, teaches the operator nothing and
     looks like the field is broken. */
  const blockedFormula = availability.kind === 'blocked' && isFormulaDraft(draft) && !showFormula
  const [formulaError, setFormulaError] = useState<string | null>(null)

  /* Drop the rule, keep the value it last produced (#488 keeps the audit row, so it is restorable
     from the History pane). A failure is SHOWN: the formula is still there and the operator needs
     to know the removal did not happen, or they will read the next value as un-computed. */
  const removeFormula = useCallback(async () => {
    if (!formulaSeam || !rowId) return
    /* Removing a formula is a WRITE too — it pins the last computed value over the rule. The button
       is already hidden where writes are refused; this is the same defence-in-depth as
       `FormulaField.save`, because a hidden control and an impossible write are different claims. */
    if (formulaWritesRefused) return
    setFormulaError(null)
    const res = await formulaSeam.pinOver(rowId, column.key)
    if (res.ok) {
      setFormulaMode(false)
      onFormulaSaved?.()
      return
    }
    setFormulaError(res.error ?? 'The formula could not be removed.')
    /* `formulaWritesRefused` is in the deps for the same reason as in `FormulaField.save`: the guard
       above reads it, and a stale closure would keep a write path open after the scope closed it. */
  }, [formulaSeam, rowId, column.key, onFormulaSaved, formulaWritesRefused])

  /**
   * Shown on a channel but writing to master. `affectsAllChannels` is the server's own verdict;
   * the `writeTarget` check is the same fact from the other side, kept so a payload that sends
   * one without the other still warns rather than staying silent.
   */
  /**
   * COLUMN first, cell second (#333.1). The cell's copy is absent on blank cells, which is what
   * made this sentence appear on 5 of 97 fields — every field it was most needed on was empty.
   */
  const writeTarget = column.writeTarget ?? cell?.writeTarget
  const affectsAll = column.affectsAllChannels ?? cell?.affectsAllChannels
  const crossChannel = editable && scopeKind === 'channel' && (affectsAll === true || writeTarget === 'master')

  /**
   * The cap comes from the SHARED evaluator, and the HTML `maxLength` attribute is gone (#382).
   *
   * 🔴 Two reasons, and the second is why the attribute could not simply be extended:
   *
   * 1. It read `maxLength` only, so a byte-capped column was UNCAPPED here — `product_description`
   *    carries `maxBytes: 20000` and NO `maxLength` key at all (the wire omits an uncapped unit
   *    rather than sending null; measured 2026-09-02, null 0 of 96), so it had no cap in this
   *    field while the sheet one surface over enforced one. Two views of the same cell disagreeing.
   * 2. An HTML `maxLength` counts UTF-16 code units and **cannot express a byte cap**. Approximating
   *    one in characters is precisely the #373 defect, and there is no safe ratio to pick: on
   *    `age_range_description` (`maxLength: 1998, maxBytes: 2000`) 1999 ASCII characters break the
   *    character cap while fitting the byte cap, and 1001 × 'é' fit the character cap while breaking
   *    the byte cap. Which cap binds depends on the CONTENT, so any fixed choice is wrong for some
   *    input.
   *
   * `longTextState` measures both and takes the worse verdict — the same reading the sheet's cell
   * renders, so the drawer and the sheet cannot disagree about one value. Losing the attribute also
   * loses its silent truncation, which was data loss with no message; over-cap now warns instead.
   */
  const capReading = longTextState(draft, {
    maxLength: column.maxLength,
    maxBytes: column.maxBytes,
    capFrom: column.capFrom,
  })
  const over = capReading.state === 'over'

  const head = (
    <div className={styles.fieldHead}>
      <ProvenanceChip layer={layer} from={cell?.inheritedFrom ?? undefined} rawSource={cell?.source} />
      <span className={styles.fieldActions}>
        {state?.state === 'saving' && <span className={`${styles.state} ${styles.stateSaving}`}>saving…</span>}
        {state?.state === 'saved' && <span className={`${styles.state} ${styles.stateSaved}`}>saved</span>}
        {state?.state === 'refused' && (
          <span className={`${styles.state} ${styles.stateRefused}`}>{state.message ?? 'refused'}</span>
        )}
        {/* 🔴 The ƒ entry point is not a convenience — on three of the six column kinds it is the
            ONLY way in. `=` can be typed into a text field, but a `number` input drops the
            character before React sees it (the browser rejects it as non-numeric), and a select and
            a toggle have nowhere to type at all. #775(1) attaches the `=` editor to EVERY kind; in
            a form that takes a control, not a keystroke. */}
        {formulaSeam && editable && !formulaWritesRefused && availability.kind === 'available' && !showFormula && (
          <ToolbarButton
            icon={<FormulaGlyph />}
            label={storedExpr != null ? 'Edit the formula' : 'Write a formula'}
            onClick={() => setFormulaMode(true)}
          />
        )}
        {formulaSeam && editable && !formulaWritesRefused && storedExpr != null && (
          <ToolbarButton
            icon={<Pin size={13} />}
            label="Keep this value and remove the formula"
            onClick={() => void removeFormula()}
          />
        )}
        <ToolbarButton icon={<History size={13} />} label="Field history" onClick={() => onHistory(column)} />
        {/* A cell whose write lands on master has no per-scope override to reset — offering the
            control would promise an operation the contract says cannot happen. */}
        {!inherited && editable && writeTarget !== 'master' && (
          <ToolbarButton
            icon={<RotateCcw size={13} />}
            label="Reset to the inherited value"
            onClick={() => onReset(column)}
          />
        )}
      </span>
    </div>
  )

  // ── Inherited, not yet touched: the ghost ───────────────────────────────
  const ghost = (
    /* 🔴 NAME vs DESCRIPTION. The accessible name is the VALUE the operator can see — "Xavia" —
       and the explanation rides as a description via `aria-describedby`. It used to be an
       `aria-label`, which replaced the name with a sentence nobody can see: a screen reader read
       "Brand: inherited value. Activate to pin an override." where the screen said "Xavia", so the
       two never agreed. Folding the sentence into the label instead would put prose on screen where
       a value belongs. */
    <PressableRow
      className={`${styles.ghost}${effective === '' ? ` ${styles.ghostEmpty}` : ''}`}
      onClick={() => editable && setEditing(true)}
      disabled={!editable}
      description={
        editable
          ? 'Inherited value. Activate to pin an override.'
          : (disabledReason ?? 'Inherited value. This field cannot be edited here.')
      }
      label={<span><span className="nds-vh">{column.label}: </span>{effective === '' ? 'no value set anywhere' : effective}</span>}
      /* `children`, NOT `actions`. The pencil is decorative (`aria-hidden`) and must sit UNDER the
         overlay so a click on it still activates the row — `actions` renders above the overlay
         precisely so its clicks do NOT reach the row, which is right for a real control and wrong
         for an icon that is part of the affordance. */
      children={editable ? <Pencil size={12} className={styles.ghostPencil} aria-hidden /> : undefined}
    />
  )

  // ── The control ─────────────────────────────────────────────────────────
  let control: React.ReactNode
  if (showFormula && formulaSeam && rowId) {
    /* 🔴 FIRST in the chain, ahead of the ghost and ahead of every per-kind control. A cell holding
       a formula has an own value — the result the server wrote — so it is never `inherited`, and
       the kind-specific editors would offer to overwrite the RULE with a value typed over its
       output. The formula is what this cell is; it is not one of the ways to edit it. */
    control = (
      <FormulaField
        column={column}
        rowId={rowId}
        formulas={formulaSeam}
        storedExpr={storedExpr}
        candidates={candidates ?? []}
        originalText={effective}
        disabled={!editable || formulaWritesRefused}
        ariaLabel={column.label}
        onExit={(next) => {
          setFormulaMode(false)
          setDraft(next)
        }}
        onSaved={() => {
          setFormulaMode(false)
          onFormulaSaved?.()
        }}
      />
    )
  } else if (inherited && !editing) {
    control = ghost
  } else if (column.key === 'impactProtectors') {
    control = <ImpactProtectorsInput value={cell?.value} disabled={!editable} onChange={scheduleCommit} />
  } else if (column.shape === 'list' || column.shape === 'measure') {
    control = <AttributeShapeInput column={column} value={cell?.value} disabled={!editable} onChange={scheduleCommit} />
  } else if (column.kind === 'longtext') {
    control = (
      <HtmlField
        value={draft}
        disabled={!editable}
        ariaLabel={column.label}
        /* Never passed before, so every rich-text field showed no cap at all (#382). */
        maxLength={column.maxLength}
        maxBytes={column.maxBytes}
        capFrom={column.capFrom}
        placeholder={inherited ? effective : undefined}
        onCommit={(next) => {
          setDraft(next)
          commit(next)
        }}
      />
    )
  } else if (scopeKind === 'channel' && ['categoryId', 'productType'].includes(column.key) && Object.keys(column.channels ?? {}).some(label => /^(eBay|Amazon) ·/.test(label))) {
    const label = Object.keys(column.channels ?? {}).find(label => /^(eBay|Amazon) ·/.test(label))!
    control = <ProductTypePicker channel={label.startsWith('eBay') ? 'EBAY' : 'AMAZON'} marketplace={label.split('·')[1].trim()} value={draft} disabled={!editable} onChange={next => { setDraft(next); commit(next) }} />
  } else if (scopeKind === 'channel' && isEbayPolicyField(column.key) && Object.keys(column.channels ?? {}).some(label => label.startsWith('eBay'))) {
    const market = Object.keys(column.channels ?? {}).find(label => label.startsWith('eBay'))!.split('·')[1].trim()
    control = <EbayPolicyInput fieldKey={column.key} market={market} value={cell?.value} disabled={!editable} onChange={next => commit(next)} />
  } else if (column.kind === 'boolean') {
    control = (
      <Toggle
        checked={draft === 'true' || draft === '1'}
        disabled={!editable}
        title={disabledReason}
        aria-label={column.label}
        onChange={(next) => {
          setDraft(String(next))
          commit(next)
        }}
      />
    )
  } else if (column.kind === 'select') {
    control = (
      <Select
        size="sm"
        value={draft}
        disabled={!editable}
        title={disabledReason}
        aria-label={column.label}
        onChange={(e) => {
          setDraft(e.target.value)
          commit(e.target.value)
        }}
      >
        <option value="">—</option>
        {/* An `open` list is a suggestion, not a rule: a value the schema has not seen must still
            be shown, or the field silently reads as empty when it is not. */}
        {draft !== '' && !column.options?.includes(draft) && (
          <option value={draft}>{draft} (not in this channel’s list)</option>
        )}
        {column.options?.map((o) => (
          <option key={o} value={o}>
            {column.optionLabels?.[o] ?? o}
          </option>
        ))}
      </Select>
    )
  } else {
    control = (
      <Input
        size="sm"
        type={column.kind === 'number' ? 'number' : column.kind === 'date' ? 'date' : 'text'}
        value={draft}
        disabled={!editable}
        title={disabledReason}
        autoFocus={editing}
        aria-label={column.label}
        aria-invalid={over || issue?.severity === 'error' || undefined}
        onChange={(e) => {
          const next = e.target.value
          setDraft(next)
          /* 🔴 `=` switches mode and must NOT also schedule a write. The idle autosave would
             otherwise store the literal characters — `=`, then `=u`, then `=up` — as this cell's
             VALUE while the operator is still typing the rule, which is precisely the confusion
             between a formula and its text that the separate formula write path exists to prevent.
             A pending commit from an earlier keystroke is cancelled for the same reason. */
          if (formulaSeam && !formulaWritesRefused && availability.kind === 'available' && isFormulaDraft(next)) {
            window.clearTimeout(timer.current)
            setFormulaMode(true)
            return
          }
          scheduleCommit(next)
        }}
        onBlur={() => {
          setEditing(false)
          commit(draft)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            commit(draft)
          } else if (e.key === 'Escape') {
            e.preventDefault()
            // The dock's Esc-to-close is listening on document. Abandoning an edit must not also
            // shut the record the operator is reading.
            e.stopPropagation()
            setDraft(effective)
            setEditing(false)
          }
        }}
      />
    )
  }

  const required = column.requiredBy.length > 0

  return (
    <div
      className={`${styles.field}${focused ? ` ${styles.fieldFocused}` : ''}`}
      data-field={column.key}
    >
      {head}
      <Field label={column.label} required={required} hint={column.helpText}>
        {control}
      </Field>

      {capReading.cap != null && column.kind !== 'longtext' && (
        <div className={styles.capRow}>
          {/* 🔴 Exactly ONE surface names the source at a time, and which one depends on state
              (DS1-25 / DS.1's ruling). Not over: there is no message, so this span carries it.
              Over: `overCapNote` carries it and this span stands down. The condition is written as
              "only when nothing else is saying it" rather than "not while over", because the span
              is the source-carrier of LAST RESORT, not a label — read as an exception, the next
              person deletes the `!over` as dead tidying. The drawer is the only surface with a left
              span (DS.1 checked the mark and the validator), so this is the only place the source
              could appear twice, and only in the over state. */}
          <span>{!over && capReading.capFrom ? `cap from ${capReading.capFrom}` : ''}</span>
          <span className={over ? styles.capOver : undefined}>
            {/* The UNIT is printed. "18000 / 20000" reads as characters to everyone, and on a
                byte-capped column that is a different number from the one being enforced. */}
            {capReading.length} / {capReading.cap} {capReading.unit}
            {over ? overCapNote(capReading.capFrom) : ''}
          </span>
        </div>
      )}

      {/* 🔴 The blast radius, stated before the edit rather than confirmed after it.
          On a channel scope only six field names actually route to the ChannelListing; every
          other cell writes to the shared master record, so editing "the eBay value" here changes
          Amazon, Shopify and every other channel too. Measured on eBay·IT: 399 of 441 cells. */}
      {crossChannel && (
        <div className={`${styles.issue} ${styles.issueWarn}`}>
          Writes to the master record — this changes every channel, not just this one.
        </div>
      )}

      {/* A linked value is the one edit whose blast radius is invisible from the field itself:
          it moves every coordinate in the group, not just this one. Said before the edit, not
          confirmed after it. */}
      {layer === 'linked' && cell?.linkGroupId && (
        <div className={`${styles.issue} ${styles.issueWarn}`}>
          Linked — editing this moves every coordinate in the group, not only this one.
        </div>
      )}

      {/* Typed `=` on a column whose formula writer would refuse it. ONE wording — the engine's
          exported sentence — so the cell editor, the tooltip and this field cannot describe the
          same refusal three different ways. */}
      {blockedFormula && (
        <div className={`${styles.issue} ${styles.issueWarn}`}>{FORMULA_BLOCKED_REASON}</div>
      )}

      {formulaError && <div className={`${styles.issue} ${styles.issueError}`}>{formulaError}</div>}

      {/* Validation WARNS, never blocks — the layout spec's rule. The operator is told what the
          channel will do with this and left free to save it anyway. */}
      {issue && (
        <div className={`${styles.issue} ${issue.severity === 'error' ? styles.issueError : styles.issueWarn}`}>
          {issue.severity === 'error' ? 'Will be refused: ' : 'May be rejected: '}
          {issue.message}
        </div>
      )}
    </div>
  )
}

/**
 * Memoised, and only useful because the callbacks above take the column.
 *
 * A record has ~100 fields; without this every keystroke anywhere in the drawer re-rendered all of
 * them, and each one carries two `ToolbarButton`s and a `Tooltip`. The comparison is the default
 * shallow one — every prop here is either a primitive or an object the sheet already holds stable.
 */
export const RecordField = memo(RecordFieldImpl)

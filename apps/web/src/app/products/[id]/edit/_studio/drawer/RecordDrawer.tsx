'use client'

/**
 * PES.4.2 — the full-record drawer: Airtable's expanded record, adopted.
 *
 * It opens on a row of the sheet and does NOT leave it. That is the whole design, and it is why
 * this is a DOCKED drawer rather than the DS's modal one: the sheet beside it keeps its selection,
 * its keyboard, and its edits. `⌘↑` / `⌘↓` walk to the next record with the panel open, so a
 * reviewer can read fifty records without a single close-and-reopen.
 *
 * Four panes, one record:
 *   Record    every attribute as a DS form, grouped as the sheet groups its columns, each field
 *             carrying its provenance and its two verbs (pin / reset)
 *   History   who changed this field, when, from what, on which layer — honestly, including the
 *             parts the write path does not record
 *   Compare   the same field against master / another locale / another alias, with copy-across
 *   Listings  per-channel state, errors and references
 *
 * ONE WRITE PATH. Every edit — a field, a reset, a copy-across — leaves through `onWrite`, which
 * is the sheet's own mutator. The drawer owns no fetch that writes. A value changed here repaints
 * its cell in the grid behind, shares the `expectedVersion` / 409 handling, and lands in the same
 * audit row it would have from the sheet. Two write paths would be two provenance stories, and the
 * provenance is what this drawer is FOR.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { GridAction } from '@/design-system/grid/actions/registry'
import { Drawer } from '@/design-system/components/Drawer'
import { Tabs } from '@/design-system/components/Tabs'
import { Pill } from '@/design-system/primitives/Pill'
import { Spinner } from '@/design-system/primitives/Spinner'
import { useDrawerConfirm } from './DrawerConfirm'
import { RecordActions } from './RecordActions'
import { RecordPane } from './panes/RecordPane'
import { HistoryPane } from './panes/HistoryPane'
import { ComparePane } from './panes/ComparePane'
import { ListingsPane } from './panes/ListingsPane'
import { useFieldHistory } from './useFieldHistory'
import { useCompare } from './useCompare'
import { useRecordState } from './useRecordState'
import { useRestorePoints } from './useRestorePoints'
import { useRecordImages } from '../images/record'
import { getBackendUrl } from '@/lib/backend-url'
import { MAX_WIDTH, MIN_WIDTH } from './useRecordDrawer'
import {
  isInherited,
  type CompareCell,
  type CompareRow,
  type CompareTarget,
  type DrawerFormulas,
  type DrawerScope,
  type RecordWriteRequest,
  type RecordWriteResult,
  type SheetColumn,
  type SheetRow,
} from './types'
import styles from './drawer.module.css'

type TabId = 'record' | 'history' | 'compare' | 'listings'

/**
 * Generic in the ROW, and it has to be.
 *
 * `GridAction<T>` is contravariant in `T` — `available` and `run` TAKE `T[]` — so
 * `GridAction<ChannelSheetRow>` does not assign to `GridAction<SheetRow>`: a verb that reads
 * `aliasPosition` cannot be handed rows that have none. PES.3's channel verbs are declared against
 * `ChannelSheetRow extends StudioRow`, so pinning this to `SheetRow` would have made their wiring
 * fail to compile with an error about function parameters rather than about the actual mismatch.
 *
 * The constraint keeps every pane honest: whatever row a host brings is still at least a
 * `SheetRow`, so `values`, `readiness`, `listing` and `completeness` are all still there.
 */
export interface RecordDrawerProps<R extends SheetRow = SheetRow> {
  /** Null while the host is still resolving `?rec=` to a row. */
  row: R | null
  columns: SheetColumn[]
  scope: DrawerScope
  /** The column the operator expanded from. Scrolled to and ringed — never focused. */
  focusKey?: string | null
  /** Coordinates the compare pane may read. The host knows them; the drawer does not guess. */
  compareTargets: CompareTarget[]
  loading?: boolean
  /**
   * Why the row is absent, when it is absent because something FAILED.
   *
   * Without this the drawer had three states collapsed into two, and the collapsed pair lied. A
   * sheet read that 404s leaves `loading:false, row:null`, which rendered as "that record is not
   * on the current page of the sheet — clear the filter and expand it again": an instruction to
   * fix a filter that is not the problem, for a read that is never going to succeed. Measured
   * 2026-09-01 against the live studio while PES.5's `/studio/sheet` was still returning empty.
   *
   * The History and Compare panes already separate not-shipped from empty from failed; the Record
   * pane was the one surface in this drawer that did not.
   */
  error?: string | null
  /**
   * `number` (px) when the drawer sizes itself; `'100%'` when it is inside PES.1's reserved
   * track, which carries the pixel width instead — see `StudioDock`. One number drives both, so
   * they cannot disagree mid-drag.
   */
  width: number | string
  onWidthChange: (px: number) => void
  /** Passed through to the DS panel — the dock integration uses it to drop a duplicated border. */
  className?: string
  onClose: () => void
  /** Walks to the previous/next record in the sheet's current order, panel staying open. */
  onStep?: (direction: -1 | 1) => void
  onWrite: (req: RecordWriteRequest) => Promise<RecordWriteResult>
  /**
   * Told after a record restore, so the host can refetch the sheet it owns — and, when the server
   * returned one, the product version the restore produced. Feed it to `SheetWriter.seed()`: that
   * is monotonic, so a stale number can never move the guard backwards.
   */
  onRestoredExternally?: (currentVersion?: number) => void
  /**
   * The lane's own verb declarations, rendered through the registry's rules. The drawer declares
   * NONE of its own — a verb born in a drawer is the drift ruling #110 exists to prevent.
   */
  rowActions?: readonly GridAction<R>[]
  /**
   * D16 cell formulas (#708/#775), supplied by the HOST — the sheet that mounts this drawer already
   * holds `useCellFormulas` for these very rows. See `DrawerFormulas` for why it is injected rather
   * than built here (the coordinate needs a `market` this component cannot see, and a second hook
   * would be a second answer to "what formula is on this cell").
   *
   * Absent is a drawer with no formula affordances, not a broken one: `=` stays ordinary text.
   */
  formulas?: DrawerFormulas
  /**
   * A formula was stored or removed. The host refetches, because the VALUE a formula produces is
   * written by the server — this drawer never computes it and must not pretend to know it.
   */
  onFormulaSaved?: () => void
  /**
   * 🔴 Why this scope refuses writes WHOLESALE — set by a host whose drawer is read-only.
   *
   * It exists because `onWrite` cannot answer that question in advance. A host that refuses every
   * write does so by RETURNING a refusal, so the only way to discover it is to call it — and
   * calling it is the write. PES.3's channel scope is exactly this: its `StudioDock` passes an
   * `onWrite` that always returns `{ state: 'refused' }` because channel writes belong to the
   * sheet's own cascade and writer, and a second path would be two ways to change one cell.
   *
   * 🔴 A FORMULA IS A WRITE. The server evaluates it and writes the result into the value layer
   * (§1.6(A)), and `FormulaField` reaches that endpoint through `DrawerFormulas.save` — deliberately
   * NOT through `onWrite`, so a host's refusal is structurally unable to stop it. Without this
   * signal the drawer would offer a live formula write three lines below a message saying it cannot
   * write here: not a half-state but a contradiction, with both halves behaving as designed.
   *
   * ONE signal, deliberately, rather than a `formulasReadOnly` of its own: a scope must not be able
   * to become read-only for values and writable for formulas by accident.
   *
   * A stored formula still DISPLAYS under this flag, read-only. Hiding it would leave the operator
   * looking at a computed value whose rule they can neither read nor account for — the same hazard
   * `formulaAvailability`'s "a stored formula is always available" arm exists to prevent.
   */
  writesRefused?: string
}

export function RecordDrawer<R extends SheetRow = SheetRow>({
  row,
  columns,
  scope,
  focusKey,
  compareTargets,
  loading,
  error,
  width,
  onWidthChange,
  className,
  onClose,
  onStep,
  onWrite,
  onRestoredExternally,
  rowActions,
  formulas,
  onFormulaSaved,
  writesRefused,
}: RecordDrawerProps<R>) {
  const [tab, setTab] = useState<TabId>('record')
  const [inspecting, setInspecting] = useState<SheetColumn | null>(null)
  const [writeStates, setWriteStates] = useState<Record<string, RecordWriteResult>>({})
  const confirm = useDrawerConfirm()

  // PES.5 §3.2 sends `scope.label` ("eBay · IT"). Preferred over anything assembled here, so the
  // drawer's chip and the sheet's scope bar cannot end up spelling the same coordinate differently.
  const scopeLabel =
    scope.label ??
    (scope.kind === 'master'
      ? 'Master'
      : [scope.channel, scope.marketplace, scope.aliasLabel].filter(Boolean).join(' · '))

  // History is asked for by the COLUMN key (PES.5 §3.5 `fieldKey`), scoped to this row — a family
  // read covers parent and variations, and a variation's title has its own trail.
  const history = useFieldHistory(row?.id ?? null, inspecting ? row?.values[inspecting.key]?.writeField ?? inspecting.key : null, scope, row?.id ?? null)
  const recordState = useRecordState(scope.kind === 'master' ? row?.id ?? null : null)
  // The moments that hold changes (#366). Read only while the History tab is open — this is a
  // second audit scan and nobody needs it on a drawer opened to edit a field.
  const restorePoints = useRestorePoints(scope.kind === 'master' ? row?.id ?? null : null, tab === 'history' && scope.kind === 'master')

  /**
   * The SECOND restore verb (#488). Deliberately separate from `restoreRecord`, not a branch inside
   * it: they take different inputs, write different things, and have different blast radii. One
   * function switching on a discriminator would be one place to get the switch wrong.
   *
   * `POST /api/pim/formulas/restore` re-creates the `CellFormula` from the pinned audit row and
   * re-evaluates; it returns the same shape a set does.
   */
  const restoreFormula = useCallback(
    async (auditLogId: string): Promise<{ ok: boolean; message?: string }> => {
      try {
        const res = await fetch(`${getBackendUrl()}/api/pim/formulas/restore`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          cache: 'no-store',
          body: JSON.stringify({ auditLogId }),
        })
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null
          return { ok: false, message: body?.error ?? `HTTP ${res.status}` }
        }
        return { ok: true }
      } catch (e) {
        return { ok: false, message: e instanceof Error ? e.message : String(e) }
      }
    },
    [],
  )

  /**
   * PES.7's read, not a second one of my own. The fetch lives in their hook and `GalleryStrip`
   * stays a leaf that renders what it is handed — so an image the Images tab shows and an image the
   * drawer shows cannot come from two different answers.
   */
  const images = useRecordImages({
    productId: row?.id ?? null,
    parentId: row?.parentId ?? null,
    parentLabel: row?.parentId ? 'the parent product' : null,
  })

  /**
   * The ONE write this drawer issues itself, and the exception is principled rather than
   * convenient: every CELL edit goes through the host's sheet mutator so the grid repaints and the
   * version guard is shared. A record restore is not a cell edit — it has its own endpoint, its own
   * audit `source`, and no sheet equivalent to share. Routing it through the cell writer would mean
   * inventing a fake cell change per field.
   */
  const restoreRecord = useCallback(
    async (at: string, fields: Record<string, unknown>): Promise<{ ok: boolean; message?: string; currentVersion?: number }> => {
      if (!row || scope.kind !== 'master') return { ok: false, message: 'Restore shared facts from Shared scope.' }
      try {
        const res = await fetch(`${getBackendUrl()}/api/products/${row.id}/restore`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ at, fields, expectedVersion: row.version }),
        })
        if (res.status === 409) {
          // Same contract as a cell write: someone else moved the record under us.
          return { ok: false, message: 'The record changed since you loaded this view — reload and try again.' }
        }
        const body = (await res.json().catch(() => null)) as
          | { error?: string; currentVersion?: number | null; versionOf?: string }
          | null
        if (!res.ok) return { ok: false, message: body?.error ?? `HTTP ${res.status}` }
        /**
         * Hand the sheet the version the restore just produced (PES.5, #224).
         *
         * A restore now bumps `Product.version`, so without this the sheet is left holding the
         * PRE-restore number: correct behaviour then gives the operator a 409 on their next cell
         * edit — the guard doing its job, but as a bounce they did not cause and cannot explain.
         * Seeding closes that window immediately rather than waiting for the refetch to land.
         *
         * `versionOf` is checked, not assumed. The same field name means a `channelListing`
         * version on other write paths, and applying one row's version to another is the exact
         * mistake that field exists to prevent.
         */
        const nextVersion =
          body?.versionOf === 'product' && typeof body.currentVersion === 'number'
            ? body.currentVersion
            : undefined
        return { ok: true, currentVersion: nextVersion }
      } catch (e) {
        return { ok: false, message: e instanceof Error ? e.message : String(e) }
      }
    },
    [row, scope.kind],
  )
  const compare = useCompare(
    row?.id ?? null,
    inspecting ? [inspecting.key] : [],
    compareTargets,
    row?.id ?? null,
    tab === 'compare' && inspecting != null,
    scope.marketplace,
  )

  // A new record means a new field context. Keeping the previous field selected would show one
  // record's title history under another record's name.
  useEffect(() => {
    setInspecting(null)
    setWriteStates({})
  }, [row?.id])

  /**
   * ⌘↑ / ⌘↓ step records. Plain arrows are left to the grid — it is live behind this panel and
   * still the thing being navigated. Nothing fires while a confirmation is up, or while the caret
   * is in a text field where ⌘↑ means "go to the start".
   */
  useEffect(() => {
    if (!onStep) return
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
      if (confirm.isOpen) return
      e.preventDefault()
      onStep(e.key === 'ArrowUp' ? -1 : 1)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onStep, confirm.isOpen])

  const mark = useCallback((key: string, result: RecordWriteResult) => {
    setWriteStates((s) => ({ ...s, [key]: result }))
    if (result.state === 'saved') {
      // The tick is an acknowledgement, not a permanent label — a form covered in "saved" badges
      // stops meaning anything after the third edit.
      window.setTimeout(() => {
        setWriteStates((s) => (s[key]?.state === 'saved' ? { ...s, [key]: { state: 'idle' } } : s))
      }, 1800)
    }
  }, [])

  const write = useCallback(
    async (column: SheetColumn, value: unknown, intent: 'set' | 'pin' | 'reset', targetScope = scope) => {
      if (!row) return
      mark(column.key, { state: 'saving' })
      // The CELL's `writeField`/`writeTarget` win when the studio read supplied them: PES.5 §3.2
      // puts them there so no client re-derives where a cell writes, and on a channel scope the
      // answer genuinely differs from the column's family-wide default.
      const cell = row.values[column.key]
      const result = await onWrite({
        rowId: row.id,
        writeField: cell?.writeField ?? column.writeField,
        writeTarget: cell?.writeTarget,
        value,
        scope: targetScope,
        intent,
      })
      mark(column.key, result)
    },
    [row, onWrite, scope, mark],
  )

  const handleReset = useCallback(
    async (column: SheetColumn) => {
      const cell = row?.values[column.key]
      const ok = await confirm.confirm({
        title: `Reset ${column.slot?.label ?? column.label} to the inherited value?`,
        body: (
          <>
            <p>
              {column.slot ? `All positions in ${column.slot.label} return to inheritance together. ` : ''}This scope’s own value for <strong>{column.slot?.label ?? column.label}</strong> is removed, and the field goes back to
              tracking {cell?.inheritedFrom ? `“${cell.inheritedFrom}”` : 'the layer above it'}.
            </p>
            <p>
              The current value is not kept anywhere the drawer can offer back — the field history records the
              change, but only as far as the write path records it.
            </p>
          </>
        ),
        confirmLabel: 'Reset to inherited',
        tone: 'warning',
      })
      if (ok) await write(column, null, 'reset')
    },
    [confirm, row, write],
  )

  /**
   * Copy-across. Overwriting a value someone PINNED asks first; overwriting an inherited value
   * does not, because nothing is being destroyed — it was already tracking somewhere else.
   */
  const handleCopy = useCallback(
    async (compareRow: CompareRow, from: CompareCell, to: CompareCell) => {
      const column = columns.find((c) => c.key === compareRow.key)
      if (!column) return
      const target = compareTargets.find((t) => t.id === to.targetId)
      if (!target) return

      if (!isInherited(to.layer)) {
        const ok = await confirm.confirm({
          title: `Overwrite ${compareRow.label} on ${target.label}?`,
          body: (
            <>
              <p>
                {target.label} has its own value for <strong>{compareRow.label}</strong>. Copying replaces it.
              </p>
              <p>
                <strong>Currently there:</strong> {String(to.value ?? '(empty)')}
              </p>
              <p>
                <strong>Would become:</strong> {String(from.value ?? '(empty)')}
              </p>
            </>
          ),
          confirmLabel: 'Overwrite it',
          tone: 'danger',
          acknowledge: 'I have read both values above',
        })
        if (!ok) return
      }

      await write(column, from.value, 'pin', target.scope)
      compare.reload()
    },
    [columns, compareTargets, confirm, write, compare],
  )

  /**
   * Stable adapters, so `RecordField`'s `memo` can actually bite. Wrapping a `useCallback` in a
   * fresh arrow at the call site throws away the stability it was created for — which is what
   * these four used to do.
   */
  const writeField = useCallback(
    (column: SheetColumn, value: unknown, intent: 'set' | 'pin') => void write(column, value, intent),
    [write],
  )
  const resetField = useCallback((column: SheetColumn) => void handleReset(column), [handleReset])

  const inspect = useCallback((column: SheetColumn, to: TabId) => {
    setInspecting(column)
    setTab(to)
  }, [])

  const inspectHistory = useCallback((column: SheetColumn) => inspect(column, 'history'), [inspect])
  /**
   * §14.3 — the History and Compare tabs choose their own subject.
   *
   * Both panes populate from a field, and both used to get it only from an icon on ANOTHER tab.
   * Opening either directly showed a surface that named a verb it could not perform. This is the
   * control that chooses; it does not switch tabs, because the operator is already on the one
   * whose result they want.
   */
  /**
   * Which target IS the record on screen — matched by COORDINATE, not by kind (#342.2).
   *
   * 🔴 This was `compareTargets.find((t) => t.kind === scope.kind)`, which was harmless only while
   * a channel scope had no channel targets. The moment PES.3 wired the real list — Master plus
   * nine Amazon markets — it matched the FIRST `channel` entry: on Amazon·IT it marked **Amazon·BE**
   * as "this record", so the column an operator copies FROM was a different marketplace's.
   *
   * No `?? compareTargets[0]` fallback either. Marking an arbitrary target as "this record" is the
   * same failure one step quieter; if nothing matches, nothing is marked.
   */
  const sourceTargetId = useMemo(
    () =>
      compareTargets.find(
        (t) =>
          t.scope.kind === scope.kind &&
          (t.scope.channel ?? null) === (scope.channel ?? null) &&
          (t.scope.marketplace ?? null) === (scope.marketplace ?? null) &&
          (t.scope.aliasId ?? '') === (scope.aliasId ?? '') &&
          (t.scope.accountId ?? null) === (scope.accountId ?? null),
      )?.id ?? '',
    [compareTargets, scope.kind, scope.channel, scope.marketplace, scope.aliasId, scope.accountId],
  )

  const pickField = useCallback(
    (key: string | null) => setInspecting(key ? (columns.find((c) => c.key === key) ?? null) : null),
    [columns],
  )

  const tabs = useMemo(
    () => [
      { id: 'record', label: 'Record' },
      { id: 'history', label: 'History' },
      { id: 'compare', label: 'Compare' },
      {
        id: 'listings',
        label: 'Listings',
        // One scope, one listing — a count belongs on a pane that shows several.
        count: undefined,
      },
    ],
    [row],
  )

  /**
   * Straight from the read, not recounted here. This used to filter `columns` by `requiredBy` and
   * re-derive "filled" from the row's values — a second implementation of a number the API already
   * computes (`master-completeness.service.ts`), which is how a footer and a scope chip end up
   * disagreeing about the same product. The server's counts also know about required-ness this
   * scope's column set cannot see.
   */
  const completeness = row?.completeness

  return (
    <Drawer
      open
      mode="dock"
      resizable
      width={width}
      minWidth={MIN_WIDTH}
      maxWidth={MAX_WIDTH}
      onWidthChange={onWidthChange}
      className={className}
      onClose={onClose}
      overlay={confirm.overlay}
      title={
        <span className={styles.identity}>
          {row?.name ?? (loading ? 'Loading…' : 'No record')}
        </span>
      }
      subtitle={
        row ? (
          <span className={styles.headMeta}>
            <span className={styles.sku}>{row.sku}</span>
            <Pill tone={row.status === 'ACTIVE' ? 'success' : 'neutral'}>{row.status}</Pill>
            <Pill tone="neutral">{scopeLabel}</Pill>
            {row.isParent && <Pill tone="neutral">{row.childCount} variations</Pill>}
          </span>
        ) : undefined
      }
      footer={
        row ? (
          <span className={styles.hMeta}>
            {/* Absent completeness says so. A footer that prints "undefined% complete" — which is
                exactly what the wrong mirror produced — is worse than one that prints nothing. */}
            {completeness
              ? `${completeness.required.filled} of ${completeness.required.total} required fields filled · ${completeness.overall.pct}% complete`
              : 'completeness not reported for this row'}{' '}
            · autosaves per field
          </span>
        ) : undefined
      }
    >
      <div className={styles.body}>
        <div className={styles.tabsRow}>
          {/* The same DS `sm` strip as the studio's scope row — one tab strip, two hosts (CT.1). */}
          <Tabs ariaLabel="Record panes" size="sm" tabs={tabs} active={tab} onChange={(id) => setTab(id as TabId)} />
        </div>

        <div className={styles.pane}>
          {loading && !row && (
            <div className={`${styles.note} ${styles.noteInfo}`}>
              <Spinner size={14} />
              <span>Opening the record…</span>
            </div>
          )}

          {/* Failure first: if the read broke, nothing else about the absence is worth guessing at. */}
          {!loading && !row && error && (
            <div className={`${styles.note} ${styles.noteError}`}>
              <span>
                The sheet could not be read, so there is no record to show: {error}. This is not “the row is
                missing” — nothing was loaded to look in.
              </span>
            </div>
          )}

          {!loading && !row && !error && (
            <div className={`${styles.note} ${styles.noteWarn}`}>
              <span>
                That record is not on the current page of the sheet. Clear the filter or search for it, then expand it
                again.
              </span>
            </div>
          )}

          {row && tab === 'record' && (
            <RecordPane
              row={row}
              columns={columns}
              scope={scope}
              focusKey={focusKey ?? undefined}
              images={images.state.status === 'ready' ? images.state.data.images : undefined}
              imagesInheritedFrom={images.state.status === 'ready' ? images.state.data.inheritedFrom : null}
              // Their hook's own note, and it is right: an error rendered as an empty strip would
              // read as "this record has no images", which is a different and much more alarming
              // claim than "the images could not be read".
              imagesError={images.state.status === 'error' ? images.state.message : null}
              writeStates={writeStates}
              onWrite={writeField}
              onReset={resetField}
              onHistory={inspectHistory}
              formulas={formulas}
              onFormulaSaved={onFormulaSaved}
              writesRefused={writesRefused}
            />
          )}

          {row && tab === 'history' && (
            <HistoryPane
              fieldLabel={inspecting?.label ?? null}
              columns={columns}
              fieldKey={inspecting?.key ?? null}
              onPickField={pickField}
              history={history}
              restore={scope.kind !== 'master' ? undefined : {
                productId: row.id,
                recordState,
                restorePoints,
                onRestoreFormula: restoreFormula,
                confirm,
                onRestore: restoreRecord,
                onRestored: (currentVersion?: number) => {
                  // The restore wrote master fields; every pane reading this row is now stale.
                  history.reload()
                  onRestoredExternally?.(currentVersion)
                },
              }}
            />
          )}

          {row && tab === 'compare' && (
            <ComparePane
              sourceTargetId={sourceTargetId}
              compare={compare}
              onCopy={(r, from, to) => void handleCopy(r, from, to)}
              columns={columns}
              fieldKey={inspecting?.key ?? null}
              onPickField={pickField}
            />
          )}

          {row && tab === 'listings' && (
            <ListingsPane
              row={row}
              scope={scope}
              actions={
                rowActions && rowActions.length > 0 ? (
                  // No `confirm` prop: the registry's own confirmation is the one that asks, so
                  // the dangerous verb and the gentle one cannot drift apart (#124).
                  <RecordActions actions={rowActions} row={row} onDone={() => onRestoredExternally?.()} />
                ) : undefined
              }
            />
          )}
        </div>
      </div>
    </Drawer>
  )
}

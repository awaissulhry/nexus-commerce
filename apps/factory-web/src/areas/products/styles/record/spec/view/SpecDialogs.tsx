'use client'

import { useState } from 'react'
import { Banner, Field } from '@nexus/ui/components'
import { SizeFill } from '@nexus/ui/grid/size-columns/index'
import { Button, Checkbox, Input, Radio, Select, Spinner } from '@nexus/ui/primitives'
import { Modal, ReviewChangesPanel, Textarea, useDsWords } from '../../../../../../lib/i18n/ds-parts'
import { INTL_LOCALE } from '../../../../../../lib/i18n/locales'
import { useLocale, useT } from '../../../../../../lib/i18n/provider'
import { numberText } from '../../../../sizes/depth/model'
import type { MeasurementSpecView } from '../api'
import { addPlan, fillCells, gradeHeld, gradeLines, missingCount, pasteCells, toleranceCells, toleranceOf, typedTolerance, type AddLine, type SpecActions, type SpecModel, type SpecRow } from '../spec-model'

/**
 * The Measurement spec's pop-ups (B-W2b-240): Start the spec (its base size, a grade rule of the scale, or a copy of an
 * earlier spec of this revision), Add points (garment points of the library, each with its base size value), Apply grade
 * rule (design pop:styles.grade: the rule, "keep values typed by hand" (default) or overwrite them, the preview of the
 * changed cells on the DS ReviewChangesPanel, Apply), Paste from a sheet, Fill from the base by an increment (DS SizeFill),
 * a row's tolerance, Remove N, the base size and rule, Approve, Reopen and Archive (with the reason). Each sends one
 * write; what the API refuses is said in our words with its own sentences under them.
 */
export function SpecDialogs({ view, rows, model, held, actions }: { view: MeasurementSpecView; rows: readonly SpecRow[]; model: SpecModel; held: string | null; actions?: SpecActions }) {
  const dialog = model.dialog
  if (!dialog) return null
  const close = () => actions?.onDialog?.(null)
  switch (dialog.kind) {
    case 'start':
      return <StartDialog view={view} model={model} held={held} actions={actions} onClose={close} />
    case 'settings':
      return <SettingsDialog view={view} model={model} held={held} actions={actions} onClose={close} />
    case 'add':
      return <AddDialog view={view} model={model} held={held} actions={actions} onClose={close} />
    case 'grade':
      return <GradeDialog view={view} model={model} held={held} actions={actions} onClose={close} />
    case 'paste':
      return <PasteDialog view={view} model={model} held={held} actions={actions} onClose={close} />
    case 'fill': {
      const row = rows.find((entry) => entry.id === dialog.pointId)
      return row ? <FillDialog view={view} row={row} model={model} held={held} actions={actions} onClose={close} /> : null
    }
    case 'tolerance': {
      const row = rows.find((entry) => entry.id === dialog.pointId)
      return row ? <ToleranceDialog view={view} row={row} model={model} held={held} actions={actions} onClose={close} /> : null
    }
    case 'remove':
      return <RemoveDialog rows={rows.filter((row) => dialog.ids.includes(row.id))} model={model} held={held} actions={actions} onClose={close} />
    default:
      return <MoveDialog move={dialog.kind} view={view} model={model} actions={actions} onClose={close} />
  }
}

interface DialogProps {
  view: MeasurementSpecView
  model: SpecModel
  held: string | null
  actions?: SpecActions
  onClose: () => void
}

function Refused({ model }: { model: SpecModel }) {
  const t = useT('products-sizes-depth')
  if (!model.refused) return null
  return (
    <Banner tone="danger" title={t(model.refused.key)}>
      {model.refused.messages.length > 0 && (
        <ul className="fw-spc-list">
          {model.refused.messages.slice(0, 6).map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      )}
    </Banner>
  )
}

function Footer({ onClose, label, held, onGo, tone = 'primary' }: { onClose: () => void; label: string; held: string | null; onGo: () => void; tone?: 'primary' | 'danger' }) {
  const t = useT('products-sizes-depth')
  return (
    <>
      <Button onClick={onClose}>{t('common.back')}</Button>
      <Button variant={tone} heldReason={held} onClick={onGo} aria-keyshortcuts="Meta+Enter Control+Enter">
        {label}
      </Button>
    </>
  )
}

const onCmdEnter = (go: () => void) => (event: React.KeyboardEvent) => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
    event.preventDefault()
    go()
  }
}

function RuleOptions({ model, none }: { model: SpecModel; none: string }) {
  const t = useT('products-sizes-depth')
  return (
    <>
      <option value="">{model.rules === null ? t('spec.word.reading') : none}</option>
      {(model.rules ?? []).map((rule) => (
        <option key={rule.id} value={rule.id}>
          {`${rule.code} · ${rule.name} (${t('spec.ruleBase', { size: rule.baseSize })})`}
        </option>
      ))}
    </>
  )
}

/** Start the spec: its base size (the style's), a grade rule of the scale or none, or a copy of an earlier spec of this revision. */
function StartDialog({ view, model, held, actions, onClose }: DialogProps) {
  const t = useT('products-sizes-depth')
  const [baseSize, setBase] = useState(view.style.baseSize && view.sizes.some((size) => size.code === view.style.baseSize) ? view.style.baseSize : (view.sizes[0]?.code ?? ''))
  const [ruleId, setRule] = useState('')
  const [from, setFrom] = useState<'blank' | 'copy'>('blank')
  const [copyId, setCopy] = useState(view.archived[0]?.id ?? '')
  const startHeldWords = held ? t(held) : !baseSize ? t('spec.start.held.base') : from === 'copy' && !copyId ? t('spec.start.held.copy') : model.busy ? t('held.busy') : null
  const go = () => {
    if (!startHeldWords) void actions?.onStart?.({ baseSize, gradeRuleId: from === 'copy' ? null : ruleId || null, copyFromSpecId: from === 'copy' ? copyId : null })
  }
  return (
    <Modal open onClose={onClose} size="md" title={t('spec.start.title', { revision: view.revision.revision })} footer={<Footer onClose={onClose} label={t('spec.start.go')} held={startHeldWords} onGo={go} />}>
      <div className="fw-spc-dialog" onKeyDown={onCmdEnter(go)}>
        <p className="fw-spc-sub">{t('spec.start.intro')}</p>
        <Refused model={model} />
        <Field label={t('spec.field.base')} hint={t('spec.field.baseHint')}>
          <Select value={baseSize} onChange={(event) => setBase(event.target.value)}>
            {view.sizes.map((size) => (
              <option key={size.code} value={size.code}>
                {size.label ? `${size.code} · ${size.label}` : size.code}
              </option>
            ))}
          </Select>
        </Field>
        {view.archived.length > 0 && (
          <div className="fw-spc-radios" role="radiogroup" aria-label={t('spec.start.from')}>
            <Radio name="spec-from" checked={from === 'blank'} onChange={() => setFrom('blank')} label={t('spec.start.blank')} />
            <Radio name="spec-from" checked={from === 'copy'} onChange={() => setFrom('copy')} label={t('spec.start.copy')} />
          </div>
        )}
        {from === 'copy' ? (
          <Field label={t('spec.start.copyOf')}>
            <Select value={copyId} onChange={(event) => setCopy(event.target.value)}>
              {view.archived.map((spec) => (
                <option key={spec.id} value={spec.id}>
                  {t('spec.start.archivedSpec', { base: spec.baseSize, date: spec.createdAt.slice(0, 10) })}
                </option>
              ))}
            </Select>
          </Field>
        ) : (
          <Field label={t('spec.field.rule')} hint={t('spec.field.ruleHint')}>
            <Select value={ruleId} onChange={(event) => setRule(event.target.value)}>
              <RuleOptions model={model} none={t('spec.ruleNone')} />
            </Select>
          </Field>
        )}
      </div>
    </Modal>
  )
}

/** The spec's base size and grade rule. */
function SettingsDialog({ view, model, held, actions, onClose }: DialogProps) {
  const t = useT('products-sizes-depth')
  const spec = view.spec!
  const [baseSize, setBase] = useState(spec.baseSize)
  const [ruleId, setRule] = useState(spec.gradeRule?.id ?? '')
  const patch = { ...(baseSize !== spec.baseSize ? { baseSize } : {}), ...(ruleId !== (spec.gradeRule?.id ?? '') ? { gradeRuleId: ruleId || null } : {}) }
  const settingsHeld = held ? t(held) : Object.keys(patch).length === 0 ? t('spec.word.nothing') : model.busy ? t('held.busy') : null
  const go = () => {
    if (!settingsHeld) void actions?.onSettings?.(patch)
  }
  return (
    <Modal open onClose={onClose} size="md" title={t('spec.settings.title')} footer={<Footer onClose={onClose} label={t('spec.word.save')} held={settingsHeld} onGo={go} />}>
      <div className="fw-spc-dialog" onKeyDown={onCmdEnter(go)}>
        <Refused model={model} />
        <Field label={t('spec.field.base')} hint={t('spec.settings.baseHint')}>
          <Select value={baseSize} onChange={(event) => setBase(event.target.value)}>
            {view.sizes.map((size) => (
              <option key={size.code} value={size.code}>
                {size.label ? `${size.code} · ${size.label}` : size.code}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('spec.field.rule')} hint={t('spec.settings.ruleHint')}>
          <Select value={ruleId} onChange={(event) => setRule(event.target.value)}>
            {spec.gradeRule && !(model.rules ?? []).some((rule) => rule.id === spec.gradeRule!.id) && <option value={spec.gradeRule.id}>{`${spec.gradeRule.code} · ${spec.gradeRule.name}`}</option>}
            <RuleOptions model={model} none={t('spec.ruleNone')} />
          </Select>
        </Field>
      </div>
    </Modal>
  )
}

/** Add points: garment points of the library not in the spec yet, each with its value in the base size. */
function AddDialog({ view, model, held, actions, onClose }: DialogProps) {
  const t = useT('products-sizes-depth')
  const locale = useLocale()
  const spec = view.spec!
  const choices = (model.library ?? []).filter((point) => !view.points.some((entry) => entry.pointOfMeasureId === point.id))
  const [lines, setLines] = useState<AddLine[]>([])
  const lineOf = (id: string): AddLine => lines.find((line) => line.id === id) ?? { id, picked: false, value: '' }
  const set = (id: string, patch: Partial<AddLine>) => setLines((current) => [...current.filter((line) => line.id !== id), { ...lineOf(id), ...patch }])
  const plan = addPlan(lines)
  const addHeld = held ? t(held) : 'held' in plan ? t(plan.held) : model.busy ? t('held.busy') : null
  const count = lines.filter((line) => line.picked).length
  const go = () => {
    if (!addHeld && 'points' in plan) void actions?.onAdd?.(plan.points)
  }
  return (
    <Modal open onClose={onClose} size="lg" title={t('spec.addDialog.title')} footer={<Footer onClose={onClose} label={t('spec.addDialog.go', { count })} held={addHeld} onGo={go} />}>
      <div className="fw-spc-dialog" onKeyDown={onCmdEnter(go)}>
        <p className="fw-spc-sub">{t('spec.addDialog.intro', { base: spec.baseSize })}</p>
        <Refused model={model} />
        {model.library === null ? (
          <p className="fw-spc-sub" role="status">
            <Spinner size={12} /> {t('spec.word.reading')}
          </p>
        ) : choices.length === 0 ? (
          <p className="fw-spc-sub">{t('spec.addDialog.none')}</p>
        ) : (
          <ul className="fw-spc-addlist">
            {choices.map((point) => {
              const line = lineOf(point.id)
              return (
                <li key={point.id}>
                  <Checkbox checked={line.picked} onChange={(event) => set(point.id, { picked: event.target.checked })} label={`${point.code} · ${point.name}`} />
                  <span className="fw-spc-sub">{point.defaultTolerance ? t('spec.addDialog.tolerance', { tolerance: numberText(point.defaultTolerance, locale), unit: point.uom.toLowerCase() }) : t('spec.addDialog.noTolerance')}</span>
                  <Input
                    size="sm"
                    inputMode="decimal"
                    aria-label={t('spec.addDialog.value', { code: point.code, base: spec.baseSize })}
                    placeholder={t('spec.addDialog.valuePlaceholder', { base: spec.baseSize, unit: point.uom.toLowerCase() })}
                    value={line.value}
                    onChange={(event) => set(point.id, { value: event.target.value, picked: true })}
                  />
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </Modal>
  )
}

/** Apply grade rule (design pop:styles.grade). */
function GradeDialog({ view, model, held, actions, onClose }: DialogProps) {
  const t = useT('products-sizes-depth')
  const locale = useLocale()
  const grade = model.grade
  const ruleId = grade?.ruleId ?? ''
  const keep = grade?.keepOverrides ?? true
  const preview = grade?.preview ?? { status: 'idle' as const }
  const applyHeld = gradeHeld(grade, model.busy, held)
  const [ack, setAck] = useState(false)
  const value = preview.status === 'ready' ? preview.value : null
  const lines = value ? gradeLines(value) : null
  const unitOf = (pointId: string) => view.points.find((point) => point.pointOfMeasureId === pointId)?.uom.toLowerCase() ?? ''
  const numbers = (cell: { nominal: string } | null, pointId: string) => (cell ? `${numberText(cell.nominal, locale)} ${unitOf(pointId)}` : t('spec.grade.empty'))
  const go = () => {
    if (!applyHeld) void actions?.onApplyGrade?.()
  }
  return (
    <Modal open onClose={onClose} size="lg" title={t('spec.grade.title')} footer={<Footer onClose={onClose} label={t('spec.grade.go', { count: lines?.written.length ?? 0 })} held={applyHeld ? t(applyHeld) : null} onGo={go} />}>
      <div className="fw-spc-dialog" onKeyDown={onCmdEnter(go)}>
        <p className="fw-spc-sub">{t('spec.grade.intro', { base: view.spec?.baseSize ?? '—' })}</p>
        <Refused model={model} />
        <Field label={t('spec.field.rule')} hint={t('spec.grade.ruleHint')}>
          <Select value={ruleId} onChange={(event) => actions?.onGrade?.(event.target.value, keep)}>
            <RuleOptions model={model} none={t('spec.grade.pick')} />
          </Select>
        </Field>
        <div className="fw-spc-radios" role="radiogroup" aria-label={t('spec.grade.overrides')}>
          <Radio name="spec-keep" checked={keep} onChange={() => actions?.onGrade?.(ruleId, true)} label={t('spec.grade.keep')} />
          <Radio name="spec-keep" checked={!keep} onChange={() => actions?.onGrade?.(ruleId, false)} label={t('spec.grade.overwrite')} />
        </div>
        {preview.status === 'idle' ? (
          <p className="fw-spc-sub">{t('spec.grade.pickFirst')}</p>
        ) : preview.status === 'loading' ? (
          <p className="fw-spc-sub" role="status">
            <Spinner size={12} /> {t('spec.grade.reading')}
          </p>
        ) : preview.status === 'error' ? (
          <Banner tone="danger" title={t('spec.grade.failed')}>
            {t(preview.problem)}
          </Banner>
        ) : (
          <ReviewChangesPanel
            label={t('spec.grade.review', { count: lines!.written.length })}
            changes={lines!.written.map((cell) => ({
              id: `${cell.pointOfMeasureId}:${cell.size}`,
              where: `${cell.code} · ${cell.size}`,
              what: t(`spec.grade.action.${cell.action}`),
              now: numbers(cell.before, cell.pointOfMeasureId),
              next: numbers(cell.after, cell.pointOfMeasureId),
              note: cell.action === 'OVERWRITE' ? t('spec.grade.overwriteNote') : undefined,
            }))}
            warnings={[
              ...(lines!.kept > 0 ? [t('spec.grade.kept', { count: lines!.kept })] : []),
              ...(lines!.notReached.length > 0 ? [t('spec.grade.notReached', { count: lines!.notReached.length, cells: lines!.notReached.slice(0, 6).map((cell) => `${cell.code} ${cell.size}`).join(', ') })] : []),
              ...(lines!.outOfRange.length > 0 ? [t('spec.grade.outOfRange', { count: lines!.outOfRange.length, cells: lines!.outOfRange.slice(0, 6).map((cell) => `${cell.code} ${cell.size}`).join(', ') })] : []),
              ...(value!.notInRule.length > 0 ? [t('spec.grade.notInRule', { codes: value!.notInRule.map((point) => point.code).join(', ') })] : []),
              ...(value!.noBase.length > 0 ? [t('spec.grade.noBase', { codes: value!.noBase.map((point) => point.code).join(', '), base: value!.baseSize })] : []),
            ]}
            ack={ack}
            onAckChange={setAck}
          />
        )}
      </div>
    </Modal>
  )
}

/** Paste from a sheet: one line per point (its code first), a value per size of the range — or a first line of sizes. */
function PasteDialog({ view, model, held, actions, onClose }: DialogProps) {
  const t = useT('products-sizes-depth')
  const [text, setText] = useState(model.paste ?? '')
  const result = pasteCells(text, view)
  const pasteHeld = held ? t(held) : text.trim() === '' ? t('spec.pasteDialog.held.empty') : result.cells.length === 0 ? t('spec.pasteDialog.held.nothing') : result.cells.length > 3000 ? t('spec.pasteDialog.held.tooMany') : model.busy ? t('held.busy') : null
  const go = () => {
    if (!pasteHeld) void actions?.onCells?.(result.cells, { key: 'spec.notice.pasted', params: { count: result.cells.length } })
  }
  return (
    <Modal open onClose={onClose} size="lg" title={t('spec.pasteDialog.title')} footer={<Footer onClose={onClose} label={t('spec.pasteDialog.go', { count: result.cells.length })} held={pasteHeld} onGo={go} />}>
      <div className="fw-spc-dialog" onKeyDown={onCmdEnter(go)}>
        <p className="fw-spc-sub">{t('spec.pasteDialog.intro', { sizes: view.sizes.map((size) => size.code).join(' ') })}</p>
        <Refused model={model} />
        <Field label={t('spec.pasteDialog.field')} hint={t('spec.pasteDialog.hint')}>
          <Textarea value={text} rows={8} autoFocus onChange={(event) => setText(event.target.value)} className="fw-spc-mono" />
        </Field>
        {text.trim() !== '' && <p className="fw-spc-sub" role="status">{t('spec.pasteDialog.found', { count: result.cells.length, points: result.points })}</p>}
        {result.problems.length > 0 && (
          <Banner tone="warning" title={t('spec.pasteDialog.problems', { count: result.problems.length })}>
            <ul className="fw-spc-list">
              {result.problems.slice(0, 8).map((problem) => (
                <li key={`${problem.key}|${problem.params.code}|${problem.params.size ?? ''}`}>{t(problem.key, problem.params)}</li>
              ))}
            </ul>
          </Banner>
        )}
      </div>
    </Modal>
  )
}

/** Fill a row from the base by an increment (DS SizeFill; values typed by hand kept unless unticked). */
function FillDialog({ view, row, model, held, actions, onClose }: DialogProps & { row: SpecRow }) {
  const t = useT('products-sizes-depth')
  const locale = useLocale()
  const ds = useDsWords()
  const base = view.spec?.baseSize ?? null
  const sizes = view.sizes.map((size) => size.code)
  return (
    <Modal open onClose={onClose} size="md" sheet title={t('spec.fill.title', { code: row.point.code })}>
      <div className="fw-spc-dialog">
        <p className="fw-spc-sub">{t('spec.fill.intro', { base: base ?? '—' })}</p>
        <Refused model={model} />
        <SizeFill
          sizes={sizes}
          base={base}
          values={Object.fromEntries(sizes.map((size) => [size, row.cells[size]?.nominal ?? null]))}
          unit={row.point.uom.toLowerCase()}
          overrides={sizes.filter((size) => size !== base && row.cells[size]?.source === 'TYPED')}
          scale={2}
          locale={INTL_LOCALE[locale]}
          heldReason={held ? t(held) : model.busy ? t('held.busy') : null}
          onCancel={onClose}
          onApply={(changes) => void actions?.onCells?.(fillCells(row.id, changes), { key: 'spec.notice.filled', params: { code: row.point.code, count: changes.length } })}
          headingLevel={3}
          labels={ds.sizeColumns}
        />
      </div>
    </Modal>
  )
}

/** A row's tolerance, under and over, for every size it has a value for. */
function ToleranceDialog({ view, row, model, held, actions, onClose }: DialogProps & { row: SpecRow }) {
  const t = useT('products-sizes-depth')
  const locale = useLocale()
  const now = toleranceOf(row, view.spec?.baseSize ?? null)
  const edit = (value: string | undefined) => (value === undefined ? '' : locale === 'it' ? value.replace('.', ',') : value)
  const [minus, setMinus] = useState(edit(now?.minus))
  const [plus, setPlus] = useState(edit(now?.plus))
  const cleanMinus = typedTolerance(minus)
  const cleanPlus = typedTolerance(plus)
  const cells = cleanMinus !== null && cleanPlus !== null ? toleranceCells(row, cleanMinus, cleanPlus) : []
  const toleranceHeld = held ? t(held) : cleanMinus === null || cleanPlus === null ? t('spec.toleranceDialog.held.number') : cells.length === 0 ? t('spec.toleranceDialog.held.noValues') : model.busy ? t('held.busy') : null
  const go = () => {
    if (!toleranceHeld) void actions?.onCells?.(cells, { key: 'spec.notice.tolerance', params: { code: row.point.code } })
  }
  return (
    <Modal open onClose={onClose} size="sm" title={t('spec.toleranceDialog.title', { code: row.point.code })} footer={<Footer onClose={onClose} label={t('spec.toleranceDialog.go', { count: cells.length })} held={toleranceHeld} onGo={go} />}>
      <div className="fw-spc-dialog" onKeyDown={onCmdEnter(go)}>
        <p className="fw-spc-sub">{t('spec.toleranceDialog.intro', { unit: row.point.uom.toLowerCase() })}</p>
        <Refused model={model} />
        <div className="fw-spc-pair">
          <Field label={t('spec.toleranceDialog.minus')} error={minus !== '' && cleanMinus === null ? t('spec.toleranceDialog.held.number') : undefined}>
            <Input inputMode="decimal" value={minus} autoFocus onChange={(event) => setMinus(event.target.value)} />
          </Field>
          <Field label={t('spec.toleranceDialog.plus')} error={plus !== '' && cleanPlus === null ? t('spec.toleranceDialog.held.number') : undefined}>
            <Input inputMode="decimal" value={plus} onChange={(event) => setPlus(event.target.value)} />
          </Field>
        </div>
      </div>
    </Modal>
  )
}

function RemoveDialog({ rows, model, held, actions, onClose }: { rows: readonly SpecRow[]; model: SpecModel; held: string | null; actions?: SpecActions; onClose: () => void }) {
  const t = useT('products-sizes-depth')
  const removeHeld = held ? t(held) : rows.length === 0 ? t('spec.word.none') : model.busy ? t('held.busy') : null
  const go = () => {
    if (!removeHeld) void actions?.onRemove?.(rows.map((row) => row.id))
  }
  return (
    <Modal open onClose={onClose} size="md" title={t('spec.removeDialog.title', { count: rows.length })} footer={<Footer onClose={onClose} label={t('spec.bulk.remove', { count: rows.length })} held={removeHeld} onGo={go} tone="danger" />}>
      <div className="fw-spc-dialog" onKeyDown={onCmdEnter(go)}>
        <p className="fw-spc-sub">{t('spec.removeDialog.body')}</p>
        <Refused model={model} />
        <ul className="fw-spc-list">
          {rows.map((row) => (
            <li key={row.id}>
              <b>{row.point.code}</b> · {row.point.name} — {t('spec.removeDialog.values', { count: Object.values(row.cells).filter((value) => value !== null).length })}
            </li>
          ))}
        </ul>
      </div>
    </Modal>
  )
}

/** Approve (every point × size must have a value), Reopen and Archive (each with its reason). */
function MoveDialog({ move, view, model, actions, onClose }: { move: 'approve' | 'reopen' | 'archive'; view: MeasurementSpecView; model: SpecModel; actions?: SpecActions; onClose: () => void }) {
  const t = useT('products-sizes-depth')
  const [reason, setReason] = useState('')
  const needsReason = move !== 'approve'
  const missing = missingCount(view)
  const moveHeld = !model.can[move === 'archive' ? 'manage' : 'release'] ? t(move === 'archive' ? 'spec.held.noManage' : 'spec.held.noRelease') : move === 'approve' && missing > 0 ? t('spec.held.missing', { count: missing }) : needsReason && reason.trim() === '' ? t('spec.moveDialog.held.reason') : model.busy ? t('held.busy') : null
  const go = () => {
    if (!moveHeld) void actions?.onSpecMove?.(move, needsReason ? reason.trim() : undefined)
  }
  return (
    <Modal open onClose={onClose} size="md" title={t(`spec.moveDialog.${move}.title`, { revision: view.revision.revision })} footer={<Footer onClose={onClose} label={t(`spec.moveDialog.${move}.go`)} held={moveHeld} onGo={go} tone={move === 'archive' ? 'danger' : 'primary'} />}>
      <div className="fw-spc-dialog" onKeyDown={onCmdEnter(go)}>
        <p className="fw-spc-sub">{t(`spec.moveDialog.${move}.body`, { points: view.points.length, sizes: view.sizes.length })}</p>
        <Refused model={model} />
        {needsReason && (
          <Field label={t('spec.moveDialog.reason')} required>
            <Textarea value={reason} rows={2} maxLength={500} autoFocus onChange={(event) => setReason(event.target.value)} />
          </Field>
        )}
      </div>
    </Modal>
  )
}

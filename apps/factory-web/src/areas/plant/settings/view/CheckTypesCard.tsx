'use client'

import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Archive, Plus, RotateCcw, Search } from 'lucide-react'
import { Banner, Card, EmptyState, Field } from '@nexus/ui/components'
import { LawRef } from '@nexus/ui/components/LawRef/index'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Input, NumberStepper, Pill, Select, Toggle } from '@nexus/ui/primitives'
import { CHECK_LIMITS, MAX_RETENTION_YEARS } from '@nexus/factory-domain/plant/statutory/rules'
import { Modal, useDsWords } from '../../../../lib/i18n/ds-parts'
import { useLocale } from '../../../../lib/i18n/provider'
import { ListFrame } from '../../../../list-frame/ListFrame'
import type { ListKey } from '../../../../list-frame/model'
import { labelOf } from '../../_shared/model'
import type { ClassRow } from '../api'
import { INTERVAL_UNITS, type CheckType, type IntervalUnit } from '../depth-api'
import { intervalMaxOf, typeChanges, typeHeld, typeStateHeld, TYPE_ROWS, visibleTypes, type TypeDraft, type TypeRows } from '../depth-model'
import type { DepthActions, DepthDialog, DepthModel } from '../depth-view-model'
import { CardHead, say, SectionState, useSettingsWords, type Translate } from './parts'

/** The law the retention rests on (the plan's "results kept at least 3 years"; the years come from the API). */
export const RETENTION_LAW = 'D.Lgs. 81/2008 art. 71'

const isTyping = (target: EventTarget | null): boolean => {
  const element = target as HTMLElement | null
  if (!element) return false
  if (element.isContentEditable) return true
  return element.closest?.('input, textarea, select, [role="dialog"], [role="menu"], [role="listbox"]') != null
}

/** "Every 12 months" in the page's words. */
export const intervalWords = (t: Translate, interval: number, unit: IntervalUnit): string => t(`checks.every.${unit}`, { count: interval })

/**
 * Statutory check types (design plant.settings sec:checks, QHS-205: check type, legal basis, default interval, outside
 * body, retention of at least three years; "List edited in a modal"): the group's types on the shared list frame — code ·
 * check · legal basis (LawRef) · for · default interval · outside body · kept · plans · results · state — with a search,
 * Active / Retired / All, New check type (`c` while the focus is in this card), Enter opens the type's dialog; with rows
 * selected Retire N · Make N active again. A type is retired, never deleted (its plans and results keep it).
 */
export function CheckTypesCard({ depth, actions }: { depth: DepthModel; actions?: DepthActions }) {
  const t = useSettingsWords()
  const locale = useLocale()
  const ds = useDsWords()
  const { read, rows: filter, busy } = depth.checks
  const types = read.status === 'ready' ? read.value.types : null
  const canManage = read.status === 'ready' && read.value.canManage
  const least = read.status === 'ready' ? read.value.leastRetentionYears : null
  const [query, setQuery] = useState(depth.checks.query ?? '')
  const [selected, setSelected] = useState<readonly string[]>(depth.checks.selected ?? [])
  useEffect(() => setSelected(depth.checks.selected ?? []), [depth.checks.selected])
  useEffect(() => setQuery(depth.checks.query ?? ''), [depth.checks.query])
  const typesKey = types?.map((type) => `${type.id}:${type.version}`).join(',') ?? ''
  useEffect(() => setSelected((current) => current.filter((id) => types?.some((type) => type.id === id))), [typesKey])
  const shown = useMemo(() => (types ? visibleTypes(types, filter, query) : null), [types, filter, query])
  const picked = (types ?? []).filter((type) => selected.includes(type.id))
  const latest = useRef({ actions })
  latest.current = { actions }

  const columns = useMemo<ColDef<CheckType>[]>(() => {
    const CodeCell = ({ data }: ICellRendererParams<CheckType>) =>
      data ? (
        <Button size="sm" variant="quiet" aria-label={t('checks.open', { code: data.code })} onClick={() => latest.current.actions?.onTypeOpen?.(data)}>
          <span className={data.active ? 'fw-pls-code' : 'fw-pls-code off'}>{data.code}</span>
        </Button>
      ) : null
    const WordsCell = ({ data }: ICellRendererParams<CheckType>) =>
      data ? (
        <span className="fw-pls-twoline">
          <span className="fw-pls-words">{labelOf(data, locale)}</span>
          <span className="fw-pls-sub">{locale === 'it' ? data.labelEn : data.labelIt}</span>
        </span>
      ) : null
    const LawCell = ({ data }: ICellRendererParams<CheckType>) => (data ? <LawRef law={data.legalBasis} plain={t('checks.lawPlain')} labels={ds.lawRef} /> : null)
    const ForCell = ({ data }: ICellRendererParams<CheckType>) => (data ? <span className={data.machineClass ? undefined : 'fw-pls-sub'}>{data.machineClass ? labelOf({ ...data.machineClass, labelI18n: {} }, locale) : t('checks.anyMachine')}</span> : null)
    const IntervalCell = ({ data }: ICellRendererParams<CheckType>) => (data ? <span>{intervalWords(t, data.defaultInterval, data.defaultIntervalUnit)}</span> : null)
    const BodyCell = ({ data }: ICellRendererParams<CheckType>) => (data ? <span className={data.outsideBody ? undefined : 'fw-pls-sub'}>{t(data.outsideBody ? 'checks.outside.yes' : 'checks.outside.no')}</span> : null)
    const KeptCell = ({ data }: ICellRendererParams<CheckType>) => (data ? <span title={t('checks.keptHint', { years: data.retentionYears })}>{t('checks.years', { count: data.keptYears })}</span> : null)
    const StateCell = ({ data }: ICellRendererParams<CheckType>) => (data ? <Pill tone={data.active ? 'success' : 'neutral'}>{t(data.active ? 'checks.active' : 'checks.retired')}</Pill> : null)
    return [
      { colId: 'code', headerName: t('checks.col.code'), minWidth: 170, flex: 1, cellRenderer: CodeCell },
      { colId: 'words', headerName: t('checks.col.check'), minWidth: 200, flex: 1.6, cellRenderer: WordsCell },
      { colId: 'law', headerName: t('checks.col.law'), minWidth: 210, flex: 1.5, cellRenderer: LawCell },
      { colId: 'for', headerName: t('checks.col.for'), minWidth: 140, flex: 1, cellRenderer: ForCell },
      { colId: 'interval', headerName: t('checks.col.interval'), minWidth: 140, flex: 0.9, cellRenderer: IntervalCell },
      { colId: 'body', headerName: t('checks.col.body'), minWidth: 120, flex: 0.7, cellRenderer: BodyCell },
      { colId: 'kept', headerName: t('checks.col.kept'), minWidth: 100, flex: 0.6, cellRenderer: KeptCell },
      { colId: 'plans', headerName: t('checks.col.plans'), field: 'plans', width: 100, minWidth: 90, maxWidth: 140, type: 'rightAligned' },
      { colId: 'results', headerName: t('checks.col.results'), field: 'results', width: 100, minWidth: 90, maxWidth: 140, type: 'rightAligned' },
      { colId: 'state', headerName: t('checks.col.state'), width: 120, minWidth: 100, maxWidth: 160, cellRenderer: StateCell },
    ]
  }, [t, locale, ds.lawRef])

  const ownKeys: ListKey[] = canManage
    ? [
        { keys: ['c'], does: t('checks.keys.new') },
        { keys: ['↵'], does: t('checks.keys.open') },
      ]
    : [{ keys: ['↵'], does: t('checks.keys.open') }]

  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || isTyping(event.target) || depth.dialog) return
    if (canManage && event.key === 'c') {
      event.preventDefault()
      actions?.onTypeNew?.()
    }
  }

  const count = types ? t('checks.count', { count: types.filter((type) => type.active).length, retired: types.filter((type) => !type.active).length }) : '—'
  const newHeld = read.status !== 'ready' ? t('held.loading') : !canManage ? t('held.noChecks') : null
  const retireHeld = typeStateHeld(picked, false, busy)
  const restoreHeld = typeStateHeld(picked, true, busy)

  return (
    <Card padded>
      <section className="fw-pls-stack" aria-labelledby="fw-pls-checks" data-pls-section="checks" onKeyDown={onKeyDown}>
        <CardHead
          id="fw-pls-checks"
          title={t('checks.title')}
          purpose={t('checks.purpose')}
          side={least !== null ? <LawRef law={RETENTION_LAW} plain={t('checks.retentionPlain', { years: least })} labels={ds.lawRef} /> : null}
        />
        <SectionState read={read} title={t('checks.title')} onRetry={() => actions?.onChecksRetry?.()}>
          {(value) => (
            <>
              {!value.canManage && <p className="fw-pls-hint">{t('checks.readOnly')}</p>}
              <ListFrame<CheckType>
                label={t('checks.table')}
                listKey="plant.settings.checks"
                rows={shown}
                rowId={(type) => type.id}
                columns={columns}
                rowKind="two-line"
                count={count}
                search={<Input size="sm" type="search" leadingIcon={<Search size={13} aria-hidden />} aria-label={t('checks.search')} placeholder={t('checks.search')} value={query} onChange={(event) => setQuery(event.target.value)} />}
                tools={
                  <Select size="sm" aria-label={t('checks.rows.label')} value={filter} onChange={(event) => actions?.onTypeRows?.(event.target.value as TypeRows)}>
                    {TYPE_ROWS.map((rows) => (
                      <option key={rows} value={rows}>
                        {t(`checks.rows.${rows}`)}
                      </option>
                    ))}
                  </Select>
                }
                right={
                  <Button size="sm" variant="primary" heldReason={newHeld} onClick={() => actions?.onTypeNew?.()} aria-keyshortcuts="c">
                    <Plus size={14} aria-hidden /> {t('checks.new')}
                  </Button>
                }
                selection={
                  value.canManage
                    ? {
                        selected,
                        onChange: setSelected,
                        actions: (
                          <>
                            <Button size="sm" variant="danger-outline" aria-label={t('checks.bulk.retire', { count: picked.length })} heldReason={retireHeld ? t(retireHeld) : null} onClick={() => actions?.onTypeState?.(selected, false)}>
                              <Archive size={13} aria-hidden /> <SelectionLabel>{t('checks.bulk.retire', { count: picked.length })}</SelectionLabel>
                            </Button>
                            <Button size="sm" aria-label={t('checks.bulk.restore', { count: picked.length })} heldReason={restoreHeld ? t(restoreHeld) : null} onClick={() => actions?.onTypeState?.(selected, true)}>
                              <RotateCcw size={13} aria-hidden /> <SelectionLabel>{t('checks.bulk.restore', { count: picked.length })}</SelectionLabel>
                            </Button>
                          </>
                        ),
                      }
                    : undefined
                }
                cards={{
                  fields: {
                    code: { role: 'title', draw: (type) => type.code },
                    words: { role: 'subtitle', draw: (type) => labelOf(type, locale) },
                    law: { draw: (type) => type.legalBasis },
                    state: { role: 'aside' },
                  },
                }}
                keys={ownKeys}
                onHelp={() => actions?.onDialog?.({ kind: 'keys' })}
                onOpen={(type) => actions?.onTypeOpen?.(type)}
                state={
                  value.types.length === 0 ? (
                    <EmptyState
                      title={t('checks.emptyTitle')}
                      description={t(value.canManage ? 'checks.emptyBody' : 'checks.emptyBodyView')}
                      action={
                        value.canManage ? (
                          <Button size="sm" variant="primary" onClick={() => actions?.onTypeNew?.()}>
                            <Plus size={14} aria-hidden /> {t('checks.first')}
                          </Button>
                        ) : undefined
                      }
                    />
                  ) : shown && shown.length === 0 ? (
                    <EmptyState
                      title={t('checks.noMatch')}
                      action={
                        <Button
                          size="sm"
                          onClick={() => {
                            setQuery('')
                            actions?.onTypeRows?.('all')
                          }}
                        >
                          {t('checks.showAll')}
                        </Button>
                      }
                    />
                  ) : undefined
                }
              />
            </>
          )}
        </SectionState>
      </section>
    </Card>
  )
}

// ---- dialogs ------------------------------------------------------------------------------------------------------------------

export function CheckTypeDialogs({ depth, classes, actions }: { depth: DepthModel; classes: readonly ClassRow[]; actions?: DepthActions }) {
  const dialog = depth.dialog
  if (dialog?.kind === 'type') return <TypeDialog dialog={dialog} depth={depth} classes={classes} actions={actions} />
  if (dialog?.kind === 'typeState') return <TypeStateDialog dialog={dialog} depth={depth} actions={actions} />
  return null
}

/** A check type, new or open: code and class are fixed once added; words, law, default interval, outside body, kept. */
function TypeDialog({ dialog, depth, classes, actions }: { dialog: Extract<DepthDialog, { kind: 'type' }>; depth: DepthModel; classes: readonly ClassRow[]; actions?: DepthActions }) {
  const t = useSettingsWords()
  const locale = useLocale()
  const ds = useDsWords()
  const { draft, busy, problem } = dialog
  const read = depth.checks.read
  const types = read.status === 'ready' ? read.value.types : []
  const canManage = read.status === 'ready' && read.value.canManage
  const least = read.status === 'ready' ? read.value.leastRetentionYears : MAX_RETENTION_YEARS
  const type = draft.id ? (types.find((entry) => entry.id === draft.id) ?? null) : null
  const codes = types.map((entry) => entry.code)
  const set = (patch: Partial<TypeDraft>) => actions?.onTypeDraft?.(patch)
  const held = !canManage ? 'held.noChecks' : typeHeld(draft, codes, least, busy) ?? (type && Object.keys(typeChanges(type, draft)).length === 0 ? 'held.noChange' : null)
  const save = () => {
    if (!held) actions?.onTypeSave?.()
  }
  const fieldError = (field: string) => (problem?.field === field ? t(problem.key, problem.params) : undefined)
  const disabled = !canManage
  const codeTaken = !type && draft.code.trim() !== '' && codes.includes(draft.code.trim()) ? t('held.typeTaken') : undefined
  const max = intervalMaxOf(draft.defaultIntervalUnit)
  const classWords = type ? (type.machineClass ? labelOf({ ...type.machineClass, labelI18n: {} }, locale) : t('checks.anyMachine')) : null
  return (
    <Modal
      open
      onClose={() => actions?.onDialog?.(null)}
      title={type ? t('checkType.editTitle', { code: type.code }) : t('checkType.newTitle')}
      size="lg"
      footer={
        <>
          {type && canManage && (
            <Button variant={type.active ? 'danger-outline' : 'secondary'} heldReason={busy ? t('held.busy') : null} onClick={() => actions?.onTypeState?.([type.id], !type.active)}>
              {type.active ? <Archive size={14} aria-hidden /> : <RotateCcw size={14} aria-hidden />} {t(type.active ? 'checkType.retire' : 'checkType.restore')}
            </Button>
          )}
          <Button onClick={() => actions?.onDialog?.(null)}>{t(canManage ? 'rule.cancel' : 'close')}</Button>
          {canManage && (
            <Button variant="primary" heldReason={held ? t(held) : null} onClick={save} aria-keyshortcuts="Meta+Enter Control+Enter">
              {t(type ? 'checkType.save' : 'checkType.add')}
            </Button>
          )}
        </>
      }
    >
      <div
        className="fw-pls-dialog"
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault()
            save()
          }
        }}
      >
        <p className="fw-pls-hint">{t('checkType.intro')}</p>
        {problem && !problem.field && <Banner tone="danger" title={say(t, problem) ?? ''} />}
        {type && !type.active && <Banner tone="neutral" title={t('checkType.retiredNote')} />}
        {type && (type.plans > 0 || type.results > 0) && <p className="fw-pls-hint">{t('checkType.inUse', { plans: type.plans, results: type.results })}</p>}
        <div className="fw-pls-form">
          <Field label={t('checks.col.code')} required={!type} hint={type ? t('checkType.codeFixed') : t('checkType.codeHint')} error={fieldError('code') ?? codeTaken}>
            {type ? (
              <p className="fw-pls-value fw-pls-code">{type.code}</p>
            ) : (
              <Input value={draft.code} maxLength={40} autoFocus spellCheck={false} disabled={disabled} onChange={(event) => set({ code: event.target.value.toUpperCase().replace(/[\s-]+/g, '_').slice(0, 40) })} />
            )}
          </Field>
          <Field label={t('checks.col.for')} hint={type ? t('checkType.classFixed') : t('checkType.classHint')} error={fieldError('classId')}>
            {type ? (
              <p className="fw-pls-value">{classWords}</p>
            ) : (
              <Select value={draft.classId ?? ''} disabled={disabled} onChange={(event) => set({ classId: event.target.value || null })}>
                <option value="">{t('checks.anyMachine')}</option>
                {classes
                  .filter((entry) => entry.active)
                  .map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {labelOf(entry, locale)}
                    </option>
                  ))}
              </Select>
            )}
          </Field>
          <Field label={t('col.it')} required error={fieldError('labelIt')}>
            <Input value={draft.labelIt} maxLength={CHECK_LIMITS.label} lang="it" disabled={disabled} onChange={(event) => set({ labelIt: event.target.value })} />
          </Field>
          <Field label={t('col.en')} required error={fieldError('labelEn')}>
            <Input value={draft.labelEn} maxLength={CHECK_LIMITS.label} lang="en" disabled={disabled} onChange={(event) => set({ labelEn: event.target.value })} />
          </Field>
        </div>
        <Field label={t('checks.col.law')} required hint={t('checkType.lawHint')} error={fieldError('legalBasis')}>
          <Input value={draft.legalBasis} maxLength={CHECK_LIMITS.legalBasis} disabled={disabled} onChange={(event) => set({ legalBasis: event.target.value })} />
        </Field>
        <div className="fw-pls-form">
          <Field label={t('checkType.interval')} required hint={t('checkType.intervalHint', { max })} error={fieldError('defaultInterval')}>
            <span className="fw-pls-row">
              <NumberStepper value={draft.defaultInterval ?? ''} min={1} max={max} disabled={disabled} aria-label={t('checkType.interval')} onChange={(next) => set({ defaultInterval: next })} />
              <Select value={draft.defaultIntervalUnit} disabled={disabled} aria-label={t('checkType.unit')} onChange={(event) => set({ defaultIntervalUnit: event.target.value as IntervalUnit })}>
                {INTERVAL_UNITS.map((unit) => (
                  <option key={unit} value={unit}>
                    {t(`checkType.unitWords.${unit}`)}
                  </option>
                ))}
              </Select>
            </span>
          </Field>
          <Field label={t('checkType.retention')} hint={t('checkType.retentionHint', { years: least })} error={fieldError('retentionYears')}>
            <span className="fw-pls-row">
              <NumberStepper value={draft.retentionYears} min={least} max={MAX_RETENTION_YEARS} suffix={t('checkType.yearsSuffix')} disabled={disabled} aria-label={t('checkType.retention')} onChange={(next) => set({ retentionYears: next })} />
              <LawRef law={RETENTION_LAW} plain={t('checks.retentionPlain', { years: least })} labels={ds.lawRef} />
            </span>
          </Field>
        </div>
        <label className="fw-pls-toggle">
          <Toggle checked={draft.outsideBody} disabled={disabled} aria-label={t('checkType.outside')} onChange={(outsideBody) => set({ outsideBody })} />
          <span>
            <span>{t('checkType.outside')}</span>
            <span className="fw-pls-sub">{t('checkType.outsideHint')}</span>
          </span>
        </label>
      </div>
    </Modal>
  )
}

/** Retire N / Make N active again: said in words before it is sent (a retired type takes no new plan; plans keep it). */
function TypeStateDialog({ dialog, depth, actions }: { dialog: Extract<DepthDialog, { kind: 'typeState' }>; depth: DepthModel; actions?: DepthActions }) {
  const t = useSettingsWords()
  const types = depth.checks.read.status === 'ready' ? depth.checks.read.value.types.filter((type) => dialog.ids.includes(type.id) && type.active !== dialog.active) : []
  const plans = types.reduce((sum, type) => sum + type.plans, 0)
  const codes = types.map((type) => type.code).join(', ')
  return (
    <Modal
      open
      onClose={() => actions?.onDialog?.(null)}
      title={t(dialog.active ? 'checks.restoreTitle' : 'checks.retireTitle', { count: types.length })}
      size="md"
      footer={
        <>
          <Button onClick={() => actions?.onDialog?.(null)}>{t('rule.keep')}</Button>
          <Button variant={dialog.active ? 'primary' : 'danger'} heldReason={dialog.busy ? t('held.busy') : types.length === 0 ? t(dialog.active ? 'held.allActive' : 'held.allRetired') : null} onClick={() => actions?.onTypeStateConfirm?.()}>
            {t(dialog.active ? 'checks.bulk.restore' : 'checks.bulk.retire', { count: types.length })}
          </Button>
        </>
      }
    >
      <div className="fw-pls-dialog">
        <p className="fw-pls-text">{codes}</p>
        <p className="fw-pls-hint">{t(dialog.active ? 'checks.restoreBody' : 'checks.retireBody', { plans })}</p>
        {dialog.problem && <Banner tone="danger" title={say(t, dialog.problem) ?? ''} />}
      </div>
    </Modal>
  )
}

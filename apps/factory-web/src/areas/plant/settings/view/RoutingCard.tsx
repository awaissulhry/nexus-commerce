'use client'

import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { ArrowDown, ArrowUp, Plus, Power, PowerOff, Trash2 } from 'lucide-react'
import { Banner, Card, EmptyState, Field } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, NumberStepper, Pill, SegmentedControl, Select, Spinner, Tag, Toggle } from '@nexus/ui/primitives'
import { ROUTING_LIMITS } from '@nexus/factory-domain/plant/requests/routing'
import { Combobox, Modal } from '../../../../lib/i18n/ds-parts'
import { useLocale } from '../../../../lib/i18n/provider'
import type { Locale } from '../../../../lib/i18n/locales'
import { ListFrame } from '../../../../list-frame/ListFrame'
import type { ListKey } from '../../../../list-frame/model'
import { labelOf } from '../../_shared/model'
import type { ClassRow } from '../api'
import type { RoutingRule } from '../depth-api'
import { draftExample, removeOutcome, ruleChangeCount, ruleExample, ruleHeld, ruleMoveHeld, ruleSwitchHeld, type RuleDraft } from '../depth-model'
import type { DepthActions, DepthDialog, DepthModel, Pickers } from '../depth-view-model'
import { CardHead, say, SectionState, Sentences, useSettingsWords, type Translate } from './parts'

/** The machine type's words for a rule (null: every machine type). */
function classWordsOf(classId: string | null, classes: readonly ClassRow[], locale: Locale, fallback?: { labelIt: string; labelEn: string } | null): string | null {
  if (classId === null) return null
  const found = classes.find((entry) => entry.id === classId) ?? (fallback ? { ...fallback, labelI18n: {} } : null)
  return found ? labelOf(found, locale) : null
}

const isTyping = (target: EventTarget | null): boolean => {
  const element = target as HTMLElement | null
  if (!element) return false
  if (element.isContentEditable) return true
  return element.closest?.('input, textarea, select, [role="dialog"], [role="menu"], [role="listbox"]') != null
}

/**
 * Request routing and escalation (design plant.settings sec:routing, QHS-179): the site's rules in their order on the
 * shared list frame — place · machine type · goes to · notice · escalation · on or off · used — with "Where does a request
 * go?" (the API's preview of a machine type, said in our words). With rows selected: Switch on N · Switch off N · Move up ·
 * Move down · Remove N. Enter opens the rule dialog, where the worked example is said before you save. Keys: `c` new rule
 * and ⌥↑ / ⌥↓ move the chosen rules, while the focus is in this card.
 */
export function RoutingCard({ depth, classes, actions }: { depth: DepthModel; classes: readonly ClassRow[]; actions?: DepthActions }) {
  const t = useSettingsWords()
  const locale = useLocale()
  const site = depth.site
  const read = depth.routing.read
  const rules = read.status === 'ready' ? read.value.rules : null
  const canManage = read.status === 'ready' && read.value.canManage
  const [selected, setSelected] = useState<readonly string[]>(depth.routing.selected ?? [])
  useEffect(() => setSelected(depth.routing.selected ?? []), [depth.routing.selected])
  const rulesKey = rules?.map((rule) => `${rule.id}:${rule.version}`).join(',') ?? ''
  useEffect(() => setSelected((current) => current.filter((id) => rules?.some((rule) => rule.id === id))), [rulesKey])
  const picked = (rules ?? []).filter((rule) => selected.includes(rule.id))
  const latest = useRef({ depth, actions, classes })
  latest.current = { depth, actions, classes }

  const columns = useMemo<ColDef<RoutingRule>[]>(() => {
    const place = new Map((rules ?? []).map((rule, index) => [rule.id, index + 1]))
    const ForCell = ({ data }: ICellRendererParams<RoutingRule>) => {
      if (!data) return null
      const words = classWordsOf(data.machineClass?.id ?? null, latest.current.classes, locale, data.machineClass)
      return (
        <Button size="sm" variant="quiet" aria-label={t('routing.open', { place: place.get(data.id) ?? 0 })} onClick={() => latest.current.actions?.onRuleOpen?.(data)}>
          <span className={words ? undefined : 'fw-pls-sub'}>{words ?? t('routing.everyClass')}</span>
        </Button>
      )
    }
    const TargetCell = ({ data }: ICellRendererParams<RoutingRule>) =>
      data ? (
        <span className="fw-pls-cell">
          <Tag tone="neutral">{t(data.target.kind === 'TEAM' ? 'routing.kind.team' : 'routing.kind.person')}</Tag>
          <span className="fw-pls-words">{data.target.name}</span>
          {!data.target.active && <Pill tone="warning">{t('routing.inactive')}</Pill>}
        </span>
      ) : null
    const PushCell = ({ data }: ICellRendererParams<RoutingRule>) => (data ? <span className={data.push ? undefined : 'fw-pls-sub'}>{t(data.push ? 'routing.push.on' : 'routing.push.off')}</span> : null)
    const EscalationCell = ({ data }: ICellRendererParams<RoutingRule>) => {
      if (!data) return null
      if (data.escalateAfterMinutes === null || !data.escalateTo) return <span className="fw-pls-sub">{t('routing.noEscalation')}</span>
      const first = t('routing.step', { minutes: data.escalateAfterMinutes, person: data.escalateTo.name })
      const again = data.escalateAgainAfterMinutes !== null && data.escalateAgainTo ? t('routing.step', { minutes: data.escalateAgainAfterMinutes, person: data.escalateAgainTo.name }) : null
      const inactive = data.escalateTo.active === false || data.escalateAgainTo?.active === false
      return (
        <span className="fw-pls-cell">
          <span className="fw-pls-words">{again ? `${first} · ${again}` : first}</span>
          {inactive && <Pill tone="warning">{t('routing.inactive')}</Pill>}
        </span>
      )
    }
    const StateCell = ({ data }: ICellRendererParams<RoutingRule>) => (data ? <Pill tone={data.active ? 'success' : 'neutral'}>{t(data.active ? 'routing.on' : 'routing.off')}</Pill> : null)
    const UsedCell = ({ data }: ICellRendererParams<RoutingRule>) => (data ? <span title={t('routing.usedHint')}>{t('routing.used', { count: data.requests })}</span> : null)
    return [
      { colId: 'place', headerName: t('routing.col.place'), width: 110, minWidth: 96, maxWidth: 130, valueGetter: (params) => (params.data ? place.get(params.data.id) : null) },
      { colId: 'for', headerName: t('routing.col.for'), minWidth: 160, flex: 1.1, cellRenderer: ForCell },
      { colId: 'target', headerName: t('routing.col.target'), minWidth: 200, flex: 1.4, cellRenderer: TargetCell },
      { colId: 'push', headerName: t('routing.col.push'), minWidth: 130, flex: 0.8, cellRenderer: PushCell },
      { colId: 'escalation', headerName: t('routing.col.escalation'), minWidth: 240, flex: 2, cellRenderer: EscalationCell },
      { colId: 'state', headerName: t('routing.col.state'), width: 130, minWidth: 110, maxWidth: 170, cellRenderer: StateCell },
      { colId: 'used', headerName: t('routing.col.used'), width: 130, minWidth: 100, maxWidth: 180, type: 'rightAligned', cellRenderer: UsedCell },
    ]
  }, [t, locale, rulesKey])

  const ownKeys: ListKey[] = canManage
    ? [
        { keys: ['c'], does: t('routing.keys.new') },
        { keys: ['↵'], does: t('routing.keys.open') },
        { keys: ['⌥', '↑'], does: t('routing.keys.up') },
        { keys: ['⌥', '↓'], does: t('routing.keys.down') },
      ]
    : [{ keys: ['↵'], does: t('routing.keys.open') }]

  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || isTyping(event.target) || latest.current.depth.dialog) return
    if (!canManage) return
    if (!event.altKey && event.key === 'c') {
      event.preventDefault()
      actions?.onRuleNew?.()
    } else if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown') && selected.length > 0 && rules) {
      const delta = event.key === 'ArrowUp' ? -1 : 1
      if (!ruleMoveHeld(rules, selected, delta, depth.routing.busy)) {
        event.preventDefault()
        actions?.onRuleMove?.(selected, delta)
      }
    }
  }

  const siteName = site?.name ?? ''
  const count = rules ? t('routing.count', { count: rules.length, on: rules.filter((rule) => rule.active).length }) : '—'
  const newHeld = read.status !== 'ready' ? t('held.loading') : !canManage ? t('held.noSettings') : null
  const busy = depth.routing.busy
  const onHeld = ruleSwitchHeld(picked, true, busy)
  const offHeld = ruleSwitchHeld(picked, false, busy)
  const upHeld = rules ? ruleMoveHeld(rules, selected, -1, busy) : 'held.busy'
  const downHeld = rules ? ruleMoveHeld(rules, selected, 1, busy) : 'held.busy'

  return (
    <Card padded>
      <section className="fw-pls-stack" aria-labelledby="fw-pls-routing" data-pls-section="routing" onKeyDown={onKeyDown}>
        <CardHead id="fw-pls-routing" title={t('routing.title')} purpose={t('routing.purpose')} side={site ? <span className="fw-pls-hint">{t('routing.forSite', { site: siteName })}</span> : null} />
        {!site ? (
          <EmptyState title={t('section.noSite')} description={t('section.noSiteBody')} />
        ) : (
          <SectionState read={read} title={t('routing.title')} onRetry={() => actions?.onRoutingRetry?.()}>
            {(value) => (
              <>
                {!value.canManage && <p className="fw-pls-hint">{t('routing.readOnly')}</p>}
                <ListFrame<RoutingRule>
                  label={t('routing.table')}
                  listKey="plant.settings.routing"
                  rows={value.rules.length === 0 ? [] : value.rules}
                  rowId={(rule) => rule.id}
                  columns={columns}
                  rowKind="text"
                  count={count}
                  right={
                    <Button size="sm" variant="primary" heldReason={newHeld} onClick={() => actions?.onRuleNew?.()} aria-keyshortcuts="c">
                      <Plus size={14} aria-hidden /> {t('routing.new')}
                    </Button>
                  }
                  selection={
                    value.canManage
                      ? {
                          selected,
                          onChange: setSelected,
                          actions: (
                            <>
                              <Button size="sm" aria-label={t('routing.bulk.on', { count: picked.length })} heldReason={onHeld ? t(onHeld) : null} onClick={() => actions?.onRuleSwitch?.(selected, true)}>
                                <Power size={13} aria-hidden /> <SelectionLabel>{t('routing.bulk.on', { count: picked.length })}</SelectionLabel>
                              </Button>
                              <Button size="sm" aria-label={t('routing.bulk.off', { count: picked.length })} heldReason={offHeld ? t(offHeld) : null} onClick={() => actions?.onRuleSwitch?.(selected, false)}>
                                <PowerOff size={13} aria-hidden /> <SelectionLabel>{t('routing.bulk.off', { count: picked.length })}</SelectionLabel>
                              </Button>
                              <Button size="sm" aria-label={t('bulk.up')} heldReason={upHeld ? t(upHeld) : null} onClick={() => actions?.onRuleMove?.(selected, -1)} aria-keyshortcuts="Alt+ArrowUp">
                                <ArrowUp size={13} aria-hidden /> <SelectionLabel>{t('bulk.up')}</SelectionLabel>
                              </Button>
                              <Button size="sm" aria-label={t('bulk.down')} heldReason={downHeld ? t(downHeld) : null} onClick={() => actions?.onRuleMove?.(selected, 1)} aria-keyshortcuts="Alt+ArrowDown">
                                <ArrowDown size={13} aria-hidden /> <SelectionLabel>{t('bulk.down')}</SelectionLabel>
                              </Button>
                              <Button size="sm" variant="danger-outline" aria-label={t('routing.bulk.remove', { count: picked.length })} heldReason={busy ? t('held.busy') : null} onClick={() => actions?.onRuleRemoveMany?.(selected)}>
                                <Trash2 size={13} aria-hidden /> <SelectionLabel>{t('routing.bulk.remove', { count: picked.length })}</SelectionLabel>
                              </Button>
                            </>
                          ),
                        }
                      : undefined
                  }
                  cards={{
                    fields: {
                      place: { role: 'aside', draw: (rule) => t('routing.cardPlace', { place: value.rules.indexOf(rule) + 1 }) },
                      for: { role: 'title', draw: (rule) => classWordsOf(rule.machineClass?.id ?? null, classes, locale, rule.machineClass) ?? t('routing.everyClass') },
                      target: { role: 'subtitle', draw: (rule) => `${t(rule.target.kind === 'TEAM' ? 'routing.kind.team' : 'routing.kind.person')}: ${rule.target.name}` },
                      escalation: {
                        draw: (rule) =>
                          rule.escalateAfterMinutes === null || !rule.escalateTo
                            ? t('routing.noEscalation')
                            : [t('routing.step', { minutes: rule.escalateAfterMinutes, person: rule.escalateTo.name }), rule.escalateAgainAfterMinutes !== null && rule.escalateAgainTo ? t('routing.step', { minutes: rule.escalateAgainAfterMinutes, person: rule.escalateAgainTo.name }) : null].filter(Boolean).join(' · '),
                      },
                    },
                  }}
                  keys={ownKeys}
                  onHelp={() => actions?.onDialog?.({ kind: 'keys' })}
                  onOpen={(rule) => actions?.onRuleOpen?.(rule)}
                  state={
                    value.rules.length === 0 ? (
                      <EmptyState
                        title={t('routing.emptyTitle')}
                        description={t(value.canManage ? 'routing.emptyBody' : 'routing.emptyBodyView')}
                        action={
                          value.canManage ? (
                            <Button size="sm" variant="primary" onClick={() => actions?.onRuleNew?.()}>
                              <Plus size={14} aria-hidden /> {t('routing.first')}
                            </Button>
                          ) : undefined
                        }
                      />
                    ) : undefined
                  }
                />
                <Preview depth={depth} classes={classes} actions={actions} />
              </>
            )}
          </SectionState>
        )}
      </section>
    </Card>
  )
}

/** "Where does a request go?": pick a machine type, the API answers the rule it follows now, said in our words. */
function Preview({ depth, classes, actions }: { depth: DepthModel; classes: readonly ClassRow[]; actions?: DepthActions }) {
  const t = useSettingsWords()
  const locale = useLocale()
  const { classId, read } = depth.routing.preview
  const rules = depth.routing.read.status === 'ready' ? depth.routing.read.value.rules : []
  const site = depth.site?.code ?? depth.site?.name ?? ''
  const chosen = classes.find((entry) => entry.id === classId) ?? null
  const active = classes.filter((entry) => entry.active)
  return (
    <div className="fw-pls-preview-box" role="group" aria-labelledby="fw-pls-preview">
      <div className="fw-pls-preview-head">
        <h3 id="fw-pls-preview">{t('routing.preview.title')}</h3>
        <Select size="sm" aria-label={t('routing.preview.pick')} value={classId ?? ''} onChange={(event) => actions?.onPreviewClass?.(event.target.value || null)}>
          <option value="">{t('routing.preview.pick')}</option>
          {active.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {labelOf(entry, locale)}
            </option>
          ))}
        </Select>
      </div>
      {read.status === 'idle' ? (
        <p className="fw-pls-hint">{t('routing.preview.hint')}</p>
      ) : read.status === 'loading' ? (
        <p className="fw-pls-hint" role="status">
          <Spinner size={14} /> {t('routing.preview.loading')}
        </p>
      ) : read.status === 'error' ? (
        <p className="fw-pls-danger" role="alert">
          {t(read.problem)}
        </p>
      ) : read.value.rule ? (
        <Sentences live lines={ruleExample({ ...read.value.rule, push: rules.find((rule) => rule.id === read.value.rule?.id)?.push ?? null }, chosen ? labelOf(chosen, locale) : null, site)} />
      ) : (
        <Sentences live lines={[{ key: chosen ? 'routing.example.noneClass' : 'routing.example.noneAny', params: { class: chosen ? labelOf(chosen, locale) : '', site } }]} />
      )}
    </div>
  )
}

// ---- dialogs ------------------------------------------------------------------------------------------------------------------

/** The routing dialogs: the rule (new or open) with its worked example, and Remove N. */
export function RoutingDialogs({ depth, classes, actions }: { depth: DepthModel; classes: readonly ClassRow[]; actions?: DepthActions }) {
  const dialog = depth.dialog
  if (dialog?.kind === 'rule') return <RuleDialog dialog={dialog} depth={depth} classes={classes} actions={actions} />
  if (dialog?.kind === 'removeRules') return <RemoveRulesDialog dialog={dialog} depth={depth} actions={actions} />
  return null
}

function personOptions(pickers: Pickers, current: { id: string | null; name: string | null }): { value: string; label: string }[] {
  const listed = pickers.status === 'ready' ? pickers.value.employees.map((entry) => ({ value: entry.id, label: entry.displayName })) : []
  if (current.id && !listed.some((entry) => entry.value === current.id)) listed.unshift({ value: current.id, label: current.name ?? current.id })
  return listed
}

function RuleDialog({ dialog, depth, classes, actions }: { dialog: Extract<DepthDialog, { kind: 'rule' }>; depth: DepthModel; classes: readonly ClassRow[]; actions?: DepthActions }) {
  const t = useSettingsWords()
  const locale = useLocale()
  const { draft, pickers, busy, problem } = dialog
  const read = depth.routing.read
  const rules = read.status === 'ready' ? read.value.rules : []
  const canManage = read.status === 'ready' && read.value.canManage
  const rule = draft.id ? (rules.find((entry) => entry.id === draft.id) ?? null) : null
  const place = rule ? rules.indexOf(rule) + 1 : rules.length + 1
  const set = (patch: Partial<RuleDraft>) => actions?.onRuleDraft?.(patch)
  const held = !canManage ? 'held.noSettings' : ruleHeld(draft, busy) ?? (rule && ruleChangeCount(rule, draft) === 0 ? 'held.noChange' : null)
  const classWords = classWordsOf(draft.machineClassId, classes, locale, rule?.machineClass ?? null)
  const site = depth.site?.code ?? depth.site?.name ?? ''
  const fieldError = (field: string) => (problem?.field === field ? t(problem.key, problem.params) : undefined)
  const save = () => {
    if (!held) actions?.onRuleSave?.()
  }
  const listed = classes.filter((entry) => entry.active || entry.id === draft.machineClassId)
  const pickerNote = pickers.status === 'forbidden' ? t('rule.pickersForbidden') : pickers.status === 'error' ? t(pickers.problem) : null
  const teams = pickers.status === 'ready' ? pickers.value.teams.filter((team) => team.status === 'ACTIVE') : []
  const teamListed = draft.teamId && !teams.some((team) => team.id === draft.teamId)
  const disabled = !canManage
  const outcome = rule ? removeOutcome([rule]) : null
  return (
    <Modal
      open
      onClose={() => actions?.onDialog?.(null)}
      title={rule ? t('rule.editTitle', { place }) : t('rule.newTitle')}
      size="lg"
      footer={
        <>
          {rule && canManage && !dialog.confirmRemove && (
            <Button variant="danger-outline" heldReason={busy ? t('held.busy') : null} onClick={() => actions?.onRuleRemove?.(true)}>
              <Trash2 size={14} aria-hidden /> {t('rule.remove')}
            </Button>
          )}
          <Button onClick={() => actions?.onDialog?.(null)}>{t(canManage ? 'rule.cancel' : 'close')}</Button>
          {canManage && (
            <Button variant="primary" heldReason={held ? t(held) : null} onClick={save} aria-keyshortcuts="Meta+Enter Control+Enter">
              {t(rule ? 'rule.save' : 'rule.add')}
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
        <p className="fw-pls-hint">{t('rule.intro')}</p>
        {/* A refusal stands at the top, where it is seen without scrolling (a field's own refusal stands at its field). */}
        {problem && !problem.field && <Banner tone="danger" title={say(t, problem) ?? ''} />}
        {!canManage && <Banner tone="neutral" title={t('routing.readOnly')} />}
        {dialog.confirmRemove && outcome && (
          <Banner
            tone="warning"
            title={t(outcome.deleted ? 'rule.removeDelete' : 'rule.removeSwitchOff', { count: rule?.requests ?? 0 })}
            action={
              <span className="fw-pls-actions">
                <Button size="sm" onClick={() => actions?.onRuleRemove?.(false)}>
                  {t('rule.keep')}
                </Button>
                <Button size="sm" variant="danger" heldReason={busy ? t('held.busy') : null} onClick={() => actions?.onRemoveConfirm?.()}>
                  {t('rule.removeConfirm')}
                </Button>
              </span>
            }
          />
        )}
        <div className="fw-pls-form">
          <Field label={t('rule.for')} hint={t('rule.forHint')} error={fieldError('machineClassId')}>
            <Select value={draft.machineClassId ?? ''} disabled={disabled} onChange={(event) => set({ machineClassId: event.target.value || null })}>
              <option value="">{t('routing.everyClass')}</option>
              {listed.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {labelOf(entry, locale)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('rule.targetKind')}>
            <SegmentedControl
              ariaLabel={t('rule.targetKind')}
              size="sm"
              value={draft.targetKind}
              disabled={disabled || pickers.status === 'forbidden'}
              onChange={(next) => set({ targetKind: next as RuleDraft['targetKind'], targetName: null })}
              options={[
                { value: 'TEAM', label: t('routing.kind.team') },
                { value: 'TECHNICIAN', label: t('routing.kind.person') },
              ]}
            />
          </Field>
          {draft.targetKind === 'TEAM' ? (
            <Field label={t('rule.team')} hint={pickerNote ?? t('rule.teamHint')} error={fieldError('teamId')}>
              {pickers.status === 'ready' ? (
                <Select
                  value={draft.teamId ?? ''}
                  disabled={disabled}
                  onChange={(event) => {
                    const team = teams.find((entry) => entry.id === event.target.value)
                    set({ teamId: team?.id ?? null, targetName: team ? `${team.code} ${team.name}` : null })
                  }}
                >
                  <option value="">{t('rule.chooseTeam')}</option>
                  {teamListed && <option value={draft.teamId!}>{t('rule.notListed', { name: draft.targetName ?? '' })}</option>}
                  {teams.map((team) => (
                    <option key={team.id} value={team.id}>
                      {`${team.code} ${team.name}`}
                    </option>
                  ))}
                </Select>
              ) : (
                <PickerHolder pickers={pickers} name={draft.teamId ? draft.targetName : null} />
              )}
            </Field>
          ) : (
            <Field label={t('rule.technician')} hint={pickerNote ?? t('rule.technicianHint')} error={fieldError('technicianId')}>
              {pickers.status === 'ready' && !disabled ? (
                <Combobox
                  options={personOptions(pickers, { id: draft.technicianId, name: draft.targetName })}
                  value={draft.technicianId ?? ''}
                  placeholder={t('rule.choosePerson')}
                  onChange={(id) => set({ technicianId: id || null, targetName: personOptions(pickers, { id: null, name: null }).find((entry) => entry.value === id)?.label ?? null })}
                />
              ) : (
                <PickerHolder pickers={pickers} name={draft.technicianId ? draft.targetName : null} />
              )}
            </Field>
          )}
          <Field label={t('rule.push')} hint={t(draft.targetKind === 'TEAM' ? 'rule.pushHintTeam' : 'rule.pushHintPerson')}>
            <Toggle checked={draft.push} disabled={disabled} aria-label={t('rule.push')} onChange={(push) => set({ push })} />
          </Field>
        </div>
        <fieldset className="fw-pls-fieldset">
          <legend>{t('rule.escalation')}</legend>
          <label className="fw-pls-toggle">
            <Toggle checked={draft.escalate} disabled={disabled} aria-label={t('rule.escalate')} onChange={(escalate) => set({ escalate, ...(escalate ? {} : { again: false }) })} />
            <span>
              <span>{t('rule.escalate')}</span>
              <span className="fw-pls-sub">{t('rule.escalateHint')}</span>
            </span>
          </label>
          {draft.escalate && (
            <div className="fw-pls-form">
              <Field label={t('rule.after')} error={fieldError('escalateAfterMinutes')}>
                <NumberStepper value={draft.escalateAfterMinutes} min={ROUTING_LIMITS.minMinutes} max={ROUTING_LIMITS.maxMinutes} suffix={t('rule.min')} disabled={disabled} onChange={(next) => set({ escalateAfterMinutes: next })} />
              </Field>
              <Field label={t('rule.escalateTo')} hint={pickerNote ?? undefined} error={fieldError('escalateToId')}>
                {pickers.status === 'ready' && !disabled ? (
                  <Combobox
                    options={personOptions(pickers, { id: draft.escalateToId, name: draft.escalateToName })}
                    value={draft.escalateToId ?? ''}
                    placeholder={t('rule.choosePerson')}
                    onChange={(id) => set({ escalateToId: id || null, escalateToName: personOptions(pickers, { id: draft.escalateToId, name: draft.escalateToName }).find((entry) => entry.value === id)?.label ?? null })}
                  />
                ) : (
                  <PickerHolder pickers={pickers} name={draft.escalateToId ? draft.escalateToName : null} />
                )}
              </Field>
            </div>
          )}
          {draft.escalate && (
            <label className="fw-pls-toggle">
              <Toggle checked={draft.again} disabled={disabled} aria-label={t('rule.again')} onChange={(again) => set({ again })} />
              <span>
                <span>{t('rule.again')}</span>
                <span className="fw-pls-sub">{t('rule.againHint')}</span>
              </span>
            </label>
          )}
          {draft.escalate && draft.again && (
            <div className="fw-pls-form">
              <Field label={t('rule.againAfter')} error={fieldError('escalateAgainAfterMinutes')}>
                <NumberStepper value={draft.escalateAgainAfterMinutes} min={ROUTING_LIMITS.minMinutes} max={ROUTING_LIMITS.maxMinutes} suffix={t('rule.min')} disabled={disabled} onChange={(next) => set({ escalateAgainAfterMinutes: next })} />
              </Field>
              <Field label={t('rule.escalateAgainTo')} hint={pickerNote ?? undefined} error={fieldError('escalateAgainToId')}>
                {pickers.status === 'ready' && !disabled ? (
                  <Combobox
                    options={personOptions(pickers, { id: draft.escalateAgainToId, name: draft.escalateAgainToName })}
                    value={draft.escalateAgainToId ?? ''}
                    placeholder={t('rule.choosePerson')}
                    onChange={(id) => set({ escalateAgainToId: id || null, escalateAgainToName: personOptions(pickers, { id: draft.escalateAgainToId, name: draft.escalateAgainToName }).find((entry) => entry.value === id)?.label ?? null })}
                  />
                ) : (
                  <PickerHolder pickers={pickers} name={draft.escalateAgainToId ? draft.escalateAgainToName : null} />
                )}
              </Field>
            </div>
          )}
        </fieldset>
        <label className="fw-pls-toggle">
          <Toggle checked={draft.active} disabled={disabled} aria-label={t('rule.active')} onChange={(active) => set({ active })} />
          <span>
            <span>{t('rule.active')}</span>
            <span className="fw-pls-sub">{t('rule.activeHint')}</span>
          </span>
        </label>
        <div className="fw-pls-preview-box" role="group" aria-labelledby="fw-pls-rule-example">
          <h3 id="fw-pls-rule-example">{t('rule.example')}</h3>
          <Sentences live lines={draftExample(draft, classWords, site)} />
        </div>
      </div>
    </Modal>
  )
}

/** A picker that cannot be drawn: the value as read, and why (no people.view, still loading). */
function PickerHolder({ pickers, name }: { pickers: Pickers; name: string | null }) {
  const t = useSettingsWords()
  return (
    <p className="fw-pls-value">
      {pickers.status === 'loading' ? (
        <>
          <Spinner size={14} /> {t('rule.pickersLoading')}
        </>
      ) : (
        (name ?? t('rule.nobody'))
      )}
    </p>
  )
}

function RemoveRulesDialog({ dialog, depth, actions }: { dialog: Extract<DepthDialog, { kind: 'removeRules' }>; depth: DepthModel; actions?: DepthActions }) {
  const t = useSettingsWords() as Translate
  const rules = depth.routing.read.status === 'ready' ? depth.routing.read.value.rules.filter((rule) => dialog.ids.includes(rule.id)) : []
  const outcome = removeOutcome(rules)
  return (
    <Modal
      open
      onClose={() => actions?.onDialog?.(null)}
      title={t('routing.removeTitle', { count: rules.length })}
      size="md"
      footer={
        <>
          <Button onClick={() => actions?.onDialog?.(null)}>{t('rule.keep')}</Button>
          <Button variant="danger" heldReason={dialog.busy ? t('held.busy') : rules.length === 0 ? t('held.loading') : null} onClick={() => actions?.onRemoveConfirm?.()}>
            {t('routing.bulk.remove', { count: rules.length })}
          </Button>
        </>
      }
    >
      <div className="fw-pls-dialog">
        <ul className="fw-pls-example">
          {outcome.deleted > 0 && <li>{t('routing.removeDeleted', { count: outcome.deleted })}</li>}
          {outcome.switchedOff > 0 && <li>{t('routing.removeSwitched', { count: outcome.switchedOff })}</li>}
          {outcome.offAlready > 0 && <li>{t('routing.removeOffAlready', { count: outcome.offAlready })}</li>}
        </ul>
        <p className="fw-pls-hint">{t('routing.removeWhy')}</p>
        {dialog.problem && <Banner tone="danger" title={say(t, dialog.problem) ?? ''} />}
      </div>
    </Modal>
  )
}

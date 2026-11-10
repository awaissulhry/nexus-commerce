'use client'

import { useEffect, useMemo } from 'react'
import { Lock, Plus, Power, PowerOff, ShieldCheck } from 'lucide-react'
import { Banner, EmptyState, Field } from '@nexus/ui/components'
import { LawRef } from '@nexus/ui/components/LawRef/index'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Checkbox, Input, NumberStepper, Pill, SegmentedControl, Select, Toggle } from '@nexus/ui/primitives'
import type { ComplianceGate } from '@nexus/factory-domain/compliance/requirements/rules'
import { EditModeBar, Modal, Textarea, useDsWords } from '../../../../lib/i18n/ds-parts'
import { useLocale } from '../../../../lib/i18n/provider'
import { ListFrame } from '../../../../list-frame/ListFrame'
import type { GateRow } from '../api'
import {
  cellHeld,
  CHECKS_BY_KIND,
  COMPLIANCE_GATES,
  gateChangeOf,
  gateChanges,
  gateDraftOf,
  gatesApplyHeld,
  looseningsOf,
  missingSuggestions,
  nameIn,
  OPERATOR_ROLES,
  OVERRIDE_ROLES,
  PPE_CATEGORIES,
  PRODUCT_TYPES,
  reasonHeld,
  REQUIREMENT_KINDS,
  requirementHeld,
  switchesOff,
  switchHeld,
  valueOf,
  type GateDraft,
  type RequirementDraft,
} from '../model'
import type { GatesActions, GatesState, RulesMarketsActions, RulesMarketsModel } from '../view-model'
import { PAGE_KEYS, SectionFailed, SectionHead, SectionLoading, WriteProblem, useWords } from './parts'

/** One matrix row with the person's draft (a new object when the draft moves, so its cells draw again). */
interface GateLine {
  readonly id: string
  readonly row: GateRow
  readonly draft: GateDraft
  readonly change: ReturnType<typeof gateChangeOf>
}

/**
 * Gates (design rm-gates; PRD-272; B-W2b-254's requirements): which requirement blocks what — the matrix of requirements ×
 * the four places (work-order release, label print, final release, shipment), the law's padlocks with their reason, who may
 * override a soft gate and for how long, and each requirement's switch (off with the question it waits for). The two W1 gates are
 * the CERT-COVERAGE row (built in until written). One save model: the EditModeBar (⌘S); tightening applies at once, a looser
 * change (a gate no longer blocked, a role or more days to override, switched off) asks "Confirm a looser rule" in words
 * (rm-loosen) and then a fresh code. Add requirement offers the rows the later checks wait for, each OFF until switched on.
 */
export function GatesTab({ model, state, actions, onHelp }: { model: RulesMarketsModel; state: GatesState | undefined; actions?: RulesMarketsActions | undefined; onHelp: () => void }) {
  const t = useWords()
  const ds = useDsWords()
  const locale = useLocale()
  const matrix = state ? valueOf(state.matrix) : null
  const offline = model.live === 'offline'
  const lines = useMemo<GateLine[] | null>(
    () => (matrix ? matrix.rows.map((row) => ({ id: row.requirement.code, row, draft: state?.drafts[row.requirement.code] ?? gateDraftOf(row), change: gateChangeOf(row, state?.drafts[row.requirement.code]) })) : null),
    [matrix, state?.drafts],
  )
  const selected = state?.selected ?? []
  useEffect(() => {
    if (lines && selected.some((code) => !lines.some((line) => line.id === code))) actions?.gates?.onSelected?.(selected.filter((code) => lines.some((line) => line.id === code)))
  }, [lines, selected, actions])

  const columns = useMemo<ColDef<GateLine>[]>(() => {
    const RequirementCell = ({ data }: ICellRendererParams<GateLine>) => {
      if (!data) return null
      const requirement = data.row.requirement
      const explanation = requirement.explanationI18n[locale] ?? requirement.explanationI18n.en ?? nameIn(requirement, locale)
      return (
        <span className="fw-rm-cell">
          <span className="fw-rm-strong">{nameIn(requirement, locale)}</span>
          <span className="fw-rm-muted">
            {requirement.code} · {requirement.check === 'MANUAL' ? t('gates.manual') : t('gates.computed', { check: requirement.check })}
            {requirement.builtIn ? ` · ${t('gates.builtIn')}` : ''}
          </span>
          <LawRef law={requirement.legalReference} plain={explanation} href={requirement.regulation?.link ?? null} labels={ds.lawRef} />
        </span>
      )
    }
    const CoversCell = ({ data }: ICellRendererParams<GateLine>) => {
      if (!data) return null
      const requirement = data.row.requirement
      const parts = [
        requirement.marketCode ? t('gates.market', { market: requirement.marketCode }) : t('gates.everyMarket'),
        requirement.ppeCategories.length > 0 ? requirement.ppeCategories.map((category) => t(`category.${category}`)).join(', ') : t('gates.everyCategory'),
        ...(requirement.productTypes.length > 0 ? [requirement.productTypes.map((type) => t(`productType.${type}`)).join(', ')] : []),
        requirement.companyId ? t('gates.oneCompany') : t('gates.everyCompany'),
      ]
      return <span className="fw-rm-cell fw-rm-muted">{parts.join(' · ')}</span>
    }
    const gateColumn = (gate: ComplianceGate): ColDef<GateLine> => ({
      colId: gate,
      headerName: t(`gate.${gate}`),
      minWidth: 118,
      flex: 0.8,
      wrapHeaderText: true,
      autoHeaderHeight: true,
      valueGetter: (params) => (params.data ? (params.data.draft.blocks.includes(gate) ? t('gates.blocks') : t('gates.passes')) : ''),
      cellRenderer: ({ data }: ICellRendererParams<GateLine>) => {
        if (!data) return null
        const requirement = data.row.requirement
        if (requirement.lockedBlocks.includes(gate)) {
          return (
            <span className="fw-rm-lock" title={t('gates.lockedWhy', { law: requirement.legalReference })}>
              <Lock size={13} aria-hidden /> <span>{t('gates.locked')}</span>
            </span>
          )
        }
        const blocks = data.draft.blocks.includes(gate)
        const held = cellHeld(data.row, gate, offline)
        const label = t('gates.toggle', { gate: t(`gate.${gate}`), code: requirement.code })
        const moved = blocks !== requirement.blocks.includes(gate)
        return (
          <span className="fw-rm-cell-row">
            {held && held !== 'held.offline' ? (
              <span className={blocks ? 'fw-rm-strong' : 'fw-rm-muted'} title={t(held)}>
                {blocks ? t('gates.blocks') : t('gates.passes')}
              </span>
            ) : (
              <>
                <Toggle size="xs" checked={blocks} disabled={!!held} title={held ? t(held) : undefined} aria-label={label} onChange={(next) => actions?.gates?.onCell?.(requirement.code, gate, next)} />
                <span className={blocks ? undefined : 'fw-rm-muted'}>{blocks ? t('gates.blocks') : '—'}</span>
              </>
            )}
            {moved && <Pill tone="info">{t('gates.changed')}</Pill>}
          </span>
        )
      },
    })
    const OverrideCell = ({ data }: ICellRendererParams<GateLine>) => {
      if (!data) return null
      const roles = data.draft.overrideRoleKeys
      const held = data.row.requirement.builtIn ? 'held.builtIn' : !data.row.mayLoosen ? 'held.requirementsManage' : null
      return (
        <span className="fw-rm-cell">
          <span>{roles.length === 0 ? t('gates.nobody') : roles.map((role) => roleName(t, role)).join(', ')}</span>
          {roles.length > 0 && <span className="fw-rm-muted">{t('gates.upTo', { count: data.draft.overrideMaxDays })}</span>}
          <Button size="sm" variant="quiet" heldReason={held ? t(held) : null} onClick={() => actions?.gates?.onOverride?.(data.id)}>
            {t('gates.overrideChange')}
          </Button>
        </span>
      )
    }
    const SwitchCell = ({ data }: ICellRendererParams<GateLine>) => {
      if (!data) return null
      const requirement = data.row.requirement
      if (requirement.lockedBlocks.length > 0) return <span className="fw-rm-muted">{t('gates.alwaysOn')}</span>
      const held = switchHeld(data.row, offline)
      return (
        <span className="fw-rm-cell">
          <span className="fw-rm-cell-row">
            {held && held !== 'held.offline' ? null : <Toggle size="xs" checked={data.draft.switchedOn} disabled={!!held} title={held ? t(held) : undefined} aria-label={t('gates.switchOf', { code: requirement.code })} onChange={(next) => actions?.gates?.onSwitch?.(requirement.code, next)} />}
            <span title={held && held !== 'held.offline' ? t(held) : undefined}>{data.draft.switchedOn ? t('gates.on') : t('gates.off')}</span>
            {data.change.switched && <Pill tone="info">{t('gates.changed')}</Pill>}
          </span>
          {!data.draft.switchedOn && requirement.offReason && !data.change.switched ? <span className="fw-rm-muted">{requirement.offReason}</span> : null}
        </span>
      )
    }
    return [
      { colId: 'requirement', headerName: t('gates.col.requirement'), minWidth: 260, flex: 2.2, valueGetter: (params) => (params.data ? `${params.data.row.requirement.code} ${nameIn(params.data.row.requirement, locale)}` : ''), cellRenderer: RequirementCell, autoHeight: true, wrapText: true },
      { colId: 'covers', headerName: t('gates.col.covers'), minWidth: 170, flex: 1.2, valueGetter: (params) => params.data?.row.requirement.marketCode ?? '', cellRenderer: CoversCell, autoHeight: true, wrapText: true },
      ...COMPLIANCE_GATES.map(gateColumn),
      { colId: 'override', headerName: t('gates.col.override'), minWidth: 170, flex: 1.1, wrapHeaderText: true, autoHeaderHeight: true, valueGetter: (params) => (params.data ? params.data.draft.overrideRoleKeys.join(', ') : ''), cellRenderer: OverrideCell, autoHeight: true },
      { colId: 'switch', headerName: t('gates.col.switch'), minWidth: 150, flex: 1, wrapHeaderText: true, autoHeaderHeight: true, valueGetter: (params) => (params.data ? (params.data.draft.switchedOn ? t('gates.on') : t('gates.off')) : ''), cellRenderer: SwitchCell, autoHeight: true, wrapText: true },
    ]
  }, [t, ds, locale, offline, actions])

  const changes = matrix && state ? gateChanges(matrix.rows, state.drafts) : 0
  const loosenings = matrix && state ? looseningsOf(matrix.rows, state.drafts) : []
  const applyHeld = gatesApplyHeld({ changes, busy: state?.writing.busy ?? false, offline })
  const builtIn = matrix?.rows.find((row) => row.requirement.builtIn) ?? null
  const picked = (lines ?? []).filter((line) => selected.includes(line.id))
  const addHeld = model.can.requirementsManage && (matrix?.mayManage ?? true) ? (offline ? t('held.offline') : null) : t('held.requirementsManage')

  const head = (
    <SectionHead id="fw-rm-gates" title={t('gates.title')} note={t('gates.note')}>
      {builtIn && model.can.requirementsManage && (
        <Button size="sm" heldReason={state?.writing.busy ? t('held.busy') : null} onClick={() => actions?.gates?.onWriteW1?.()}>
          {t('gates.writeW1')}
        </Button>
      )}
      <Button size="sm" variant="primary" aria-keyshortcuts="c" heldReason={addHeld} onClick={() => actions?.onAddress?.({ add: true })}>
        <Plus size={14} aria-hidden /> {t('gates.add')}
      </Button>
    </SectionHead>
  )

  if (!state || state.matrix.status === 'loading') {
    return (
      <section className="fw-rm-section" aria-labelledby="fw-rm-gates">
        {head}
        <SectionLoading rows={6} />
      </section>
    )
  }
  if (state.matrix.status === 'error') {
    return (
      <section className="fw-rm-section" aria-labelledby="fw-rm-gates">
        {head}
        <SectionFailed title={t('gates.failed')} problem={state.matrix.problem} onRetry={actions?.gates?.onRetry} />
      </section>
    )
  }

  return (
    <section className="fw-rm-section" aria-labelledby="fw-rm-gates">
      {head}
      {!model.can.requirementsManage && <p className="fw-rm-held">{t('held.requirementsManage')}</p>}
      {builtIn && <p className="fw-rm-muted">{t('gates.builtInNote')}</p>}
      {state.writing.problem && !state.loosen && !state.add && <WriteProblem writing={state.writing} />}
      <ListFrame<GateLine>
        label={t('gates.title')}
        title={t('gates.title')}
        listKey="compliance.settings.gates"
        rows={lines}
        rowId={(line) => line.id}
        columns={columns}
        count={t('gates.count', { count: lines?.length ?? 0 })}
        selection={
          model.can.requirementsManage
            ? {
                selected,
                onChange: (codes) => actions?.gates?.onSelected?.(codes),
                actions: (
                  <>
                    <Button size="sm" variant="primary" aria-label={t('gates.switchOnMany', { count: picked.length })} onClick={() => actions?.gates?.onBulkSwitch?.(picked.map((line) => line.id), true)}>
                      <Power size={13} aria-hidden /> <SelectionLabel>{t('gates.switchOnMany', { count: picked.length })}</SelectionLabel>
                    </Button>
                    <Button size="sm" aria-label={t('gates.switchOffMany', { count: picked.length })} onClick={() => actions?.gates?.onBulkSwitch?.(picked.map((line) => line.id), false)}>
                      <PowerOff size={13} aria-hidden /> <SelectionLabel>{t('gates.switchOffMany', { count: picked.length })}</SelectionLabel>
                    </Button>
                  </>
                ),
              }
            : undefined
        }
        isRowSelectable={model.can.requirementsManage ? (line) => (switchHeld(line.row) ? t(switchHeld(line.row)!) : null) : undefined}
        keys={PAGE_KEYS(t)}
        onHelp={onHelp}
        state={lines && lines.length === 0 ? <EmptyState icon={<ShieldCheck size={22} aria-hidden />} title={t('gates.emptyTitle')} description={t('gates.empty')} /> : undefined}
        cards={{ fields: { requirement: { role: 'title' }, covers: { role: 'subtitle' }, switch: { role: 'aside' } } }}
      />
      {changes > 0 && (
        <EditModeBar
          count={changes}
          busy={state.writing.busy}
          applyHeldReason={applyHeld && applyHeld !== 'held.busy' ? t(applyHeld) : null}
          applyLabel={loosenings.length > 0 ? t('gates.applyLoosen') : t('common.apply')}
          onDiscard={() => actions?.gates?.onDiscard?.()}
          onApply={() => actions?.gates?.onApply?.()}
          saveShortcut
        />
      )}
      {state.loosen && matrix && <LoosenGates state={state} actions={actions?.gates} switchingOff={switchesOff(matrix.rows, state.drafts)} loosenings={loosenings} />}
      {state.override && <OverrideDialog state={state} actions={actions?.gates} />}
      {state.add && <AddRequirementDialog state={state} actions={actions} />}
    </section>
  )
}

type T = ReturnType<typeof useWords>
const KNOWN_ROLES: readonly string[] = OVERRIDE_ROLES
/** A role's name (an office template's), else its key (a custom role). */
export const roleName = (t: T, role: string): string => (KNOWN_ROLES.includes(role) ? t(`role.${role}`) : role)

/** Confirm a looser rule (rm-loosen): each "From now on …" per requirement; switching off asks why; Apply then asks a fresh code. */
function LoosenGates({ state, actions, switchingOff, loosenings }: { state: GatesState; actions?: GatesActions | undefined; switchingOff: string[]; loosenings: ReturnType<typeof looseningsOf> }) {
  const t = useWords()
  const reason = state.loosen?.reason ?? ''
  const held = state.writing.busy ? t('held.busy') : switchingOff.length > 0 && reasonHeld(reason) ? t(reasonHeld(reason)!) : null
  return (
    <Modal
      open
      onClose={() => actions?.onCancel?.()}
      title={t('loosen.title')}
      size="md"
      footer={
        <>
          <Button onClick={() => actions?.onCancel?.()}>{t('common.cancel')}</Button>
          <Button variant="primary" heldReason={held} onClick={() => actions?.onConfirm?.()}>
            {t('loosen.apply')}
          </Button>
        </>
      }
    >
      <div className="fw-rm-form">
        {loosenings.map((entry) => (
          <div key={entry.code} className="fw-rm-stack-tight">
            <b>{entry.code}</b>
            <ul className="fw-rm-lines">
              {entry.lines.map((line, index) => (
                <li key={`${line.code}-${index}`}>{t(`loosen.code.${line.code}`, { ...line.params, gate: line.params.gate ? t(`gate.${line.params.gate}`) : '', role: line.params.role ? roleName(t, String(line.params.role)) : '' })}</li>
              ))}
            </ul>
          </div>
        ))}
        <p className="fw-rm-muted">{t('loosen.stepUpNote')}</p>
        {switchingOff.length > 0 && (
          <Field label={t('loosen.offReason', { codes: switchingOff.join(', ') })} hint={t('loosen.offReasonHint')} required>
            <Textarea value={reason} rows={3} maxLength={500} onChange={(event) => actions?.onReason?.(event.target.value)} />
          </Field>
        )}
        <WriteProblem writing={state.writing} />
      </div>
    </Modal>
  )
}

/** Who may override a soft gate of one requirement, and for how many days (at most 7); never at a padlock. */
function OverrideDialog({ state, actions }: { state: GatesState; actions?: GatesActions | undefined }) {
  const t = useWords()
  const override = state.override!
  const custom = override.roles.filter((role) => !KNOWN_ROLES.includes(role))
  const toggle = (role: string, on: boolean) => actions?.onOverrideDraft?.(on ? [...override.roles, role] : override.roles.filter((entry) => entry !== role), override.days)
  return (
    <Modal
      open
      onClose={() => actions?.onOverride?.(null)}
      title={t('override.title', { code: override.code })}
      subtitle={t('override.subtitle')}
      size="md"
      footer={
        <>
          <Button onClick={() => actions?.onOverride?.(null)}>{t('common.cancel')}</Button>
          <Button variant="primary" onClick={() => actions?.onOverrideKeep?.()}>
            {t('override.keep')}
          </Button>
        </>
      }
    >
      <div className="fw-rm-form">
        <fieldset className="fw-rm-choices">
          <legend className="fw-rm-question">{t('override.roles')}</legend>
          <div className="fw-rm-ticks">
            {[...KNOWN_ROLES, ...custom].map((role) => (
              <Checkbox key={role} label={roleName(t, role)} checked={override.roles.includes(role)} onChange={(event) => toggle(role, event.target.checked)} />
            ))}
          </div>
        </fieldset>
        <Field label={t('override.days')} hint={t('override.daysHint')}>
          <NumberStepper value={override.days} min={1} max={7} onChange={(days) => actions?.onOverrideDraft?.([...override.roles], Math.max(1, Math.min(7, days)))} aria-label={t('override.days')} />
        </Field>
        <p className="fw-rm-muted">{t('override.note')}</p>
      </div>
    </Modal>
  )
}

/** Add requirement: the rows the later checks wait for (each OFF with the reason), or one of the person's own. */
function AddRequirementDialog({ state, actions }: { state: GatesState; actions?: RulesMarketsActions | undefined }) {
  const t = useWords()
  const locale = useLocale()
  const add = state.add!
  const close = () => actions?.onAddress?.({ add: false })
  const requirements = valueOf(add.requirements)
  const missing = requirements ? missingSuggestions(requirements) : []
  const draft = add.draft
  const set = (next: Partial<RequirementDraft>) => actions?.gates?.onAddDraft?.({ ...draft, ...next })
  const held = add.writing.busy
    ? t('held.busy')
    : add.way === 'suggested'
      ? add.picked.length === 0
        ? t('held.pick')
        : reasonHeld(add.reason)
          ? t(reasonHeld(add.reason)!)
          : null
      : requirementHeld(draft)
        ? t(requirementHeld(draft)!)
        : null
  const markets = valueOf(add.markets) ?? []
  const listOf = <V extends string>(list: readonly V[], value: V, on: boolean): V[] => (on ? [...list, value] : list.filter((entry) => entry !== value))
  return (
    <Modal
      open
      onClose={close}
      title={t('add.requirementTitle')}
      size="lg"
      footer={
        <>
          <Button onClick={close}>{t('common.cancel')}</Button>
          <Button variant="primary" heldReason={held} onClick={() => actions?.gates?.onAddSave?.()}>
            {add.way === 'suggested' ? t('add.suggestedSave', { count: add.picked.length }) : t('add.ownSave')}
          </Button>
        </>
      }
    >
      <div className="fw-rm-form">
        <SegmentedControl
          size="sm"
          ariaLabel={t('add.way')}
          value={add.way}
          onChange={(value) => actions?.gates?.onAddWay?.(value as 'suggested' | 'own')}
          options={[
            { value: 'suggested', label: t('add.suggested') },
            { value: 'own', label: t('add.own') },
          ]}
        />
        {add.way === 'suggested' ? (
          add.requirements.status === 'loading' ? (
            <SectionLoading rows={3} />
          ) : add.requirements.status === 'error' ? (
            <SectionFailed title={t('add.failed')} problem={add.requirements.problem} onRetry={() => actions?.gates?.onAddWay?.('suggested')} />
          ) : missing.length === 0 ? (
            <p className="fw-rm-muted">{t('add.noSuggestions')}</p>
          ) : (
            <>
              <p className="fw-rm-muted">{t('add.suggestedNote')}</p>
              <ul className="fw-rm-picks">
                {missing.map((entry) => (
                  <li key={entry.code}>
                    <Checkbox
                      checked={add.picked.includes(entry.code)}
                      onChange={(event) => actions?.gates?.onAddPick?.(listOf(add.picked, entry.code, event.target.checked))}
                      label={
                        <span className="fw-rm-cell">
                          <span className="fw-rm-strong">{entry.name[locale === 'it' ? 'it' : 'en']}</span>
                          <span className="fw-rm-muted">
                            {entry.code} · {entry.checkKey} · {entry.blocks.map((gate) => t(`gate.${gate}`)).join(', ')} · {entry.legalReference}
                          </span>
                        </span>
                      }
                    />
                  </li>
                ))}
              </ul>
              <Field label={t('add.offReason')} hint={t('add.offReasonHint')} required>
                <Textarea value={add.reason} rows={2} maxLength={500} onChange={(event) => actions?.gates?.onAddReason?.(event.target.value)} />
              </Field>
            </>
          )
        ) : (
          <div className="fw-rm-form-grid">
            <Field label={t('field.code')} required>
              <Input size="sm" value={draft.code} maxLength={60} onChange={(event) => set({ code: event.target.value })} />
            </Field>
            <Field label={t('field.kind')} required>
              <Select size="sm" value={draft.kind ?? ''} onChange={(event) => set({ kind: (event.target.value || null) as RequirementDraft['kind'], checkKey: '', operatorRole: null })}>
                <option value="">{t('common.choose')}</option>
                {REQUIREMENT_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {t(`kind.${kind}`)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('field.nameIt')}>
              <Input size="sm" value={draft.nameIt} maxLength={300} onChange={(event) => set({ nameIt: event.target.value })} />
            </Field>
            <Field label={t('field.nameEn')}>
              <Input size="sm" value={draft.nameEn} maxLength={300} onChange={(event) => set({ nameEn: event.target.value })} />
            </Field>
            <Field label={t('field.checkKey')} hint={t('add.checkHint')}>
              <Select size="sm" value={draft.checkKey} onChange={(event) => set({ checkKey: event.target.value })} disabled={!draft.kind}>
                <option value="">{draft.kind && CHECKS_BY_KIND[draft.kind].length === 0 ? t('add.manualCheck') : t('add.kindCheck')}</option>
                {(draft.kind ? CHECKS_BY_KIND[draft.kind] : []).map((key) => (
                  <option key={key} value={key}>
                    {key}
                  </option>
                ))}
              </Select>
            </Field>
            {draft.kind === 'OPERATOR_ROLE' && (
              <Field label={t('field.operatorRole')} required>
                <Select size="sm" value={draft.operatorRole ?? ''} onChange={(event) => set({ operatorRole: (event.target.value || null) as RequirementDraft['operatorRole'] })}>
                  <option value="">{t('common.choose')}</option>
                  {OPERATOR_ROLES.map((role) => (
                    <option key={role} value={role}>
                      {t(`operatorRole.${role}`)}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            <Field label={t('field.marketCode')}>
              <Select size="sm" value={draft.marketCode ?? ''} onChange={(event) => set({ marketCode: event.target.value || null })}>
                <option value="">{t('gates.everyMarket')}</option>
                {markets.map((code) => (
                  <option key={code} value={code}>
                    {code}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('field.legalReference')} required>
              <Input size="sm" value={draft.legalReference} maxLength={300} onChange={(event) => set({ legalReference: event.target.value })} />
            </Field>
            <fieldset className="fw-rm-choices fw-rm-span">
              <legend className="fw-rm-question">{t('field.blocks')}</legend>
              <div className="fw-rm-ticks">
                {COMPLIANCE_GATES.map((gate) => (
                  <Checkbox key={gate} label={t(`gate.${gate}`)} checked={draft.blocks.includes(gate)} onChange={(event) => set({ blocks: listOf(draft.blocks, gate, event.target.checked) })} />
                ))}
              </div>
            </fieldset>
            <fieldset className="fw-rm-choices fw-rm-span">
              <legend className="fw-rm-question">{t('field.ppeCategories')}</legend>
              <div className="fw-rm-ticks">
                {PPE_CATEGORIES.map((category) => (
                  <Checkbox key={category} label={t(`category.${category}`)} checked={draft.ppeCategories.includes(category)} onChange={(event) => set({ ppeCategories: listOf(draft.ppeCategories, category, event.target.checked) })} />
                ))}
              </div>
            </fieldset>
            <fieldset className="fw-rm-choices fw-rm-span">
              <legend className="fw-rm-question">{t('field.productTypes')}</legend>
              <div className="fw-rm-ticks">
                {PRODUCT_TYPES.map((type) => (
                  <Checkbox key={type} label={t(`productType.${type}`)} checked={draft.productTypes.includes(type)} onChange={(event) => set({ productTypes: listOf(draft.productTypes, type, event.target.checked) })} />
                ))}
              </div>
            </fieldset>
            <fieldset className="fw-rm-choices fw-rm-span">
              <legend className="fw-rm-question">{t('override.roles')}</legend>
              <div className="fw-rm-ticks">
                {OVERRIDE_ROLES.map((role) => (
                  <Checkbox key={role} label={roleName(t, role)} checked={draft.overrideRoleKeys.includes(role)} onChange={(event) => set({ overrideRoleKeys: listOf(draft.overrideRoleKeys, role, event.target.checked) })} />
                ))}
              </div>
            </fieldset>
            <Field label={t('override.days')}>
              <NumberStepper value={draft.overrideMaxDays} min={1} max={7} onChange={(days) => set({ overrideMaxDays: Math.max(1, Math.min(7, days)) })} aria-label={t('override.days')} />
            </Field>
            <Field label={t('field.switchedOn')} hint={t('add.switchHint')}>
              <span className="fw-rm-cell-row">
                <Toggle checked={draft.switchedOn} aria-label={t('field.switchedOn')} onChange={(next) => set({ switchedOn: next })} />
                <span>{draft.switchedOn ? t('gates.on') : t('gates.off')}</span>
              </span>
            </Field>
            {!draft.switchedOn && (
              <div className="fw-rm-span">
                <Field label={t('add.offReason')} required>
                  <Textarea value={draft.offReason} rows={2} maxLength={500} onChange={(event) => set({ offReason: event.target.value })} />
                </Field>
              </div>
            )}
          </div>
        )}
        <Banner tone="info" title={t('add.everyCompany')} />
        <WriteProblem writing={add.writing} />
      </div>
    </Modal>
  )
}

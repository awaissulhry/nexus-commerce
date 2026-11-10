'use client'

import { useEffect, useMemo, useRef } from 'react'
import { CalendarX, Plus, Users } from 'lucide-react'
import { EmptyState, Field } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Input, Pill, RadioCard, Select } from '@nexus/ui/primitives'
import { DateField, Modal, Textarea } from '../../../../lib/i18n/ds-parts'
import { useLocale } from '../../../../lib/i18n/provider'
import { ListFrame } from '../../../../list-frame/ListFrame'
import type { Operator, PartyChoice } from '../api'
import { markKey, OPERATOR_ROLES, OPERATOR_SCOPES, operatorHeld, operatorTarget, valueOf, type OperatorCell, type OperatorDraft } from '../model'
import type { OperatorPickers, OperatorWindowState, OperatorsState, RulesMarketsActions, RulesMarketsModel } from '../view-model'
import { PAGE_KEYS, SaveMark, SectionFailed, SectionHead, SectionLoading, WriteProblem, useDay, useWords } from './parts'

const typing = () => (params: { event: KeyboardEvent; editing: boolean }) => {
  const event = params.event
  if (params.editing || event.metaKey || event.ctrlKey || event.altKey) return false
  return event.key.length === 1 && event.key !== ' '
}
const dayLocale = (locale: string) => (locale === 'it' ? 'it-IT' : 'en-GB')
const partyLabel = (party: PartyChoice) => `${party.code} · ${party.tradeName ?? party.legalName}`

/**
 * Operators (design rm-operators; PRD-298; B-W2b-249): who is the maker, authorised representative, importer, distributor or
 * fulfilment provider of a style, a brand's private-label styles, a company's styles or every style — per market or for every
 * market — with the name, postal address and contact exactly as labels and DoCs print them, and the days the row holds. The
 * most specific row wins (style → brand → company → every style; the market's before every market's); a brand's maker row
 * does not apply to a brand style sold under our name (Owner Q3). Printed words autosave per cell; End N today ends rows (a
 * row is never removed); the row's window changes its party, words and days.
 */
export function OperatorsTab({ model, state, actions, onHelp }: { model: RulesMarketsModel; state: OperatorsState | undefined; actions?: RulesMarketsActions | undefined; onHelp: () => void }) {
  const t = useWords()
  const day = useDay()
  const { address } = model
  const answer = state ? valueOf(state.operators) : null
  const canManage = model.can.rulesManage && (answer?.mayManage ?? true)
  const offline = model.live === 'offline'
  const editable = canManage && !offline
  const latest = useRef({ marks: state?.marks ?? {}, actions })
  latest.current = { marks: state?.marks ?? {}, actions }
  const selected = state?.selected ?? []
  const q = address.q.trim().toLowerCase()
  const rows = useMemo(() => (answer ? answer.operators.filter((row) => q === '' || `${row.printedName} ${row.printedAddress} ${row.style?.code ?? ''} ${row.brand?.name ?? ''} ${row.party?.name ?? ''}`.toLowerCase().includes(q)) : null), [answer, q])
  useEffect(() => {
    if (rows && selected.some((id) => !rows.some((row) => row.id === id))) actions?.operators?.onSelected?.(selected.filter((id) => rows.some((row) => row.id === id)))
  }, [rows, selected, actions])

  const columns = useMemo<ColDef<Operator>[]>(() => {
    const mark = (id: string, field: string) => latest.current.marks[markKey(id, field)]
    const text = (field: OperatorCell, header: string, flex: number): ColDef<Operator> => ({
      colId: field,
      headerName: header,
      minWidth: 160,
      flex,
      wrapText: true,
      autoHeight: true,
      valueGetter: (params) => (params.data ? (params.data[field] ?? '') : ''),
      ...(editable ? { editable: true, cellEditor: field === 'printedAddress' ? 'agLargeTextCellEditor' : 'agTextCellEditor', cellEditorPopup: field === 'printedAddress', cellEditorParams: { maxLength: field === 'printedAddress' ? 500 : 200 } } : {}),
      suppressKeyboardEvent: typing(),
      valueSetter: (params) => {
        if (params.data) latest.current.actions?.operators?.onCell?.(params.data.id, field, String(params.newValue ?? ''))
        return false
      },
      cellRenderer: ({ data }: ICellRendererParams<Operator>) =>
        data ? (
          <span className="fw-rm-cell-row">
            <span className={data[field] ? 'fw-rm-pre' : 'fw-rm-muted'}>{data[field] || '—'}</span>
            <SaveMark mark={mark(data.id, field)} />
          </span>
        ) : null,
    })
    return [
      {
        colId: 'target',
        headerName: t('operators.col.target'),
        minWidth: 190,
        flex: 1.2,
        autoHeight: true,
        valueGetter: (params) => (params.data ? (operatorTarget(params.data).label ?? t(`level.${params.data.level}`)) : ''),
        cellRenderer: ({ data }: ICellRendererParams<Operator>) => {
          if (!data) return null
          const target = operatorTarget(data)
          return (
            <span className="fw-rm-cell">
              <span>{target.label ?? t(`level.${data.level}`)}</span>
              <span className="fw-rm-muted">{t(`levelWhat.${data.level}`)}</span>
            </span>
          )
        },
      },
      { colId: 'market', headerName: t('operators.col.market'), minWidth: 110, flex: 0.6, valueGetter: (params) => (params.data ? (params.data.marketCode ?? t('operators.everyMarket')) : '') },
      { colId: 'role', headerName: t('operators.col.role'), minWidth: 160, flex: 1, valueGetter: (params) => (params.data ? t(`operatorRole.${params.data.role}`) : '') },
      { colId: 'party', headerName: t('operators.col.party'), minWidth: 160, flex: 1, valueGetter: (params) => (params.data ? (params.data.party ? `${params.data.party.code} · ${params.data.party.name}` : t('operators.ourCompany')) : '') },
      text('printedName', t('operators.col.printedName'), 1.2),
      text('printedAddress', t('operators.col.printedAddress'), 1.6),
      text('contact', t('operators.col.contact'), 1),
      {
        colId: 'valid',
        headerName: t('operators.col.valid'),
        minWidth: 170,
        flex: 1,
        autoHeight: true,
        valueGetter: (params) => (params.data ? `${params.data.validFrom} ${params.data.validTo ?? ''}` : ''),
        cellRenderer: ({ data }: ICellRendererParams<Operator>) =>
          data ? (
            <span className="fw-rm-cell">
              <span>{data.validTo ? t('operators.fromTo', { from: day(data.validFrom), to: day(data.validTo) }) : t('operators.from', { from: day(data.validFrom) })}</span>
              <Pill tone={data.validOnDay ? 'success' : 'neutral'}>{data.validOnDay ? t('operators.validToday') : t('operators.notToday')}</Pill>
            </span>
          ) : null,
      },
    ]
  }, [t, day, editable])

  const endable = (rows ?? []).filter((row) => selected.includes(row.id) && (row.validTo === null || row.validTo > model.today) && row.validFrom <= model.today)
  const addHeld = canManage ? (offline ? t('held.offline') : null) : t('held.rulesManage')
  const filtered = !!(address.q || address.role || address.market)
  const filters = (
    <span className="fw-rm-row">
      <Select size="sm" value={address.role ?? ''} aria-label={t('operators.filterRole')} onChange={(event) => actions?.onAddress?.({ role: (event.target.value || null) as never })}>
        <option value="">{t('operators.allRoles')}</option>
        {OPERATOR_ROLES.map((role) => (
          <option key={role} value={role}>
            {t(`operatorRole.${role}`)}
          </option>
        ))}
      </Select>
      <Select size="sm" value={address.market ?? ''} aria-label={t('operators.filterMarket')} onChange={(event) => actions?.onAddress?.({ market: event.target.value || null })}>
        <option value="">{t('operators.allMarkets')}</option>
        {(state?.markets ?? []).map((code) => (
          <option key={code} value={code}>
            {code}
          </option>
        ))}
      </Select>
    </span>
  )

  return (
    <>
      <section className="fw-rm-section" aria-labelledby="fw-rm-operators">
        <SectionHead id="fw-rm-operators" title={t('operators.title')} note={t('operators.note')}>
          <Button size="sm" variant="primary" aria-keyshortcuts="c" heldReason={addHeld} onClick={() => actions?.onAddress?.({ add: true })}>
            <Plus size={14} aria-hidden /> {t('operators.add')}
          </Button>
        </SectionHead>
        {!state || state.operators.status === 'loading' ? (
          <SectionLoading rows={6} />
        ) : state.operators.status === 'error' ? (
          <SectionFailed title={t('operators.failed')} problem={state.operators.problem} onRetry={actions?.operators?.onRetry} />
        ) : (
          <ListFrame<Operator>
            label={t('operators.title')}
            title={t('operators.title')}
            listKey="compliance.settings.operators"
            rows={rows}
            rowId={(row) => row.id}
            columns={columns}
            count={t('operators.count', { count: rows?.length ?? 0 })}
            search={<Input size="sm" type="search" value={address.q} placeholder={t('operators.search')} aria-label={t('operators.search')} onChange={(event) => actions?.onAddress?.({ q: event.target.value })} />}
            tools={filters}
            selection={
              canManage
                ? {
                    selected,
                    onChange: (ids) => actions?.operators?.onSelected?.(ids),
                    actions: (
                      <Button size="sm" aria-label={t('operators.endMany', { count: endable.length })} heldReason={endable.length === 0 ? t('held.noneEndable') : offline ? t('held.offline') : null} onClick={() => actions?.operators?.onEndMany?.(endable.map((row) => row.id))}>
                        <CalendarX size={13} aria-hidden /> <SelectionLabel>{t('operators.endMany', { count: endable.length })}</SelectionLabel>
                      </Button>
                    ),
                  }
                : undefined
            }
            keys={PAGE_KEYS(t)}
            onHelp={onHelp}
            onOpen={(row) => actions?.onAddress?.({ open: row.id })}
            state={
              rows && rows.length === 0 ? (
                filtered ? (
                  <EmptyState
                    icon={<Users size={22} aria-hidden />}
                    title={t('operators.noneFiltered')}
                    action={
                      <Button size="sm" onClick={() => actions?.onAddress?.({ q: '', role: null, market: null })}>
                        {t('common.clearFilters')}
                      </Button>
                    }
                  />
                ) : (
                  <EmptyState icon={<Users size={22} aria-hidden />} title={t('operators.emptyTitle')} description={t('operators.empty')} />
                )
              ) : undefined
            }
            cards={{ fields: { target: { role: 'title' }, role: { role: 'subtitle' }, valid: { role: 'aside' } } }}
          />
        )}
      </section>
      {state?.add && <NewOperatorDialog model={model} state={state} actions={actions} />}
      {state?.open && <OperatorWindow model={model} state={state} actions={actions} />}
    </>
  )
}

/** The party pickers (parties.view): the brand for a brand's row, the operator itself. */
function PartySelect({ label, value, read, onChange, none, held }: { label: string; value: string | null; read: OperatorPickers['parties']; onChange: (id: string | null) => void; none: string; held: string | null }) {
  const t = useWords()
  const parties = read && read.status === 'ready' ? read.value : []
  return (
    <Field label={label} hint={held ?? (read?.status === 'error' ? t(read.problem) : undefined)}>
      <Select size="sm" value={value ?? ''} disabled={!!held} onChange={(event) => onChange(event.target.value || null)}>
        <option value="">{read?.status === 'loading' ? t('common.reading') : none}</option>
        {parties.map((party) => (
          <option key={party.id} value={party.id}>
            {partyLabel(party)}
          </option>
        ))}
      </Select>
    </Field>
  )
}

/** New operator row: role, what it applies to, market, the operator (our company for a maker), the printed words, the days. */
function NewOperatorDialog({ model, state, actions }: { model: RulesMarketsModel; state: OperatorsState; actions?: RulesMarketsActions | undefined }) {
  const t = useWords()
  const locale = useLocale()
  const add = state.add!
  const draft = add.draft
  const pickers = add.pickers
  const set = (next: Partial<OperatorDraft>) => actions?.operators?.onAddDraft?.({ ...draft, ...next })
  const held = add.writing.busy ? 'held.busy' : operatorHeld(draft)
  const close = () => actions?.onAddress?.({ add: false })
  const styles = pickers.styles && pickers.styles.status === 'ready' ? pickers.styles.value : []
  return (
    <Modal
      open
      onClose={close}
      title={t('operators.addTitle')}
      size="lg"
      footer={
        <>
          <Button onClick={close}>{t('common.cancel')}</Button>
          <Button variant="primary" heldReason={held ? t(held) : null} onClick={() => actions?.operators?.onAddSave?.()}>
            {t('operators.addSave')}
          </Button>
        </>
      }
    >
      <div className="fw-rm-form-grid">
        <Field label={t('field.role')} required>
          <Select size="sm" value={draft.role ?? ''} onChange={(event) => set({ role: (event.target.value || null) as OperatorDraft['role'] })}>
            <option value="">{t('common.choose')}</option>
            {OPERATOR_ROLES.map((role) => (
              <option key={role} value={role}>
                {t(`operatorRole.${role}`)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('field.marketCode')}>
          <Select size="sm" value={draft.marketCode ?? ''} onChange={(event) => set({ marketCode: event.target.value || null })}>
            <option value="">{t('operators.everyMarket')}</option>
            {state.markets.map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </Select>
        </Field>
        <fieldset className="fw-rm-choices fw-rm-span">
          <legend className="fw-rm-question">{t('operators.appliesTo')}</legend>
          <div className="fw-rm-radios">
            {OPERATOR_SCOPES.map((scope) => (
              <RadioCard key={scope} variant="row" name="rm-op-scope" checked={draft.scope === scope} selected={draft.scope === scope} onChange={() => set({ scope })} title={t(`level.${scope}`)} description={t(`levelWhat.${scope}`, { company: model.companyName })} />
            ))}
          </div>
        </fieldset>
        {draft.scope === 'STYLE' && (
          <>
            <Field label={t('operators.findStyle')} hint={model.can.stylesView ? undefined : t('held.stylesView')}>
              <Input size="sm" type="search" value={pickers.styleQ} disabled={!model.can.stylesView} onChange={(event) => actions?.operators?.onStyleQ?.(event.target.value)} />
            </Field>
            <Field label={t('field.styleId')} required>
              <Select size="sm" value={draft.styleId ?? ''} disabled={!model.can.stylesView} onChange={(event) => set({ styleId: event.target.value || null })}>
                <option value="">{pickers.styles?.status === 'loading' ? t('common.reading') : t('common.choose')}</option>
                {styles.map((style) => (
                  <option key={style.id} value={style.id}>
                    {style.code} · {style.name}
                  </option>
                ))}
              </Select>
            </Field>
          </>
        )}
        {draft.scope === 'BRAND' && (
          <PartySelect label={t('field.brandPartyId')} value={draft.brandPartyId} read={pickers.brands} none={t('common.choose')} held={model.can.partiesView ? null : t('held.partiesView')} onChange={(id) => set({ brandPartyId: id })} />
        )}
        <Field label={t('operators.findParty')} hint={model.can.partiesView ? undefined : t('held.partiesView')}>
          <Input size="sm" type="search" value={pickers.partyQ} disabled={!model.can.partiesView} onChange={(event) => actions?.operators?.onPartyQ?.(event.target.value)} />
        </Field>
        <PartySelect label={t('field.partyId')} value={draft.partyId} read={pickers.parties} none={draft.role === 'MANUFACTURER' ? t('operators.ourCompany') : t('common.choose')} held={model.can.partiesView ? null : t('held.partiesView')} onChange={(id) => set({ partyId: id })} />
        <Field label={t('field.printedName')} required>
          <Input size="sm" value={draft.printedName} maxLength={200} onChange={(event) => set({ printedName: event.target.value })} />
        </Field>
        <Field label={t('field.contact')} hint={t('operators.contactHint')}>
          <Input size="sm" value={draft.contact} maxLength={200} onChange={(event) => set({ contact: event.target.value })} />
        </Field>
        <div className="fw-rm-span">
          <Field label={t('field.printedAddress')} required>
            <Textarea value={draft.printedAddress} rows={2} maxLength={500} onChange={(event) => set({ printedAddress: event.target.value })} />
          </Field>
        </div>
        <Field label={t('field.validFrom')} required>
          <DateField value={draft.validFrom} locale={dayLocale(locale)} onChange={(value) => set({ validFrom: value })} />
        </Field>
        <Field label={t('field.validTo')} hint={t('operators.validToHint')}>
          <DateField value={draft.validTo ?? ''} locale={dayLocale(locale)} clearable onChange={(value) => set({ validTo: value || null })} />
        </Field>
        <div className="fw-rm-span">
          <Field label={t('field.note')}>
            <Textarea value={draft.note} rows={2} maxLength={2000} onChange={(event) => set({ note: event.target.value })} />
          </Field>
        </div>
        <div className="fw-rm-span">
          <WriteProblem writing={add.writing} />
        </div>
      </div>
    </Modal>
  )
}

/** One row's window: the operator, the printed words and the days (scope, role and market stay: a new scope is a new row). */
function OperatorWindow({ model, state, actions }: { model: RulesMarketsModel; state: OperatorsState; actions?: RulesMarketsActions | undefined }) {
  const t = useWords()
  const locale = useLocale()
  const open = state.open!
  const row = valueOf(state.operators)?.operators.find((entry) => entry.id === open.id) ?? null
  const close = () => actions?.onAddress?.({ open: null })
  const canManage = model.can.rulesManage && model.live !== 'offline'
  const draft = open.draft
  const set = (next: Partial<OperatorWindowState['draft']>) => actions?.operators?.onWindowDraft?.({ ...draft, ...next })
  if (!row) {
    return (
      <Modal open onClose={close} title={t('operators.row')} size="md">
        {state.operators.status === 'loading' ? <SectionLoading rows={3} /> : <EmptyState title={t('operators.notFound')} />}
      </Modal>
    )
  }
  const changed =
    draft.partyId !== (row.party?.id ?? null) || draft.printedName !== row.printedName || draft.printedAddress !== row.printedAddress || draft.contact !== (row.contact ?? '') || draft.validFrom !== row.validFrom || draft.validTo !== row.validTo || draft.note !== (row.note ?? '')
  const held = !canManage ? t('held.rulesManage') : open.writing.busy ? t('held.busy') : !changed ? t('held.nothingChanged') : draft.printedName.trim() === '' ? t('held.printedName') : draft.printedAddress.trim() === '' ? t('held.printedAddress') : draft.validTo !== null && draft.validTo < draft.validFrom ? t('held.validTo') : null
  const target = operatorTarget(row)
  return (
    <Modal
      open
      onClose={close}
      title={`${t(`operatorRole.${row.role}`)} · ${target.label ?? t(`level.${row.level}`)}`}
      subtitle={row.marketCode ? t('operators.forMarket', { market: row.marketCode }) : t('operators.everyMarket')}
      size="lg"
      footer={
        <>
          <Button onClick={close}>{t('common.close')}</Button>
          <Button variant="primary" heldReason={held} onClick={() => actions?.operators?.onWindowSave?.()}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="fw-rm-form-grid">
        <Field label={t('operators.findParty')} hint={model.can.partiesView ? undefined : t('held.partiesView')}>
          <Input size="sm" type="search" value={open.pickers.partyQ} disabled={!model.can.partiesView || !canManage} onChange={(event) => actions?.operators?.onPartyQ?.(event.target.value)} />
        </Field>
        <PartySelect
          label={t('field.partyId')}
          value={draft.partyId}
          read={open.pickers.parties ?? (row.party ? { status: 'ready', value: [{ id: row.party.id, code: row.party.code, legalName: row.party.name, tradeName: null, roles: [] }] } : null)}
          none={row.role === 'MANUFACTURER' ? t('operators.ourCompany') : t('common.choose')}
          held={!canManage ? t('held.rulesManage') : model.can.partiesView ? null : t('held.partiesView')}
          onChange={(id) => set({ partyId: id })}
        />
        <Field label={t('field.printedName')} required>
          <Input size="sm" value={draft.printedName} maxLength={200} disabled={!canManage} onChange={(event) => set({ printedName: event.target.value })} />
        </Field>
        <Field label={t('field.contact')} hint={t('operators.contactHint')}>
          <Input size="sm" value={draft.contact} maxLength={200} disabled={!canManage} onChange={(event) => set({ contact: event.target.value })} />
        </Field>
        <div className="fw-rm-span">
          <Field label={t('field.printedAddress')} required>
            <Textarea value={draft.printedAddress} rows={2} maxLength={500} disabled={!canManage} onChange={(event) => set({ printedAddress: event.target.value })} />
          </Field>
        </div>
        <Field label={t('field.validFrom')}>
          <DateField value={draft.validFrom} locale={dayLocale(locale)} onChange={(value) => set({ validFrom: value })} />
        </Field>
        <Field label={t('field.validTo')} hint={t('operators.validToHint')}>
          <DateField value={draft.validTo ?? ''} locale={dayLocale(locale)} clearable onChange={(value) => set({ validTo: value || null })} />
        </Field>
        <div className="fw-rm-span">
          <Field label={t('field.note')}>
            <Textarea value={draft.note} rows={2} maxLength={2000} disabled={!canManage} onChange={(event) => set({ note: event.target.value })} />
          </Field>
        </div>
        <div className="fw-rm-span">
          <WriteProblem writing={open.writing} />
        </div>
      </div>
    </Modal>
  )
}

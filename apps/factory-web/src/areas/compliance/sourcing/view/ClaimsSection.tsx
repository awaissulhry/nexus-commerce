'use client'

import { useEffect, useMemo } from 'react'
import { Leaf, Undo2 } from 'lucide-react'
import { EmptyState, Field } from '@nexus/ui/components'
import { LawRef } from '@nexus/ui/components/LawRef/index'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Input, Select } from '@nexus/ui/primitives'
import { CLAIMS_LAW, type ClaimKind, type ClaimScope } from '@nexus/factory-domain/compliance/claims/rules'
import { Modal, Textarea, useDsWords } from '../../../../lib/i18n/ds-parts'
import { useLocale } from '../../../../lib/i18n/provider'
import { ListFrame } from '../../../../list-frame/ListFrame'
import type { Claim } from '../api'
import { CLAIM_KINDS, CLAIM_SCOPES, isFiltered, scopeText, STATE_FILTERS, withdrawHeld, wordsIn, type StateFilter } from '../model'
import type { SourcingPageActions, SourcingPageModel, WithdrawManyState } from '../view-model'
import { PAGE_KEYS, SectionFailed, SectionHead, SectionLoading, StatePill, useWords, ValidityBar } from './parts'

/**
 * The claims (design sec sc-claims; PRD-380): every environmental claim of the company as the list frame — Claim (code and kind),
 * Wording (in the page's language, with the other languages counted), Scope (the style, the material or the company), Evidence,
 * Valid to (the validity bar), Approver, Status (Draft · Approved · Blocked: evidence expired · Retired) and Used on (labels,
 * styles, catalogue, web shop) — its filters (rows, kind, scope, the words typed) in the address as the API's own; Enter opens
 * the claim's window; Withdraw N over the rows chosen (one reason, one call each), Export N by the frame. No money.
 */
export function ClaimsSection({ model, actions, onHelp }: { model: SourcingPageModel; actions?: SourcingPageActions | undefined; onHelp: () => void }) {
  const t = useWords()
  const ds = useDsWords()
  const locale = useLocale()
  const { address } = model
  const answer = model.claims.status === 'ready' ? model.claims.value : null
  const canManage = model.can.manage && (answer?.canManage ?? true)
  const rows = answer?.claims ?? null
  const selected = model.selected ?? []
  useEffect(() => {
    if (rows && selected.some((id) => !rows.some((row) => row.id === id))) actions?.onSelected?.(selected.filter((id) => rows.some((row) => row.id === id)))
  }, [rows, selected, actions])
  const picked = (rows ?? []).filter((row) => selected.includes(row.id))
  const today = answer?.today ?? model.today

  const columns = useMemo<ColDef<Claim>[]>(() => {
    const ClaimCell = ({ data }: ICellRendererParams<Claim>) =>
      data ? (
        <span className="fw-sc-cell">
          <span className="fw-sc-code">{data.code}</span>
          <span className="fw-sc-muted">{t(`kind.${data.kind}`)}</span>
        </span>
      ) : null
    const WordingCell = ({ data }: ICellRendererParams<Claim>) => {
      if (!data) return null
      const others = Object.keys(data.wording).length - 1
      return (
        <span className="fw-sc-cell">
          <span>{wordsIn(data.wording, locale)}</span>
          <span className="fw-sc-muted">{others > 0 ? t('claims.languages', { list: Object.keys(data.wording).join(', ') }) : Object.keys(data.wording).join(', ')}</span>
        </span>
      )
    }
    const ValidCell = ({ data }: ICellRendererParams<Claim>) => (data ? <ValidityBar validity={data.validity} until={data.validUntil} from={data.approvedAt ?? data.createdAt} today={today} mini /> : null)
    const StateCell = ({ data }: ICellRendererParams<Claim>) => (data ? <StatePill state={data.state} /> : null)
    return [
      { colId: 'code', headerName: t('claims.col.claim'), minWidth: 130, flex: 0.9, valueGetter: (params) => params.data?.code ?? '', cellRenderer: ClaimCell },
      { colId: 'wording', headerName: t('claims.col.wording'), minWidth: 220, flex: 2, valueGetter: (params) => (params.data ? wordsIn(params.data.wording, locale) : ''), cellRenderer: WordingCell },
      { colId: 'scope', headerName: t('claims.col.scope'), minWidth: 150, flex: 1.1, valueGetter: (params) => (params.data ? scopeText(params.data, t('scope.COMPANY')) : '') },
      { colId: 'evidence', headerName: t('claims.col.evidence'), minWidth: 150, flex: 1.1, valueGetter: (params) => (params.data ? (params.data.evidence.length === 0 ? t('claims.noEvidence') : params.data.evidence.map((file) => file.name).join(', ')) : '') },
      { colId: 'validUntil', headerName: t('claims.col.validUntil'), minWidth: 160, flex: 1, valueGetter: (params) => params.data?.validUntil ?? '', cellRenderer: ValidCell },
      { colId: 'approver', headerName: t('claims.col.approver'), minWidth: 120, flex: 0.8, valueGetter: (params) => (params.data ? (params.data.approvedBy?.name ?? '—') : '') },
      { colId: 'state', headerName: t('claims.col.state'), minWidth: 150, flex: 1, valueGetter: (params) => (params.data ? t(`state.${params.data.state}`) : ''), cellRenderer: StateCell },
      { colId: 'uses', headerName: t('claims.col.uses'), minWidth: 130, flex: 1, valueGetter: (params) => (params.data ? params.data.uses.kinds.map((kind) => t(`use.${kind}`)).join(', ') || t('claims.notUsed') : '') },
    ]
  }, [t, locale, today])

  const search = <Input size="sm" type="search" value={address.q} placeholder={t('claims.search')} aria-label={t('claims.search')} onChange={(event) => actions?.onAddress?.({ q: event.target.value })} />
  const filters = (
    <span className="fw-sc-row">
      <Select size="sm" value={address.state} aria-label={t('claims.filterState')} onChange={(event) => actions?.onAddress?.({ state: event.target.value as StateFilter })}>
        {STATE_FILTERS.map((state) => (
          <option key={state} value={state}>
            {t(`rows.${state}`)}
          </option>
        ))}
      </Select>
      <Select size="sm" value={address.kind ?? ''} aria-label={t('claims.filterKind')} onChange={(event) => actions?.onAddress?.({ kind: (event.target.value || null) as ClaimKind | null })}>
        <option value="">{t('claims.allKinds')}</option>
        {CLAIM_KINDS.map((kind) => (
          <option key={kind} value={kind}>
            {t(`kind.${kind}`)}
          </option>
        ))}
      </Select>
      <Select size="sm" value={address.scope ?? ''} aria-label={t('claims.filterScope')} onChange={(event) => actions?.onAddress?.({ scope: (event.target.value || null) as ClaimScope | null })}>
        <option value="">{t('claims.allScopes')}</option>
        {CLAIM_SCOPES.map((scope) => (
          <option key={scope} value={scope}>
            {t(`scopeKind.${scope}`)}
          </option>
        ))}
      </Select>
    </span>
  )

  const head = (
    <SectionHead id="fw-sc-claims" title={t('claims.title')} note={<LawRef law={answer?.law.claims ?? CLAIMS_LAW} plain={t('law.claims')} labels={ds.lawRef} />}>
      {answer && <span className="fw-sc-muted">{t(`claims.labelCheck.${answer.labelCheck}`)}</span>}
    </SectionHead>
  )

  if (model.claims.status === 'error') {
    return (
      <>
        {head}
        <SectionFailed title={t('claims.failed')} problem={model.claims.problem} onRetry={actions?.onRetryClaims} />
      </>
    )
  }
  if (!answer) {
    return (
      <>
        {head}
        <SectionLoading rows={6} />
      </>
    )
  }

  return (
    <>
      {head}
      <ListFrame<Claim>
        label={t('claims.label')}
        title={t('claims.title')}
        listKey="compliance.sourcing"
        rows={rows}
        rowId={(row) => row.id}
        columns={columns}
        count={t('claims.count', { count: answer.claims.length })}
        search={search}
        tools={filters}
        selection={{
          selected,
          onChange: (ids) => actions?.onSelected?.(ids),
          exportSelected: true,
          actions: canManage ? (
            <Button size="sm" variant="primary" aria-label={t('bulk.withdraw', { count: picked.length })} heldReason={picked.length === 0 ? t('held.noneWithdrawable') : null} onClick={() => actions?.onWithdrawMany?.(picked.map((row) => row.id))}>
              <Undo2 size={13} aria-hidden /> <SelectionLabel>{t('bulk.withdraw', { count: picked.length })}</SelectionLabel>
            </Button>
          ) : null,
        }}
        isRowSelectable={canManage ? (row) => (row.status === 'WITHDRAWN' ? t('held.retiredRow') : null) : undefined}
        keys={PAGE_KEYS(t)}
        onHelp={onHelp}
        onOpen={(row) => actions?.onAddress?.({ open: row.id })}
        more={answer.complete ? null : { label: t('claims.more'), onMore: () => undefined, held: t('claims.moreHeld') }}
        state={
          answer.claims.length === 0 ? (
            isFiltered(address) ? (
              <EmptyState
                icon={<Leaf size={22} aria-hidden />}
                title={t('claims.noneFiltered')}
                description={t('claims.noneFilteredHint')}
                action={
                  <Button size="sm" onClick={() => actions?.onAddress?.({ state: 'current', kind: null, scope: null, q: '' })}>
                    {t('claims.clearFilters')}
                  </Button>
                }
              />
            ) : (
              <EmptyState
                icon={<Leaf size={22} aria-hidden />}
                title={t('claims.emptyTitle')}
                description={t('claims.empty')}
                action={
                  canManage && model.companyId ? (
                    <Button size="sm" variant="primary" onClick={() => actions?.onAddress?.({ add: true })}>
                      {t('band.add')}
                    </Button>
                  ) : undefined
                }
              />
            )
          ) : undefined
        }
        cards={{ fields: { code: { role: 'title' }, wording: { role: 'subtitle' }, state: { role: 'aside' } } }}
      />
    </>
  )
}

/** Withdraw N: one reason for every claim chosen (one call each); their uses end with them. */
export function WithdrawManyDialog({ model, state, actions }: { model: SourcingPageModel; state: WithdrawManyState; actions?: SourcingPageActions | undefined }) {
  const t = useWords()
  const locale = useLocale()
  const rows = (model.claims.status === 'ready' ? model.claims.value.claims : []).filter((row) => state.ids.includes(row.id))
  const held = withdrawHeld(state.reason, state.busy)
  const uses = rows.reduce((sum, row) => sum + row.uses.live, 0)
  return (
    <Modal
      open
      onClose={() => actions?.onWithdrawMany?.(null)}
      title={t('withdraw.bulkTitle', { count: rows.length })}
      size="md"
      footer={
        <>
          <Button onClick={() => actions?.onWithdrawMany?.(null)}>{t('common.cancel')}</Button>
          <Button variant="danger" heldReason={held ? t(held) : null} onClick={() => actions?.onApplyWithdrawMany?.()}>
            {t('bulk.withdraw', { count: rows.length })}
          </Button>
        </>
      }
    >
      <div className="fw-sc-form">
        <ul className="fw-sc-list">
          {rows.map((row) => (
            <li key={row.id}>{`${row.code} · ${wordsIn(row.wording, locale)}`}</li>
          ))}
        </ul>
        <p className="fw-sc-muted">{uses > 0 ? t('withdraw.usesEnd', { count: uses }) : t('withdraw.noUses')}</p>
        <Field label={t('withdraw.reason')} required>
          <Textarea value={state.reason} rows={3} maxLength={500} onChange={(event) => actions?.onWithdrawManyReason?.(event.target.value)} />
        </Field>
      </div>
    </Modal>
  )
}

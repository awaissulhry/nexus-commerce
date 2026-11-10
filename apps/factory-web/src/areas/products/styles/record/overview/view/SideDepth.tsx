'use client'

import { useState } from 'react'
import Link from 'next/link'
import { ArrowRight, CircleCheck, CircleX, MoreHorizontal } from 'lucide-react'
import { Banner, Card, Field, Menu, ProgressBar, SummaryTable, type MenuItemDef } from '@nexus/ui/components'
import { Button, Input, Pill, SegmentedControl, Select, Skeleton, Tag } from '@nexus/ui/primitives'
import type { StyleLifecycle } from '@nexus/factory-domain/product/lifecycle/rules'
import type { WhereUsedKind } from '@nexus/factory-domain/product/where-used/rules'
import { Modal, Textarea } from '../../../../../../lib/i18n/ds-parts'
import { formatDate } from '../../../../../../lib/i18n/format'
import { useLocale } from '../../../../../../lib/i18n/provider'
import { OFFICE_PAGES } from '../../../../../../shell/nav/office-nav'
import type { LifecycleView, WhereUsedView } from '../api'
import {
  allowedGroups,
  completenessTone,
  fixTab,
  gateItemKey,
  gateStateKey,
  KINDS,
  LIFECYCLE_TONE,
  moveHeld,
  moveProblem,
  namesReplacement,
  pctNumber,
  pctText,
  refusalKey,
  ruleIn,
  stateKey,
  valueOf,
  whereUsedHref,
  type StyleDepthActions,
  type StyleDepthModel,
} from '../model'
import { DialogProblem, PartBody, useDepthT } from './parts'

const styleHref = (model: StyleDepthModel, id: string, tab = 'overview') => `${model.prefix}/products/styles/${encodeURIComponent(id)}?tab=${tab}`

/**
 * SCR-342 — the side panel in depth (design products.styles rec:Style style.ov.side): the lifecycle Pill and what it allows
 * now (the edit rule in force per kind of change, in words), its moves (a move back asks why; into phase out or
 * discontinued, the replacing style), the replacing and replaced styles; the release check's completeness % (B-W2b-231's
 * gate, the first open item linked to where it is fixed); and where the style is used (every kind the role reads, each
 * row a link to its record). Draws one model; fetches nothing.
 */
export function LifecycleCard({ model, actions }: { model: StyleDepthModel; actions?: StyleDepthActions }) {
  const t = useDepthT()
  const view = valueOf(model.lifecycle)
  const held = moveHeld(model)
  const items: MenuItemDef[] = (view?.moves ?? []).map((move) => ({
    id: move.to,
    label: t(move.backward ? 'lifecycle.moveBack' : 'lifecycle.moveTo', { state: t(`lifecycle.state.${move.to}`) }),
    disabled: !move.allowed,
    description: move.allowed ? undefined : t(refusalKey(move.refusal?.code ?? 'other')),
    onSelect: () => actions?.onDialog?.({ kind: 'move', to: move.to }),
  }))
  return (
    <Card
      header={t('lifecycle.title')}
      headerAction={
        held || !view || items.length === 0 ? (
          <Button size="sm" variant="quiet" heldReason={held ? t(held) : !view ? t('hold.loading') : t('lifecycle.held.noMove')}>
            {t('lifecycle.move')}
          </Button>
        ) : (
          <Menu label={<span className="fw-st-inline">{t('lifecycle.move')} <MoreHorizontal size={14} aria-hidden /></span>} items={items} align="right" triggerProps={{ 'aria-label': t('lifecycle.move') }} />
        )
      }
    >
      <PartBody part={model.lifecycle} actions={actions}>
        {(value) => <LifecycleBody model={model} view={value} actions={actions} />}
      </PartBody>
      {view && model.dialog?.kind === 'move' && <MoveDialog model={model} view={view} to={model.dialog.to} actions={actions} />}
      {view && model.dialog?.kind === 'replacement' && <ReplacementDialog model={model} view={view} actions={actions} />}
    </Card>
  )
}

function LifecycleBody({ model, view, actions }: { model: StyleDepthModel; view: LifecycleView; actions?: StyleDepthActions }) {
  const t = useDepthT()
  const locale = useLocale()
  const state = view.style.lifecycle
  const rule = view.editRule
  const replaceable = state === 'PHASE_OUT' || state === 'DISCONTINUED'
  return (
    <div className="fw-st-stack">
      <span className="fw-st-inline fw-sdp-wrap">
        <Pill tone={LIFECYCLE_TONE[state]}>{t(`lifecycle.state.${state}`)}</Pill>
        {view.style.changedAt && <span className="fw-st-hint">{t('lifecycle.since', { date: formatDate(view.style.changedAt, { locale }) })}</span>}
      </span>
      <p className="fw-st-hint">{t(`lifecycle.means.${state}`)}</p>
      <div className="fw-st-stack">
        <span className="fw-st-inline fw-sdp-wrap">
          <b>{t('lifecycle.allows')}</b>
          <Tag tone={rule.rule === 'FREE' ? 'success' : rule.rule === 'BLOCKED' ? 'danger' : 'info'}>{t(`lifecycle.rule.${rule.rule}`)}</Tag>
          <span className="fw-st-hint">{t(`lifecycle.source.${rule.source}`)}</span>
        </span>
        <ul className="fw-sdp-checks" aria-label={t('lifecycle.allows')}>
          {KINDS.map((kind) => {
            const refusal = rule.kinds.find((entry) => entry.kind === kind)?.refusal ?? null
            return (
              <li key={kind} className={refusal ? 'is-held' : 'is-ok'}>
                {refusal ? <CircleX size={14} aria-hidden /> : <CircleCheck size={14} aria-hidden />}
                <span>
                  {t(`lifecycle.kind.${kind}`)}
                  {refusal && <span className="fw-sdp-why"> — {t(refusalKey(refusal.code))}</span>}
                </span>
              </li>
            )
          })}
        </ul>
      </div>
      {view.replacedBy && (
        <p className="fw-st-inline fw-sdp-wrap">
          <span>{t('lifecycle.replacedBy')}</span>
          <Link className="fw-st-link" href={styleHref(model, view.replacedBy.id)}>
            {view.replacedBy.code} · {view.replacedBy.name}
          </Link>
        </p>
      )}
      {view.replaces.length > 0 && (
        <p className="fw-st-inline fw-sdp-wrap">
          <span>{t('lifecycle.replaces')}</span>
          {view.replaces.map((entry) => (
            <Link key={entry.id} className="fw-st-link" href={styleHref(model, entry.id)}>
              {entry.code}
            </Link>
          ))}
        </p>
      )}
      {replaceable && (
        <span>
          <Button size="sm" variant="quiet" heldReason={moveHeld(model) ? t(moveHeld(model)!) : null} onClick={() => actions?.onDialog?.({ kind: 'replacement' })}>
            {t(view.replacedBy ? 'lifecycle.changeReplacement' : 'lifecycle.nameReplacement')}
          </Button>
        </span>
      )}
      <Link className="fw-st-link fw-st-inline" href={`${model.prefix}/products/settings`}>
        {t('lifecycle.rulesLink')} <ArrowRight size={12} aria-hidden />
      </Link>
    </div>
  )
}

/** Find a style by code or name (the replacing style); the current one stays offered. */
function ReplacementPicker({ model, value, onChange, current, actions }: { model: StyleDepthModel; value: string | null; onChange: (id: string | null) => void; current: { id: string; code: string; name: string } | null; actions?: StyleDepthActions }) {
  const t = useDepthT()
  const [query, setQuery] = useState(model.replacements.query)
  const found = model.replacements.found ?? []
  const choices = [...(current && !found.some((entry) => entry.id === current.id) ? [current] : []), ...found]
  return (
    <div className="fw-st-form-grid">
      <Field label={t('replacement.find')} hint={t('replacement.findHint')}>
        <Input
          type="search"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
            actions?.onFindReplacement?.(event.target.value)
          }}
        />
      </Field>
      <Field label={t('replacement.field')} hint={model.replacements.found && found.length === 0 && query.trim().length >= 2 ? t('replacement.noneFound') : undefined}>
        <Select value={value ?? ''} onChange={(event) => onChange(event.target.value || null)}>
          <option value="">{t('replacement.none')}</option>
          {choices.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.code} · {entry.name}
            </option>
          ))}
        </Select>
      </Field>
    </div>
  )
}

function MoveDialog({ model, view, to, actions }: { model: StyleDepthModel; view: LifecycleView; to: StyleLifecycle; actions?: StyleDepthActions }) {
  const t = useDepthT()
  const move = view.moves.find((entry) => entry.to === to) ?? null
  const backward = move?.backward ?? false
  const [reason, setReason] = useState(model.moveDraft?.reason ?? '')
  const [replacedById, setReplacedById] = useState<string | null>(model.moveDraft?.replacedById ?? view.replacedBy?.id ?? null)
  const after = ruleIn(view, to)
  const refusal = move && !move.allowed ? refusalKey(move.refusal?.code ?? 'other') : null
  const held = moveHeld(model) ?? refusal ?? moveProblem(backward, reason)
  const go = () => {
    if (!held) void actions?.onMove?.(to, reason, namesReplacement(to) ? replacedById : undefined)
  }
  return (
    <Modal
      open
      onClose={() => actions?.onDialog?.(null)}
      title={t('move.title', { code: model.styleCode, state: t(`lifecycle.state.${to}`) })}
      size="md"
      footer={
        <>
          <Button onClick={() => actions?.onDialog?.(null)}>{t('base.cancel')}</Button>
          <Button variant="primary" heldReason={held ? t(held) : null} onClick={go} aria-keyshortcuts="Meta+Enter Control+Enter">
            {t('move.confirm', { state: t(`lifecycle.state.${to}`) })}
          </Button>
        </>
      }
    >
      <div
        className="fw-st-dialog"
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault()
            go()
          }
        }}
      >
        <p className="fw-st-inline fw-sdp-wrap">
          <Pill tone={LIFECYCLE_TONE[view.style.lifecycle]}>{t(`lifecycle.state.${view.style.lifecycle}`)}</Pill>
          <ArrowRight size={14} aria-hidden />
          <Pill tone={LIFECYCLE_TONE[to]}>{t(`lifecycle.state.${to}`)}</Pill>
        </p>
        <p>{t(`lifecycle.means.${to}`)}</p>
        {after && <p className="fw-st-hint">{t('move.after', { rule: t(`lifecycle.rule.${after.rule}`) })}</p>}
        {to === 'IN_PRODUCTION' && <p className="fw-st-hint">{t('move.production')}</p>}
        {refusal && <Banner tone="warning" title={t(refusal)} />}
        <Field label={t('base.reason')} required={backward} hint={t(backward ? 'move.reasonBack' : 'base.reasonHint')} error={backward && reason.trim() === '' && model.moveDraft ? t('move.held.reason') : undefined}>
          <Textarea value={reason} rows={2} maxLength={500} onChange={(event) => setReason(event.target.value)} />
        </Field>
        {namesReplacement(to) && <ReplacementPicker model={model} value={replacedById} onChange={setReplacedById} current={view.replacedBy} actions={actions} />}
        <DialogProblem problem={model.problem} />
      </div>
    </Modal>
  )
}

function ReplacementDialog({ model, view, actions }: { model: StyleDepthModel; view: LifecycleView; actions?: StyleDepthActions }) {
  const t = useDepthT()
  const [replacedById, setReplacedById] = useState<string | null>(view.replacedBy?.id ?? null)
  const [reason, setReason] = useState('')
  const held = moveHeld(model) ?? (replacedById === (view.replacedBy?.id ?? null) ? 'replacement.held.same' : reason.length > 500 ? 'hold.long' : null)
  return (
    <Modal
      open
      onClose={() => actions?.onDialog?.(null)}
      title={t('replacement.title', { code: model.styleCode })}
      size="md"
      footer={
        <>
          <Button onClick={() => actions?.onDialog?.(null)}>{t('base.cancel')}</Button>
          <Button variant="primary" heldReason={held ? t(held) : null} onClick={() => void actions?.onReplacement?.(replacedById, reason)}>
            {t('replacement.save')}
          </Button>
        </>
      }
    >
      <div className="fw-st-dialog">
        <p className="fw-st-hint">{t('replacement.intro')}</p>
        <ReplacementPicker model={model} value={replacedById} onChange={setReplacedById} current={view.replacedBy} actions={actions} />
        <Field label={t('base.reason')} hint={t('base.reasonHint')}>
          <Textarea value={reason} rows={2} maxLength={500} onChange={(event) => setReason(event.target.value)} />
        </Field>
        <DialogProblem problem={model.problem} />
      </div>
    </Modal>
  )
}

// ---- completeness (inside W1's release check card) ----------------------------------------------------------------------

export function CompletenessLine({ model, actions }: { model: StyleDepthModel; actions?: StyleDepthActions }) {
  const t = useDepthT()
  const locale = useLocale()
  if (model.gate.status === 'idle') return null
  if (model.gate.status === 'loading') return <Skeleton height={18} />
  if (model.gate.status === 'error')
    return (
      <p className="fw-st-hint">
        {t(model.gate.problem)}{' '}
        <Button size="sm" variant="quiet" onClick={() => actions?.onRetry?.()}>
          {t('base.retry')}
        </Button>
      </p>
    )
  const row = model.gate.value
  if (!row || !row.revision) return null
  const value = pctNumber(row.completenessPct)
  // The Fix opens the tab where the item is fixed, on the revision the gate checked.
  const href = (fix: string) => `${model.prefix}/products/styles/${encodeURIComponent(model.styleId)}?tab=${fixTab(fix)}&rev=${encodeURIComponent(row.revision!.id)}`
  return (
    <div className="fw-sdp-gate">
      <div className="fw-sdp-meter">
        <span className="fw-sdp-meter-label">{t(row.checked ? 'score.completeness' : 'score.atRelease', { revision: row.revision.revision })}</span>
        <ProgressBar ariaLabel={t('score.completenessOf', { value: pctText(row.completenessPct, locale) })} value={value} tone={completenessTone(row)} showValue />
      </div>
      {row.checked &&
        (row.open === 0 ? (
          <p className="fw-st-inline fw-st-ok">
            <CircleCheck size={14} aria-hidden /> {t('score.nothingOpen')}
          </p>
        ) : (
          <p className="fw-sdp-wrap fw-st-inline">
            <span>{t('score.open', { count: row.open, blockers: row.blockers })}</span>
            {row.first && (
              <>
                <span className="fw-st-hint">
                  {t('score.first', { item: t(gateItemKey(row.first.code)), state: t(gateStateKey(row.first.state)) })}
                </span>
                <Link className="fw-st-link" href={href(row.first.fix)}>
                  {t('score.fix')}
                </Link>
              </>
            )}
          </p>
        ))}
    </div>
  )
}

// ---- where-used ---------------------------------------------------------------------------------------------------------

export function WhereUsedCard({ model, actions }: { model: StyleDepthModel; actions?: StyleDepthActions }) {
  const t = useDepthT()
  const view = valueOf(model.whereUsed)
  const groups = view ? allowedGroups(view) : []
  const any = groups.some((group) => group.count > 0)
  return (
    <Card
      header={t('whereUsed.title')}
      headerAction={
        any ? (
          <Button size="sm" variant="quiet" onClick={() => actions?.onDialog?.({ kind: 'whereUsed', group: null })}>
            {t('whereUsed.showAll')}
          </Button>
        ) : undefined
      }
    >
      <PartBody part={model.whereUsed} actions={actions}>
        {(value) => <WhereUsedBody view={value} actions={actions} />}
      </PartBody>
      {view && model.dialog?.kind === 'whereUsed' && <WhereUsedDialog model={model} view={view} group={model.dialog.group} actions={actions} />}
    </Card>
  )
}

function WhereUsedBody({ view, actions }: { view: WhereUsedView; actions?: StyleDepthActions }) {
  const t = useDepthT()
  const groups = allowedGroups(view)
  const hidden = view.groups.length - groups.length
  const used = groups.filter((group) => group.count > 0)
  return (
    <div className="fw-st-stack">
      {used.length === 0 ? (
        <p className="fw-st-hint">{t('whereUsed.none')}</p>
      ) : (
        <ul className="fw-sdp-used">
          {used.map((group) => (
            <li key={group.kind}>
              <button type="button" className="fw-st-linkbtn" onClick={() => actions?.onDialog?.({ kind: 'whereUsed', group: group.kind })}>
                {t(`whereUsed.kind.${group.kind}`)}
              </button>
              <span className="fw-st-hint">{group.kind === 'STOCK' ? t('whereUsed.onHand', { count: group.onHand ?? group.count }) : t('whereUsed.count', { open: group.open, count: group.count })}</span>
            </li>
          ))}
        </ul>
      )}
      {hidden > 0 && <p className="fw-st-hint">{t('whereUsed.hidden', { count: hidden })}</p>}
    </div>
  )
}

function WhereUsedDialog({ model, view, group, actions }: { model: StyleDepthModel; view: WhereUsedView; group: WhereUsedKind | null; actions?: StyleDepthActions }) {
  const t = useDepthT()
  const locale = useLocale()
  const groups = allowedGroups(view).filter((entry) => entry.count > 0)
  const [kind, setKind] = useState<WhereUsedKind | null>(group ?? groups[0]?.kind ?? null)
  const shown = groups.find((entry) => entry.kind === kind) ?? groups[0] ?? null
  return (
    <Modal open onClose={() => actions?.onDialog?.(null)} title={t('whereUsed.dialogTitle', { code: model.styleCode })} size="lg" footer={<Button onClick={() => actions?.onDialog?.(null)}>{t('base.close')}</Button>}>
      <div className="fw-st-dialog">
        {groups.length === 0 || !shown ? (
          <p className="fw-st-hint">{t('whereUsed.none')}</p>
        ) : (
          <>
            <SegmentedControl
              ariaLabel={t('whereUsed.kinds')}
              size="sm"
              wrap
              value={shown.kind}
              onChange={(value) => setKind(value as WhereUsedKind)}
              options={groups.map((entry) => ({ value: entry.kind, label: `${t(`whereUsed.kind.${entry.kind}`)} · ${entry.count}` }))}
            />
            <SummaryTable
              label={t(`whereUsed.kind.${shown.kind}`)}
              stackOnPhone
              columns={[t('whereUsed.col.record'), t('whereUsed.col.state'), t('whereUsed.col.date'), t('whereUsed.col.party'), t('whereUsed.col.detail'), t('whereUsed.col.pieces')]}
              widths={['18%', '16%', '12%', '20%', undefined, '10%']}
              align={[undefined, undefined, undefined, undefined, undefined, 'right']}
              rows={shown.rows.map((row) => {
                const href = whereUsedHref(model.prefix, shown.kind, row, OFFICE_PAGES)
                return {
                  id: row.id,
                  cells: [
                    href ? (
                      <Link key="n" className="fw-st-link" href={href}>
                        {row.number}
                      </Link>
                    ) : (
                      <b key="n">{row.number}</b>
                    ),
                    <Pill key="s" tone={row.open ? 'info' : 'neutral'}>
                      {t(stateKey(row.state, row.open))}
                    </Pill>,
                    row.at ? formatDate(row.at, { locale }) : '—',
                    row.party ? `${row.party.name}` : '—',
                    row.detail ?? '—',
                    row.pieces === null ? '—' : String(row.pieces),
                  ],
                }
              })}
            />
            {shown.more && <p className="fw-st-hint">{t('whereUsed.more', { shown: shown.rows.length, count: shown.count })}</p>}
          </>
        )}
      </div>
    </Modal>
  )
}

'use client'

import { useState, type KeyboardEvent } from 'react'
import Link from 'next/link'
import { CircleAlert, CircleCheck, CircleMinus, CircleX } from 'lucide-react'
import { Banner, Field, ProgressBar } from '@nexus/ui/components'
import { Button, Checkbox, FilterChip, Spinner, Tag } from '@nexus/ui/primitives'
import { Modal, Textarea } from '../../../../../lib/i18n/ds-parts'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import type { BomView, RoutingView, StyleView } from '../../api'
import type { StyleAbilities } from '../../model'
import type { GateView } from '../api'
import { effectsOf, fixHref, ITEM_TONE, itemViews, meterTone, pctText, pickText, releaseGateHeld, scopeChoices, scopeSay, VERSIONS_NS, widenEffectsOf, type ScopeChoice } from '../model'
import type { ReleaseActions, ReleaseModel } from '../use-release'
import { useSay } from '../words'
import '../../versions/versions.css'

const STATE_ICON = {
  OK: <CircleCheck size={14} aria-hidden />,
  WARNING: <CircleAlert size={14} aria-hidden />,
  BLOCKED: <CircleX size={14} aria-hidden />,
  NOT_REQUIRED: <CircleMinus size={14} aria-hidden />,
} as const
const STATE_CLASS = { OK: 'is-ok', WARNING: 'is-warning', BLOCKED: 'is-blocked', NOT_REQUIRED: '' } as const

/**
 * Release revision N (design products.styles pop:styles.release, on B-W2b-231's gate): the release check as a checklist
 * (GateChecklist composed: the DS has none) — BOM complete, routing, approved minutes, materials approved (W2b), materials
 * priced, label, certificate per switched-on colourway × size, size spec (W2b), attributes, change orders, the scope and the
 * open quotes and orders on the revision that becomes obsolete — each with its state, its findings in words and Fix; the
 * completeness score; "Release only some colourways or sizes" (PRD-191: the cells left out wait for a later release, the
 * suggested scope leaves out what no certificate covers); what happens, in words; the change note. "Release revision N" is
 * held with the first blocking reason. A released revision released for some cells opens the same modal as "Release more":
 * only the scope, only wider. ⌘↵ releases; Esc closes.
 */
export function ReleaseGateDialog({
  style,
  model,
  bom,
  routing,
  prefix,
  can,
  busy,
  actions,
}: {
  style: StyleView
  model: ReleaseModel
  bom: BomView | null
  routing: RoutingView | null
  prefix: string
  can: Pick<StyleAbilities, 'release'>
  busy: boolean
  actions?: ReleaseActions
}) {
  const t = useT('products')
  const tv = useT(VERSIONS_NS)
  const say = useSay()
  const locale = useLocale() as 'it' | 'en'
  const [note, setNote] = useState('')
  const revision = style.revisions.find((entry) => entry.id === model.revisionId) ?? null
  const widen = model.mode === 'widen'
  const held = releaseGateHeld({ ...model, busy: model.busy || busy }, style, can)
  const heldText = say(held)
  const close = () => actions?.onClose?.()
  const run = () => {
    if (heldText) return
    if (widen) void actions?.onWiden?.()
    else void actions?.onRelease?.(note.trim())
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault()
      run()
    }
  }
  const title = widen ? tv('widen.title', { revision: revision?.revision ?? 0 }) : t('release.title', { revision: revision?.revision ?? 0 })
  const gate = model.gate.status === 'ready' ? model.gate.value : null

  return (
    <Modal
      open
      onClose={close}
      size="lg"
      title={title}
      footer={
        <>
          <Button onClick={close}>{t('common.back')}</Button>
          <Button variant="primary" heldReason={heldText} onClick={run} aria-keyshortcuts="Meta+Enter Control+Enter">
            {model.busy ? <Spinner size={12} /> : null} {widen ? tv('widen.go', { revision: revision?.revision ?? 0 }) : t('release.go', { revision: revision?.revision ?? 0 })}
          </Button>
        </>
      }
    >
      <div className="fw-st-dialog" onKeyDown={onKeyDown}>
        {model.problem && <Banner tone="danger" title={say(model.problem)} />}
        {model.gate.status === 'loading' ? (
          <p className="fw-st-hint" role="status">
            <Spinner size={14} /> {tv('gateCheck.reading')}
          </p>
        ) : model.gate.status === 'error' ? (
          <Banner
            tone="danger"
            title={tv('gateCheck.failed')}
            action={
              <Button size="sm" variant="quiet" onClick={() => actions?.onRetry?.()}>
                {tv('base.retry')}
              </Button>
            }
          >
            {tv(model.gate.problem)}
          </Banner>
        ) : gate ? (
          <>
            {!widen && <Score gate={gate} locale={locale} />}
            <h3 className="fw-st-h3">{widen ? tv('widen.checkTitle') : t('release.checkTitle')}</h3>
            <ul className="fw-st-checklist" aria-label={t('release.checkTitle')}>
              {itemViews(gate, { bom, routing }, (item) => fixHref(prefix, style.id, model.revisionId, item)).map((item) => (
                <li key={item.code} className={`fw-st-check ${STATE_CLASS[item.state]}`}>
                  {STATE_ICON[item.state]}
                  <span className="fw-ver-item">
                    <span className="fw-ver-item-head">
                      <b>{tv(`gateItem.${item.code}`)}</b>
                      <Tag tone={ITEM_TONE[item.state]}>{tv(`gateState.${item.state}`)}</Tag>
                    </span>
                    <span className="fw-st-hint">{tv(`gateWhat.${item.code}`)}</span>
                    {item.findings.length > 0 && (
                      <ul className="fw-st-list">
                        {item.findings.map((finding, index) => (
                          <li key={index}>{say(finding)}</li>
                        ))}
                        {item.more > 0 && <li className="fw-st-hint">{tv('gateCheck.more', { count: item.more })}</li>}
                      </ul>
                    )}
                  </span>
                  {item.fix ? (
                    <Link className="fw-st-link" href={item.fix} onClick={close}>
                      {t('check.fix')}
                    </Link>
                  ) : (
                    <span />
                  )}
                </li>
              ))}
            </ul>
            <ScopePart model={model} gate={gate} widen={widen} actions={actions} />
            <h3 className="fw-st-h3">{t('release.whatHappens')}</h3>
            <ul className="fw-st-list">
              {(widen ? widenEffectsOf(gate, model.pick) : effectsOf(gate, style, model.pick)).map((effect, index) => (
                <li key={index}>{say(effect)}</li>
              ))}
            </ul>
            {!widen && (
              <Field label={t('release.note')} hint={t('release.noteHint')}>
                <Textarea value={note} onChange={(event) => setNote(event.target.value)} rows={2} maxLength={2000} />
              </Field>
            )}
          </>
        ) : null}
      </div>
    </Modal>
  )
}

function Score({ gate, locale }: { gate: GateView; locale: 'it' | 'en' }) {
  const tv = useT(VERSIONS_NS)
  const pct = pctText(gate.completenessPct, locale)
  const blockers = gate.items.filter((item) => item.state === 'BLOCKED').length
  const warnings = gate.items.filter((item) => item.state === 'WARNING').length
  return (
    <div className="fw-ver-score">
      <span className="fw-ver-score-label">{tv('gateCheck.score')}</span>
      <ProgressBar value={gate.completenessPct === null ? null : Number(gate.completenessPct)} tone={meterTone(gate)} showValue ariaLabel={tv('gateCheck.score')} height={6} />
      <span className="fw-st-hint">{pct === null ? tv('gateCheck.noScore') : tv('gateCheck.open', { blockers, warnings })}</span>
    </div>
  )
}

function ScopePart({ model, gate, widen, actions }: { model: ReleaseModel; gate: GateView; widen: boolean; actions?: ReleaseActions }) {
  const tv = useT(VERSIONS_NS)
  const say = useSay()
  const choices = scopeChoices(gate, model.pick, model.none)
  const suggested = gate.scope.suggested
  const suggestedText = suggested && !suggested.whole ? pickText(suggested, gate) : null
  const chips = (side: 'colourway' | 'size', list: ScopeChoice[]) => (
    <div className="fw-ver-chips" role="group" aria-label={tv(side === 'colourway' ? 'scope.colourways' : 'scope.sizes')}>
      {list.map((choice) => (
        <FilterChip key={choice.id} pressed={choice.on} disabled={choice.fixed || model.busy} title={choice.fixed ? tv('scope.fixed') : undefined} onClick={() => actions?.onToggle?.(side, choice.id)}>
          {choice.label}
        </FilterChip>
      ))}
    </div>
  )
  return (
    <section className="fw-st-stack" aria-label={tv('scope.title')}>
      <h3 className="fw-st-h3">{widen ? tv('scope.widenTitle') : tv('scope.title')}</h3>
      {!widen && <Checkbox checked={model.partial} onChange={(event) => actions?.onPartial?.(event.target.checked)} label={tv('scope.only')} disabled={model.busy} />}
      {(model.partial || widen) && (
        <>
          <span className="fw-st-hint">{tv('scope.colourways')}</span>
          {chips('colourway', choices.colourways)}
          <span className="fw-st-hint">{tv('scope.sizes')}</span>
          {chips('size', choices.sizes)}
          {widen && <p className="fw-st-hint">{tv('scope.fixedHint')}</p>}
          {suggestedText && !widen && (
            <span className="fw-ver-row">
              <Button size="sm" variant="secondary" onClick={() => actions?.onSuggested?.()} disabled={model.busy}>
                {tv('scope.useSuggested')}
              </Button>
              <span className="fw-st-hint">{tv('scope.suggestedIs', { colourways: suggestedText.colourways ?? tv('scope.everyColourway'), sizes: suggestedText.sizes ?? tv('scope.everySize') })}</span>
            </span>
          )}
        </>
      )}
      <p className="fw-ver-scope-now" role="status">
        {model.previewing ? <Spinner size={12} /> : null} {model.none.colourways || model.none.sizes ? tv('hold.scopeEmpty') : say(scopeSay(model.pick, gate))}
      </p>
    </section>
  )
}

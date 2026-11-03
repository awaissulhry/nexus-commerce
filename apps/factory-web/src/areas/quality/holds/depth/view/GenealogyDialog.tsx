'use client'

import { useEffect, useMemo, useState } from 'react'
import { GitBranch, Search } from 'lucide-react'
import { Banner, Field } from '@nexus/ui/components'
import { Button, Input, Kbd, Select, Skeleton, Spinner, Toggle } from '@nexus/ui/primitives'
import { Modal, Textarea } from '../../../../../lib/i18n/ds-parts'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { HoldsMessages, useUomWord } from '../../view/parts'
import { genealogyProblems, impactTree, nodeHeld, planOf, quarantineGaps, summaryWords, type GenealogyDraft, type GenealogyModel, type TreeItem } from '../model'
import { ImpactTree } from './ImpactTree'

export interface GenealogyActions {
  onDraft?: (draft: GenealogyDraft) => void
  onSelect?: (ids: readonly string[]) => void
  onAffectedOnly?: (on: boolean) => void
  /** Find the typed or scanned code (a lot, else a hide). */
  onFind?: () => void
  onPlace?: () => void
  onRetry?: () => void
  onClose?: () => void
}

/**
 * Hold by genealogy (design quality.holds/pop:qh-genealogy; QHS-075 "a recall in minutes"): ONE suspect lot or hide (named
 * by the list that opened it, or its code typed or scanned), its forward tree — hides → cuts → bundles → work orders →
 * garments → shipments → customers — with the counts per level and per state, every holdable branch ticked at first (a
 * recall's safe side; untick what is not wanted), what is on hold already, what has left (the PPE register's: it offers the
 * register) and what the person may not hold said on its node; the summary ("Hold 4 work orders and 126 garments; 18
 * garments already shipped to 2 customers."), the reason, owner, expected release and the quarantine move asked for held
 * stock. The action names what it holds and is held with the reason until it can go. One view model, nothing fetched.
 */
export function GenealogyDialog({ model, prefix, reasonWords, actions }: { model: GenealogyModel; prefix: string; reasonWords: ReadonlyMap<string, { labelIt: string; labelEn: string }>; actions?: GenealogyActions }) {
  return (
    <HoldsMessages>
      <Dialog model={model} prefix={prefix} reasonWords={reasonWords} actions={actions} />
    </HoldsMessages>
  )
}

function Dialog({ model, prefix, reasonWords, actions }: { model: GenealogyModel; prefix: string; reasonWords: ReadonlyMap<string, { labelIt: string; labelEn: string }>; actions?: GenealogyActions }) {
  const t = useT('holds')
  const q = useT('quality')
  const locale = useLocale()
  const draft = model.draft
  const read = model.read?.value ?? null
  const reasons = model.reasons.value ?? []
  const items = useMemo<TreeItem[]>(() => (read ? impactTree(read) : []), [read])
  const sites = useMemo(() => new Map((read?.sites ?? []).map((site) => [site.id, site.code])), [read])
  const mayPlace = useMemo(() => {
    const allowed = new Map((read?.sites ?? []).map((site) => [site.id, site.mayPlace]))
    return (siteId: string) => allowed.get(siteId) ?? false
  }, [read])
  const heldOf = useMemo(
    () => (item: TreeItem) => {
      if (item.type === 'group') return null
      const held = nodeHeld(item.node, mayPlace, sites)
      return held ? t(held.key, held.params) : null
    },
    [mayPlace, sites, t],
  )
  const plan = read ? planOf(read, model.selected) : null
  const words = plan ? summaryWords(plan.counts, t) : null
  const problems = genealogyProblems(draft, read, model.selected, reasons, model.today)
  const held = model.held ? t(model.held) : model.busy ? q('common.working') : problems.length > 0 ? t(problems[0]!) : null
  const set = (change: Partial<GenealogyDraft>) => actions?.onDraft?.({ ...draft, ...change })
  const reason = reasons.find((entry) => entry.code === draft.reasonCode) ?? null
  const labelOf = (entry: { labelIt: string; labelEn: string }) => (locale === 'it' ? entry.labelIt || entry.labelEn : entry.labelEn || entry.labelIt)
  const gaps = read ? quarantineGaps(read, model.selected) : []
  const [typed, setTyped] = useState(draft.code)
  useEffect(() => setTyped(draft.code), [draft.code])

  useEffect(() => {
    if (!model.open) return
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !held) {
        event.preventDefault()
        actions?.onPlace?.()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  if (!model.open) return null
  const finding = model.find.state === 'finding'
  return (
    <Modal
      open
      onClose={() => actions?.onClose?.()}
      size="xxl"
      title={model.holdId ? t('genealogy.titleExtend') : t('genealogy.title')}
      subtitle={read ? t('genealogy.subtitle', { kind: t(`kind.${read.start.type}`), code: read.start.code }) : t('genealogy.subtitleStart')}
      footer={
        <span className="fw-q-actions">
          <Button variant="secondary" onClick={() => actions?.onClose?.()}>
            {q('common.cancel')}
          </Button>
          <Button variant="primary" heldReason={held} onClick={() => actions?.onPlace?.()}>
            <GitBranch size={14} aria-hidden /> {words && !words.nothing ? words.head : t('genealogy.goNone')} <Kbd>⌘↵</Kbd>
          </Button>
        </span>
      }
    >
      <div className="fw-q-stack">
        {model.problem && (
          <Banner
            tone="danger"
            title={t(model.problem)}
            action={
              model.problem === 'genealogy.refusedPicks' ? (
                <Button size="sm" onClick={() => actions?.onRetry?.()}>
                  {t('genealogy.readAgain')}
                </Button>
              ) : undefined
            }
          >
            {model.lines && model.lines.length > 0 && (
              <ul className="fw-q-lines">
                {model.lines.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            )}
          </Banner>
        )}
        {model.holdId && model.read?.value?.group && <p className="fw-q-hint">{t('genealogy.extendGroup', { code: model.read.value.group.sourceCode ?? '—', count: model.read.value.group.holds.length })}</p>}
        {model.holdId && model.read?.value && !model.read.value.group && <p className="fw-q-hint">{t('genealogy.extendNew')}</p>}

        {!model.start && (
          <form
            className="fw-hd-start"
            onSubmit={(event) => {
              event.preventDefault()
              actions?.onDraft?.({ ...draft, code: typed })
              actions?.onFind?.()
            }}
          >
            <Field label={t('genealogy.start')} hint={t('genealogy.startHint')} error={model.find.state === 'none' ? t('genealogy.findNone', { code: draft.code }) : model.find.state === 'error' ? q(model.find.problem ?? 'problem.unavailable') : undefined}>
              <Input value={typed} onChange={(event) => setTyped(event.target.value)} onBlur={() => typed !== draft.code && actions?.onDraft?.({ ...draft, code: typed })} placeholder={t('genealogy.startPlaceholder')} aria-label={t('genealogy.start')} autoFocus />
            </Field>
            <Button type="submit" size="sm" heldReason={!typed.trim() ? t('genealogy.typeFirst') : finding ? q('common.working') : null}>
              <Search size={14} aria-hidden /> {t('genealogy.find')}
            </Button>
          </form>
        )}

        <section className="fw-hd-genealogy" aria-live="polite" aria-label={t('genealogy.tree')}>
          {model.read === null ? (
            <p className="fw-q-hint">{t('genealogy.empty')}</p>
          ) : model.read.problem ? (
            <Banner
              tone="danger"
              title={t('genealogy.failed')}
              action={
                <Button size="sm" onClick={() => actions?.onRetry?.()}>
                  {q('common.retry')}
                </Button>
              }
            >
              {q(model.read.problem)}
            </Banner>
          ) : read === null ? (
            <p className="fw-q-loading" role="status">
              <Spinner size={14} /> {t('genealogy.reading')}
            </p>
          ) : (
            <>
              {words && (
                <p className="fw-hd-summary" role="status">
                  <strong>{words.nothing ? t('genealogy.holdNothing') : `${words.head}${words.shipped ? '' : '.'}`}</strong>
                  {words.shipped ? <span>{`; ${words.shipped}.`}</span> : null}
                </p>
              )}
              {plan && (plan.covered.length > 0 || plan.alreadyHeld.length > 0) && (
                <p className="fw-q-hint">
                  {[plan.covered.length > 0 ? t('genealogy.covered', { count: plan.covered.length }) : null, plan.alreadyHeld.length > 0 ? t('genealogy.alreadyHeld', { count: plan.alreadyHeld.length }) : null].filter(Boolean).join(' ')}
                </p>
              )}
              <dl className="fw-hd-states" aria-label={t('affected.states')}>
                <States states={read.states} />
              </dl>
              <ImpactTree
                impact={read}
                items={items}
                label={t('genealogy.treeLabel', { code: read.start.code })}
                prefix={prefix}
                reasons={reasonWords}
                selection={{ selected: model.selected, onChange: (ids) => actions?.onSelect?.(ids) }}
                heldOf={heldOf}
                affectedOnly={model.affectedOnly}
                onAffectedOnly={(on) => actions?.onAffectedOnly?.(on)}
                empty={t('genealogy.nothingMade')}
                openDepth={7}
              />
            </>
          )}
        </section>

        <div className="fw-q-form fw-q-form-two">
          <Field label={t('place.reason')}>
            {model.reasons.problem ? (
              <Banner tone="danger" title={q(model.reasons.problem)} />
            ) : model.reasons.value === null ? (
              <Skeleton height={32} />
            ) : (
              <Select value={draft.reasonCode ?? ''} onChange={(event) => set({ reasonCode: event.target.value || null })} aria-label={t('place.reason')}>
                <option value="">{t('place.reasonPick')}</option>
                {reasons.map((entry) => (
                  <option key={entry.code} value={entry.code}>
                    {labelOf(entry)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={t('place.reasonNote')} hint={reason?.needsDetail ? t('place.reasonNoteNeeded') : t('genealogy.reasonNoteHint')}>
            <Input value={draft.reasonNote} onChange={(event) => set({ reasonNote: event.target.value })} maxLength={500} />
          </Field>
          <Field label={t('place.owner')} hint={t('place.ownerHint')}>
            {model.people === null ? (
              <p className="fw-q-hint">{t('place.ownerAfter')}</p>
            ) : model.people.problem ? (
              <Banner tone="danger" title={q(model.people.problem)} />
            ) : model.people.value === null ? (
              <Skeleton height={32} />
            ) : (
              <Select value={draft.ownerId ?? ''} onChange={(event) => set({ ownerId: event.target.value || null })} aria-label={t('place.owner')}>
                <option value="">{t('owner.nobody')}</option>
                {model.people.value.map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.me ? t('owner.meNamed', { name: person.name }) : person.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={t('place.expected')} hint={t('place.expectedHint')}>
            <Input type="date" min={model.today} value={draft.expectedReleaseOn} onChange={(event) => set({ expectedReleaseOn: event.target.value })} aria-label={t('place.expected')} />
          </Field>
          <Field label={t('place.quarantine')} hint={gaps.length > 0 && draft.askQuarantine ? t('genealogy.quarantineGap', { sites: gaps.map((gap) => gap.code).join(', ') }) : t('genealogy.quarantineHint')}>
            <Toggle checked={draft.askQuarantine} onChange={(on) => set({ askQuarantine: on })} aria-label={t('place.quarantine')} />
          </Field>
          <Field label={t('place.note')}>
            <Textarea rows={2} value={draft.note} onChange={(event) => set({ note: event.target.value })} />
          </Field>
        </div>
        <p className="fw-q-hint">{t('genealogy.after')}</p>
      </div>
    </Modal>
  )
}

/** What the tree touches by state (design Hold › Affected: in stock · in work · packed · shipped, with customers). */
export function States({ states }: { states: { material: readonly { uom: string; onHand: string }[]; hidesInStock: number; garments: { inWork: number; inStock: number; packed: number; shipped: number; returned: number }; customers: number } }) {
  const t = useT('holds')
  const locale = useLocale()
  const uomWord = useUomWord()
  const material = states.material.map((entry) => `${new Intl.NumberFormat(locale === 'it' ? 'it-IT' : 'en-GB', { maximumFractionDigits: 2 }).format(Number(entry.onHand))} ${uomWord(entry.uom)}`).join(' + ')
  const rows: { key: string; value: string }[] = [
    { key: 'affected.material', value: material || (states.hidesInStock > 0 ? t('affected.hides', { count: states.hidesInStock }) : '—') },
    { key: 'affected.inWork', value: t('quantity.garments', { count: states.garments.inWork }) },
    { key: 'affected.inStock', value: t('quantity.garments', { count: states.garments.inStock }) },
    { key: 'affected.packed', value: t('quantity.garments', { count: states.garments.packed }) },
    { key: 'affected.shipped', value: `${t('quantity.garments', { count: states.garments.shipped })} · ${t('genealogy.customers', { count: states.customers })}` },
  ]
  return (
    <>
      {rows.map((row) => (
        <div key={row.key} className="fw-hd-state">
          <dt>{t(row.key)}</dt>
          <dd>{row.value}</dd>
        </div>
      ))}
    </>
  )
}

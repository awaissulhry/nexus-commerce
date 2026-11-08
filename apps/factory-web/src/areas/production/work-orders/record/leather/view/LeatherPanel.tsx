'use client'

import Link from 'next/link'
import { Card } from '@nexus/ui/components'
import { Button, Pill, Spinner } from '@nexus/ui/primitives'
import { useT } from '../../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../../record-panels/i18n'
import type { WorkOrderLeather } from '../api'
import { hidesPhrases, lotHref, rulePhrase, verdictOf, type Phrase } from '../model'

/** The Leather panel's model: its read (null value while it loads; a problem when it failed). */
export interface LeatherPanelModel {
  readonly prefix: string
  readonly read: { readonly value: WorkOrderLeather | null; readonly problem: string | null }
}

const NS = 'production-cutboard'

/**
 * SCR-070 Materials › Leather (B-W2b-130; design wo-leather "lot(s) and shade group (W1 the cutter keeps one dye batch by hand; W2b
 * one shade lot rule, SCM-206) · hides"): the site's shade rule in words, then per leather of the work order its shade lots (a lot
 * and its shade group) with the hides it holds, has reserved and has cut, and whether they keep the rule — said in words, a lot
 * opening its record. Nothing here moves stock: Reserve leather… and the pick stay where they are.
 */
export function LeatherPanel({ model, onRetry }: { model: LeatherPanelModel; onRetry?: () => void }) {
  return (
    <WithMessages namespaces={['production', NS]}>
      <Leather model={model} onRetry={onRetry} />
    </WithMessages>
  )
}

function Leather({ model, onRetry }: { model: LeatherPanelModel; onRetry?: () => void }) {
  const t = useT(NS)
  const tp = useT('production')
  const say = (words: Phrase) => t(words.key, words.params)
  const leather = model.read.value
  if (leather && leather.materials.length === 0) return null
  return (
    <Card padded className="fw-pr-card">
      <div className="fw-pr-card-head">
        <h2 className="fw-pr-h2">{t('leather.title')}</h2>
        {leather && <span className="fw-pr-hint">{say(rulePhrase(leather))}</span>}
      </div>
      {model.read.problem ? (
        <p className="fw-pr-hint">
          {t('leather.failed', { why: tp(model.read.problem) })}{' '}
          <Button size="sm" variant="ghost" onClick={() => onRetry?.()}>
            {t('board.retry')}
          </Button>
        </p>
      ) : !leather ? (
        <p className="fw-pr-hint" role="status">
          <Spinner size={12} /> {t('board.loading')}
        </p>
      ) : (
        <div className="fw-pr-stack">
          {leather.materials.map((material) => {
            const verdict = verdictOf(material)
            return (
              <div key={`${material.item.id}:${material.colour?.id ?? ''}`} className="fw-pr-stack">
                <div className="fw-pr-card-head">
                  <h3 className="fw-pr-h3">
                    {material.item.code}
                    {material.colour ? ` · ${material.colour.code}` : ''}
                  </h3>
                  <Pill tone={verdict.tone}>{say(verdict.words)}</Pill>
                </div>
                <span className="fw-pr-hint">{t('leather.hides', { held: material.hides.held, reserved: material.hides.reserved, cut: material.hides.cut })}</span>
                {material.lots.length > 0 && (
                  <ul className="fw-pr-list" aria-label={t('leather.lotsLabel', { material: material.item.code })}>
                    {material.lots.map((lot) => (
                      <li key={lot.key}>
                        <Link className="fw-pr-link" href={lotHref(model.prefix, lot.lot)}>
                          {lot.lot.code}
                        </Link>{' '}
                        {lot.shade ? t('leather.shade', { shade: lot.shade }) : t('leather.unsorted')}
                        {lot.lot.supplierLotRef ? ` · ${t('leather.supplierLot', { ref: lot.lot.supplierLotRef })}` : ''}
                        {' · '}
                        {hidesPhrases(lot).map(say).join(' · ')}
                        {lot.outOfShade && (
                          <>
                            {' '}
                            <Pill tone="danger">{t('leather.outOfShadeTag')}</Pill>
                          </>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                {material.breaksRule && <p className="fw-pr-hint">{t('leather.breaksHint')}</p>}
              </div>
            )
          })}
        </div>
      )}
    </Card>
  )
}

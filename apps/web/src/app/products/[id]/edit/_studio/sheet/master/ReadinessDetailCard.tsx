'use client'

import { Button } from '@/design-system/primitives'
import type { ReadinessDetailModel } from './readinessDetail'

/**
 * A-45 (Step 4.3 #4) — draws the completeness card's model (`readinessDetail.ts`, pure and tested) inside the
 * DS `DetailPopover`. It decides nothing: text, grouping, the cap and each action come from the model.
 * Classes are the DS's `nds-detailpop-*` (the stylesheet block ships with `DetailPopover`); text uses
 * `--nds-text-strong` / `--nds-text` only (R-49 — `text-2` / `text-3` fail 7:1 today).
 */
export function ReadinessDetailCard({ model, onGoTo, onCustomise, close }: {
  model: ReadinessDetailModel
  onGoTo: (field: string) => void
  onCustomise: () => void
  close: (options?: { returnFocus?: boolean }) => void
}) {
  return (
    <div className="nds-detailpop-body">
      <div className="nds-detailpop-h">{model.title}</div>
      {model.summary && <p className="nds-detailpop-note">{model.summary}</p>}
      {model.groups.map(group => (
        <section key={group.id} className="nds-detailpop-group" aria-label={group.heading}>
          <div className="nds-detailpop-gh">{group.heading}</div>
          <ul className="nds-detailpop-list">
            {group.items.map(item => (
              <li key={`${group.id}:${item.field}`} className="nds-detailpop-item">
                <span className="nds-detailpop-what">
                  <span className="nds-detailpop-label">{item.label}</span>
                  {item.reason && <span className="nds-detailpop-reason">{item.reason}</span>}
                </span>
                {item.action.kind === 'goto' && (
                  <Button variant="quiet" size="xs" onClick={() => { close(); onGoTo(item.field) }}>{item.action.label}</Button>
                )}
                {item.action.kind === 'customise' && (
                  <Button variant="quiet" size="xs" onClick={() => { close(); onCustomise() }}>{item.action.label}</Button>
                )}
                {item.action.kind === 'elsewhere' && <span className="nds-detailpop-reason">{item.action.text}</span>}
              </li>
            ))}
          </ul>
        </section>
      ))}
      {model.more > 0 && <p className="nds-detailpop-note">+ {model.more} more</p>}
      {model.notRecordedYet && <p className="nds-detailpop-note">{model.notRecordedYet}</p>}
      {model.footer && <div className="nds-detailpop-foot">{model.footer}</div>}
    </div>
  )
}

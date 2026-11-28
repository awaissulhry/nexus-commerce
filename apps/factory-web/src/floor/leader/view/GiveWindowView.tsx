'use client'

import { Check, CircleAlert, UserRound } from 'lucide-react'
import { FloorButton } from '@nexus/ui/floor'
import { Modal } from '../../../lib/i18n/ds-parts'
import { useT } from '../../../lib/i18n/provider'
import { BASKET_NS, Flag } from '../../basket/parts'
import '../../basket/basket.css'

/**
 * owb-fl6 step 3 (design § 5zg C "Give to… opens the people of the team, each with what he or she holds now. One tap gives the basket";
 * P/fsteps.js ftoModal; round 36: the Undo bar offers Undo) — a centred window, a sheet on a phone. The other way round too (Who has
 * what: a person first, then one of the team's baskets). A name only where the site names workers; else "Person 3". View only.
 */

export interface GivePerson {
  readonly key: string
  /** Shown name: the person's, or "Person n" where names are not shown. */
  readonly label: string
  /** What the person holds now (a basket's code), or null: free. */
  readonly holds: string | null
  /** Holds THIS basket now. */
  readonly current: boolean
}

export interface GiveBasket {
  readonly bundleId: string
  readonly code: string
}

export interface GiveWindowModel {
  readonly open: boolean
  readonly title: string
  readonly state: 'loading' | 'ready' | 'failed'
  /** basket → person: the people; person → basket: the baskets. */
  readonly people: readonly GivePerson[] | null
  readonly baskets: readonly GiveBasket[] | null
  readonly said: string | null
  readonly busy: boolean
}

export type GiveAction = { readonly type: 'close' } | { readonly type: 'person'; readonly key: string } | { readonly type: 'basket'; readonly bundleId: string }

export function GiveWindowView({ model, onAction }: { readonly model: GiveWindowModel; readonly onAction: (action: GiveAction) => void }) {
  const tb = useT(BASKET_NS)
  const held = model.busy ? tb('homePage.loading') : null
  return (
    <Modal open={model.open} onClose={() => onAction({ type: 'close' })} title={model.title} size="sm" sheet className="fw-floor-dialog">
      <div className="fw-floor-dialog-body">
        {model.state === 'loading' ? <p className="fw-bk-muted" aria-busy="true">{tb('steps.loading')}</p> : null}
        {model.state === 'failed' ? <p role="alert" className="fw-floor-notice" data-tone="danger">{tb('steps.failed')}</p> : null}
        {model.said ? (
          <p role="status" className="fw-floor-notice" data-tone="warning">
            <span className="fw-floor-inline-icon" aria-hidden="true">
              <CircleAlert />
            </span>
            <bdi>{model.said}</bdi>
          </p>
        ) : null}
        {model.state === 'ready' && model.people ? (
          model.people.length > 0 ? (
            <div className="fw-bk-people" role="group" aria-label={model.title}>
              <p className="fw-floor-dialog-line">{tb('give.whom')}</p>
              {model.people.map((person) => (
                <FloorButton key={person.key} size="md" variant={person.current ? 'primary' : 'secondary'} aria-pressed={person.current} icon={person.current ? <Check /> : <UserRound />} heldReason={held} onClick={() => onAction({ type: 'person', key: person.key })}>
                  <bdi>{person.label}</bdi>
                  {person.holds ? (
                    <Flag tone="info" icon={<UserRound />}>
                      <bdi>{person.holds}</bdi>
                    </Flag>
                  ) : (
                    <Flag tone="success" icon={<Check />}>
                      {tb('give.free')}
                    </Flag>
                  )}
                </FloorButton>
              ))}
            </div>
          ) : (
            <p className="fw-bk-muted">{tb('give.nobody')}</p>
          )
        ) : null}
        {model.state === 'ready' && model.baskets ? (
          model.baskets.length > 0 ? (
            <div className="fw-bk-people" role="group" aria-label={model.title}>
              {model.baskets.map((basket) => (
                <FloorButton key={basket.bundleId} size="md" variant="secondary" heldReason={held} onClick={() => onAction({ type: 'basket', bundleId: basket.bundleId })}>
                  <bdi className="fw-bk-code">{basket.code}</bdi>
                </FloorButton>
              ))}
            </div>
          ) : (
            <p className="fw-bk-muted">{tb('give.noneToGive')}</p>
          )
        ) : null}
      </div>
    </Modal>
  )
}

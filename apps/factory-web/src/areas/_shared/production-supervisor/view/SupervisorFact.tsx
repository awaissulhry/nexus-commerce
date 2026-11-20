'use client'

import { BellOff, UserCog } from 'lucide-react'
import { Button, Tag } from '@nexus/ui/primitives'
import { useT } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import { SUPERVISOR_NS, type SupervisorFact as Fact } from '../model'
import type { SupervisorFace, SupervisorHeld } from '../model' // F-OO-132
import '../production-supervisor.css'

/**
 * F-PR-21 — the band's supervisor fact (17-web-r2 §1.1 "Supervisor Bea Esempio · this order [Change…]"): the person by name (inside
 * this one record only), "· this order" or "· customer default", "no longer active", "Not set"; nothing for a work order of no
 * customer order. Only to the supervisor himself, when he muted the order's thread: "You muted this order" (a muted follow stays
 * muted). Change… opens THE assign dialog; held in words without production.brand.manage.
 *
 * F-OO-132 (order overview lane; 10-design §3.2): two faces. 'line' is the band's inline fact, the work order pages' look as it was.
 * 'row' draws the value and the doors of a label-left row (the order Overview's People: the row's label says "Supervisor"), with
 * Change… only where the caller gives it (Read-only sees none). `held` says why Change… waits, each in its own words: no right, the
 * order waits for its yes, the order left production (`supervisorHeldOf`); null: it may.
 */
export function SupervisorFact(props: { fact: Fact; face: SupervisorFace; held: SupervisorHeld | null; onChange?: () => void; /** F-PR-22: "Ask" — the page's note dialog (its words and hold). */ ask?: AskProps }) {
  if (props.fact.kind === 'none') return null
  return <WithMessages namespaces={[SUPERVISOR_NS]}>{props.face === 'row' ? <FactRow {...props} /> : <FactLine {...props} />}</WithMessages>
}

// ---- F-PR-22: the fact's "Ask" (17-web-r2 §1.1 "Supervisor Bea Esempio · this order [Change…] [Ask]"): the caller's note dialog. ----
interface AskProps {
  readonly label: string
  /** Why it waits (no threads.post), in words; null: it may. */
  readonly held: string | null
  readonly onAsk: () => void
}
// ---- end F-PR-22

interface FaceProps {
  readonly fact: Fact
  readonly held: SupervisorHeld | null
  readonly onChange?: () => void
  readonly ask?: AskProps
}

function FactLine({ fact, held, onChange, ask }: FaceProps) {
  const t = useT(SUPERVISOR_NS)
  if (fact.kind === 'none') return null
  return (
    <span className="fw-psv-fact">
      <UserCog size={13} aria-hidden />
      {fact.kind === 'notSet' ? (
        <span>{t('fact.notSet')}</span>
      ) : (
        <span>
          {t('fact.label', { name: fact.name })} <span className="fw-psv-hint">· {t(`fact.from.${fact.from}`)}</span>
        </span>
      )}
      <FactTags fact={fact} />
      <Button size="sm" variant="quiet" heldReason={held ? t(`held.${held}`) : null} onClick={() => onChange?.()} aria-haspopup="dialog">
        {t('fact.change')}
      </Button>
      {/* F-PR-22 */}
      {ask && <AskDoor ask={ask} />}
    </span>
  )
}

// ---- F-OO-132: the 'row' face — the value cell, then the doors cell (only the doors the caller gives) ----------------------------
function FactRow({ fact, held, onChange, ask }: FaceProps) {
  const t = useT(SUPERVISOR_NS)
  if (fact.kind === 'none') return null
  return (
    <>
      <span className="fw-psv-value">
        {fact.kind === 'notSet' ? (
          <span>{t('mark.NOT_SET')}</span>
        ) : (
          <span>
            {fact.name} <span className="fw-psv-hint">· {t(`fact.from.${fact.from}`)}</span>
          </span>
        )}
        <FactTags fact={fact} />
      </span>
      {(onChange || ask) && (
        <span className="fw-psv-doors">
          {onChange && (
            <Button size="sm" variant="quiet" heldReason={held ? t(`held.${held}`) : null} onClick={onChange} aria-haspopup="dialog">
              {t('fact.change')}
            </Button>
          )}
          {ask && <AskDoor ask={ask} />}
        </span>
      )}
    </>
  )
}
// ---- end F-OO-132

/** "no longer active"; "You muted this order" only to the supervisor himself. */
function FactTags({ fact }: { fact: Fact }) {
  const t = useT(SUPERVISOR_NS)
  if (fact.kind !== 'person') return null
  return (
    <>
      {!fact.active && <Tag tone="warning">{t('fact.inactive')}</Tag>}
      {fact.muted && (
        <Tag tone="info" title={t('fact.mutedHint')}>
          <BellOff size={11} aria-hidden /> {t('fact.muted')}
        </Tag>
      )}
    </>
  )
}

function AskDoor({ ask }: { ask: AskProps }) {
  return (
    <Button size="sm" variant="quiet" heldReason={ask.held} onClick={ask.onAsk} aria-haspopup="dialog">
      {ask.label}
    </Button>
  )
}

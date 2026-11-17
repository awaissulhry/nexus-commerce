'use client'

import { BellOff, UserCog } from 'lucide-react'
import { Button, Tag } from '@nexus/ui/primitives'
import { useT } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import { SUPERVISOR_NS, type SupervisorFact as Fact } from '../model'
import '../production-supervisor.css'

/**
 * F-PR-21 — the band's supervisor fact (17-web-r2 §1.1 "Supervisor Bea Esempio · this order [Change…]"): the person by name (inside
 * this one record only), "· this order" or "· customer default", "no longer active", "Not set"; nothing for a work order of no
 * customer order. Only to the supervisor himself, when he muted the order's thread: "You muted this order" (a muted follow stays
 * muted). Change… opens THE assign dialog; held in words without production.brand.manage (`can`).
 */
export function SupervisorFact(props: { fact: Fact; can: boolean; onChange?: () => void; /** F-PR-22: "Ask" — the page's note dialog (its words and hold). */ ask?: AskProps }) {
  if (props.fact.kind === 'none') return null
  return (
    <WithMessages namespaces={[SUPERVISOR_NS]}>
      <FactLine {...props} />
    </WithMessages>
  )
}

// ---- F-PR-22: the fact's "Ask" (17-web-r2 §1.1 "Supervisor Bea Esempio · this order [Change…] [Ask]"): the caller's note dialog. ----
interface AskProps {
  readonly label: string
  /** Why it waits (no threads.post), in words; null: it may. */
  readonly held: string | null
  readonly onAsk: () => void
}
// ---- end F-PR-22

function FactLine({ fact, can, onChange, ask }: { fact: Fact; can: boolean; onChange?: () => void; ask?: AskProps }) {
  const t = useT(SUPERVISOR_NS)
  const held = can ? null : t('held.noRight')
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
      {fact.kind === 'person' && !fact.active && <Tag tone="warning">{t('fact.inactive')}</Tag>}
      {fact.kind === 'person' && fact.muted && (
        <Tag tone="info" title={t('fact.mutedHint')}>
          <BellOff size={11} aria-hidden /> {t('fact.muted')}
        </Tag>
      )}
      <Button size="sm" variant="quiet" heldReason={held} onClick={() => onChange?.()} aria-haspopup="dialog">
        {t('fact.change')}
      </Button>
      {/* F-PR-22 */}
      {ask && (
        <Button size="sm" variant="quiet" heldReason={ask.held} onClick={ask.onAsk} aria-haspopup="dialog">
          {ask.label}
        </Button>
      )}
    </span>
  )
}

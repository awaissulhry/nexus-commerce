'use client'

import Link from 'next/link'
import { Users } from 'lucide-react'
import { formatDate } from '../../../../../../lib/i18n/format'
import { useLocale } from '../../../../../../lib/i18n/provider'
import { Quiet, Section } from '../../../../../../lib/record-sections/Kit'
import { useFlowWords } from '../../../../orders/record/flow-words'
import type { FactoryPeopleCard as Card } from '../../people/factory-people'

/**
 * owb-of7 step 3 — "Factory people" on the customer's People & addresses tab: who of the factory is given to this customer (their names,
 * their role in words, since when); a door to People › People by customer for the owner and admin only (sales sees the names, no door).
 * Draws its model; fetches nothing.
 */
export function FactoryPeopleCard({ card, prefix }: { readonly card: Card; readonly prefix: string }) {
  const f = useFlowWords()
  const locale = useLocale()
  return (
    <Section
      id="factory-people"
      title={f('factoryPeople.title')}
      answer={card.people.length > 0 ? f('factoryPeople.count', { count: card.people.length }) : null}
      more={
        card.door ? (
          <Link className="fw-pt-link" href={`${prefix}/people/by-customer`}>
            {f('factoryPeople.door')}
          </Link>
        ) : undefined
      }
      info={<p>{f('factoryPeople.info')}</p>}
    >
      {card.people.length === 0 ? (
        <Quiet>{f('factoryPeople.none')}</Quiet>
      ) : (
        <ul className="fw-ca-factory">
          {card.people.map((person) => (
            <li key={person.userId}>
              <Users size={14} aria-hidden /> <strong>{person.name}</strong> <span className="fw-so-hint">· {person.roleWords} · {f('factoryPeople.since', { date: formatDate(person.since, { locale }) })}</span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  )
}

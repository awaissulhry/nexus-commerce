'use client'

import { AliasMark } from '@/design-system/primitives'

import { destinationNameParts, type MediaDestinationRow } from './model'

/** How a set's source reads in Compare and in the side panel's list of destinations. */
export const SOURCE = {
  shared: { kind: 'master' as const, text: 'follows Shared' },
  channel: { kind: 'channel' as const, text: 'own for the channel' },
  own: { kind: 'override' as const, text: 'own photos' },
  none: { kind: 'missing' as const, text: 'not set' },
}

/** A destination's name with the DS AliasMark (★ ①②③) as a real mark, for titles; text contexts use `destinationLabel`. */
export function DestinationName({ d }: { d: MediaDestinationRow }) {
  const { head, name } = destinationNameParts(d)
  return <>{head}{name !== null && <> · {d.listingMark != null && <><AliasMark position={d.listingMark} /> </>}{name}</>}</>
}

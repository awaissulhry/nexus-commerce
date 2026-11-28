'use client'

import type { PictureSource } from '../model'
import { PeoplePicture } from './PeoplePicture'

/**
 * owb-b5 (w5.4) — a team as one chip: its picture and its name, in every place that names a team (the order's Team part, the board,
 * the leader's card, Give to…). Not a button: a host that makes it a door wraps it. Draws what the host read; fetches nothing.
 * Owner after the base: S3.
 */
export interface TeamChipProps {
  /** The team as read: its name and its picture columns (Team.pictureKind, pictureIcon, pictureColour); always drawn as a team. */
  readonly team: PictureSource & { readonly name: string }
}

export function TeamChip({ team }: TeamChipProps) {
  return (
    <span className="fw-ppic-chip">
      <PeoplePicture source={{ ...team, who: 'team' }} size="sm" nameBeside />
      <span className="fw-ppic-name" title={team.name}>
        {team.name}
      </span>
    </span>
  )
}

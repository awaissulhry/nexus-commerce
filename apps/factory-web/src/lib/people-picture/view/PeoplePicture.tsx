'use client'

import type { ReactElement } from 'react'
import { Briefcase, Factory, Flag, ImageIcon, Layers, Package, Ruler, Scissors, Shield, Shirt, Truck, Users } from 'lucide-react'
import { pictureOf, type PictureIcon, type PictureSource } from '../model'
import '../people-picture.css'

/**
 * owb-b5 (w5.4; design plan § 5zb; Owner decision K) — a person's or a team's picture: two letters or one of 12 lucide icons on one of
 * the 10 grid tones; a person round, a team a rounded square. No photo (the schema's no-photo rule). Draws what the host read;
 * fetches nothing. With the name in words beside it (`nameBeside`), the picture is hidden from screen readers; alone, it is an image
 * named by the name. Owner after the base: S3 (Factory structure, Teams); S2 and S5 draw it.
 */

const ICONS: Readonly<Record<PictureIcon, typeof Factory>> = {
  factory: Factory,
  shirt: Shirt,
  scissors: Scissors,
  layers: Layers,
  shield: Shield,
  ruler: Ruler,
  flag: Flag,
  package: Package,
  briefcase: Briefcase,
  image: ImageIcon,
  users: Users,
  truck: Truck,
}

/** The picture's size: 24 (a chip, a row), 32 (a list, the band), 48 (a profile head). */
const ICON_SIZE = { sm: 14, md: 16, lg: 24 } as const

export interface PeoplePictureProps {
  readonly source: PictureSource
  readonly size?: 'sm' | 'md' | 'lg'
  /** The name stands beside it in words: the picture says nothing to a screen reader. */
  readonly nameBeside?: boolean
}

export function PeoplePicture({ source, size = 'md', nameBeside = false }: PeoplePictureProps): ReactElement {
  const face = pictureOf(source)
  const Icon = face.icon ? ICONS[face.icon] : null
  const className = ['fw-ppic', `is-${size}`, `is-${face.who}`, `t-${face.tone}`].join(' ')
  const naming = nameBeside ? { 'aria-hidden': true as const } : { role: 'img', 'aria-label': face.name }
  return (
    <span className={className} {...naming}>
      {Icon ? <Icon size={ICON_SIZE[size]} aria-hidden /> : <span className="fw-ppic-l">{face.letters}</span>}
    </span>
  )
}

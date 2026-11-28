'use client'

import type { ReactElement } from 'react'
import { useT } from '../../../../lib/i18n/provider'
import { PeoplePicture } from '../../../../lib/people-picture/view/PeoplePicture'
import { PICTURE_ICONS, PICTURE_TONES, STRUCTURE_NS, type PictureDraft } from '../model'
import '../structure.css'

/**
 * owb-ss8 (8.2; design § 5zb "pictures, no signs": letters · 12 ready-made pictures · 10 colours; Owner pick K: no photo) — the picture
 * part of "Edit the profile": the letters or one of the 12 lucide pictures, on one of the 10 grid tones. Each choice is a pressed button
 * with the picture's name for a screen reader. Draws what it is given; fetches nothing.
 */
export function PicturePicker({ name, picture, onLetters, onIcon, onColour }: { name: string; picture: PictureDraft; onLetters: () => void; onIcon: (icon: string) => void; onColour: (colour: string) => void }): ReactElement {
  const t = useT(STRUCTURE_NS)
  const shown = name.trim() || t('unit.newName')
  return (
    <div className="fw-fs-pics">
      <div className="fw-fs-pic-row" role="group" aria-label={t('unit.picture')}>
        <button type="button" className="fw-fs-pic" aria-pressed={picture.kind === 'LETTERS'} aria-label={t('unit.pictureLetters')} onClick={onLetters}>
          <PeoplePicture source={{ name: shown, who: 'team', kind: 'LETTERS', colour: picture.colour }} nameBeside />
        </button>
        {PICTURE_ICONS.map((icon) => (
          <button key={icon} type="button" className="fw-fs-pic" aria-pressed={picture.kind === 'ICON' && picture.icon === icon} aria-label={t(`icon.${icon}`)} onClick={() => onIcon(icon)}>
            <PeoplePicture source={{ name: shown, who: 'team', kind: 'ICON', icon, colour: picture.colour }} nameBeside />
          </button>
        ))}
      </div>
      <div className="fw-fs-pic-row" role="group" aria-label={t('unit.colour')}>
        {PICTURE_TONES.map((tone) => (
          <button key={tone} type="button" className="fw-fs-tone" aria-pressed={picture.colour === tone} aria-label={t(`tone.${tone}`)} onClick={() => onColour(tone)}>
            <PeoplePicture source={{ name: shown, who: 'team', kind: 'LETTERS', colour: tone }} size="sm" nameBeside />
          </button>
        ))}
      </div>
    </div>
  )
}

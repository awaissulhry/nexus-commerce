'use client'

import type { ReactElement } from 'react'
import type { PictureSource } from '../model'
import { PeoplePicture } from './PeoplePicture'
import { TeamChip } from './TeamChip'

/**
 * owb-b5 (w5.4) — the people picture's lab (`/design/SCR-owb-people-picture`): pictures in their three sizes, the 12 icons, the 10
 * tones, the fallbacks (an unknown icon → letters, an unknown colour → slate) and team chips. Made-up names only. Fetches nothing.
 */
export interface PeoplePictureLabModel {
  readonly rows: readonly { readonly label: string; readonly pictures: readonly PictureSource[]; readonly chips?: boolean }[]
}

export function PeoplePictureLab({ model }: { model: PeoplePictureLabModel }): ReactElement {
  return (
    <div className="fw-ppic-lab">
      {model.rows.map((row) => (
        <section key={row.label} className="fw-ppic-lab-row" aria-label={row.label}>
          <h3 className="fw-ppic-lab-h">{row.label}</h3>
          <div className="fw-ppic-lab-set">
            {row.pictures.map((source, index) =>
              row.chips ? (
                <TeamChip key={`${index}-${source.name}`} team={{ ...source, name: source.name ?? '' }} />
              ) : (
                <span key={`${index}-${source.name}`} className="fw-ppic-lab-item">
                  <PeoplePicture source={source} size="sm" nameBeside />
                  <PeoplePicture source={source} />
                  <PeoplePicture source={source} size="lg" nameBeside />
                  <span className="fw-ppic-lab-name">{source.name ?? '—'}</span>
                </span>
              ),
            )}
          </div>
        </section>
      ))}
    </div>
  )
}

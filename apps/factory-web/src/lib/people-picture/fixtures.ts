import { defineDesignScreen } from '../design/design-screen'
import { PICTURE_ICONS, PICTURE_TONES } from './model'
import { PeoplePictureLab, type PeoplePictureLabModel } from './view/PeoplePictureLab'

/**
 * owb-b5 (w5.4) — the people picture's lab: letters, the 12 icons, the 10 tones, the fallbacks, team chips. Made-up names only.
 */
export const designScreen = defineDesignScreen<PeoplePictureLabModel>({
  screen: 'SCR-owb-people-picture',
  title: 'People picture — letters or one of 12 icons on 10 tones, no photo (owb-b5)',
  view: PeoplePictureLab,
  cases: [
    {
      id: 'letters',
      label: 'Letters: people and teams',
      model: {
        rows: [
          { label: 'People', pictures: [{ name: 'Dora Campione', colour: 'purple' }, { name: 'Noor', colour: 'emerald' }, { name: 'Sam Sales' }, { name: null }] },
          { label: 'Teams', pictures: [{ name: 'Team Noor', who: 'team', kind: 'LETTERS', colour: 'orange' }, { name: 'Cutting', who: 'team', kind: 'LETTERS', colour: 'blue' }] },
        ],
      },
      note: 'Two letters (a one-word name: its first two); no name: “?”; no colour: slate.',
    },
    {
      id: 'icons',
      label: 'The 12 icons',
      model: { rows: [{ label: 'Icons', pictures: PICTURE_ICONS.map((icon, index) => ({ name: `Team ${icon}`, who: 'team' as const, kind: 'ICON', icon, colour: PICTURE_TONES[index % PICTURE_TONES.length] })) }] },
      note: 'One lucide icon each; the needle of the design is the shirt (lucide has no needle).',
    },
    {
      id: 'tones',
      label: 'The 10 tones',
      model: { rows: [{ label: 'Tones', pictures: PICTURE_TONES.map((tone) => ({ name: `Team ${tone}`, who: 'team' as const, kind: 'LETTERS', colour: tone })) }] },
      note: 'The DS grid tones, light and dark from the tokens.',
    },
    {
      id: 'fallbacks',
      label: 'Fallbacks: an unknown icon, an unknown colour',
      model: { rows: [{ label: 'Fallbacks', pictures: [{ name: 'Team Alpha', who: 'team', kind: 'ICON', icon: 'needle', colour: 'pink' }, { name: 'Team Beta', who: 'team', kind: 'ICON', icon: 'scissors', colour: 'gold' }, { name: 'Team Gamma', who: 'team', kind: 'ICON', icon: null }] }] },
      note: 'An unknown icon shows the letters; an unknown colour is slate; never a hole.',
    },
    {
      id: 'chips',
      label: 'Team chips',
      model: { rows: [{ label: 'Team chips', chips: true, pictures: [{ name: 'Team Noor', kind: 'ICON', icon: 'scissors', colour: 'orange' }, { name: 'Stitching line B with a long name', kind: 'LETTERS', colour: 'cyan' }] }] },
      note: 'The picture + the name; a long name ends in “…” and shows whole on hover.',
    },
  ],
})

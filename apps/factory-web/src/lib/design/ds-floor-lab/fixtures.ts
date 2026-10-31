import { defineDesignScreen } from '../design-screen'
import { DsFloorLab, type DsFloorLabModel } from './view/DsFloorLab'

/**
 * The floor and people parts lab (`/design/ds-floor-parts`, B-W2b-28): FloorCard, FloorElapsed, FloorNamePicker,
 * FloorList's updates slot, read-aloud (D27), PinSignBlock (D22) and the display tier (D26) on the floor and display
 * tiers; LawRef, LegalGate, PrivacyNote, ProtectedValue, DayStrip, DueCell and DocumentSeal at the console's size — in
 * the gallery's language through `useDsLabels()`. Light and dark, 1440 and 390, Italian and English are the gallery's own
 * switches. Made-up data.
 */
export const designScreen = defineDesignScreen<DsFloorLabModel>({
  screen: 'ds-floor-parts',
  title: 'Floor and people DS parts (B-W2b-28)',
  view: DsFloorLab,
  cases: [
    { id: 'parts', label: 'Every part', model: {}, note: 'Every part working: pick a name, show the list change, sign with the PIN 246810, open the protected value, verify the demo file.' },
    { id: 'card-cached', label: 'Floor card: from the tablet’s cache', model: { show: 'floor', card: 'cached' }, note: 'The card says when the facts were read (offline).' },
    { id: 'names-offline', label: 'Names: held offline', model: { show: 'floor', names: 'offline' }, note: 'Held with the reason; every tile held.' },
    { id: 'names-empty', label: 'Names: no one set up', model: { show: 'floor', names: 'empty' } },
    { id: 'list-changed', label: 'Floor list: rows waiting', model: { show: 'floor', listChanged: true }, note: 'The rows on screen stay; the big Show button puts the new ones in.' },
    { id: 'sign-locked', label: 'PIN sign: locked', model: { show: 'floor', sign: 'locked' }, note: 'Too many wrong PINs: every key held, the reason in words.' },
    { id: 'sign-held', label: 'PIN sign: held offline', model: { show: 'floor', sign: 'held' } },
    { id: 'sign-done', label: 'PIN sign: signed', model: { show: 'floor', sign: 'done' } },
    { id: 'gate-on', label: 'Legal gate: on', model: { show: 'people', gate: 'on' }, note: 'Every condition met: folded to one line.' },
    { id: 'gate-on-open', label: 'Legal gate: on, a condition expired', model: { show: 'people', gate: 'on-open' }, note: 'Never folded; a warning line says so.' },
    { id: 'no-role', label: 'Protected value: no role', model: { show: 'people', role: false }, note: 'Restricted, and who may see it.' },
    { id: 'display', label: 'Display tier (line TV)', model: { show: 'display' }, note: 'The fourth density tier: 32 px body, 96 px numerals.' },
  ],
})

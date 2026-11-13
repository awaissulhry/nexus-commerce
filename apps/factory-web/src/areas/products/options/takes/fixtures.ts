import { defineDesignScreen } from '../../../../lib/design/design-screen'
import type { TakesView } from './api'
import { TakesCard, type TakesModel } from './view/TakesCard'

/**
 * SCR-432 — what a chosen value of an option group takes (B-W2b-374; XF3:05; Products › Options & rules › a group › Options),
 * made-up data only: the panels group DEMO-PANELS of a demo jacket, chosen on quotes and orders with library colours.
 */

const w = (it: string, en: string) => ({ it, en })
const VIEW: TakesView = { groupId: '11111111-0000-4000-8000-00000000a432', code: 'DEMO-PANELS', version: 4, takes: null, picking: { colours: 3, materials: 0 }, may: { change: true, held: null } }

const model = (extra: Partial<TakesModel> = {}): TakesModel => ({ read: { status: 'ready' }, view: VIEW, draft: VIEW.takes, saveHeld: { key: 'takes.held.unchanged' }, notice: null, offline: false, ...extra })

export const designScreen = defineDesignScreen<TakesModel>({
  screen: 'SCR-432',
  title: 'What a chosen value of an option group takes: a colour of the library, a material and its colour, or either',
  view: TakesCard,
  cases: [
    { id: 'either', label: 'Takes either (as before): both pickers are offered', model: model(), note: 'The group\'s Options tab, above the options.' },
    { id: 'colour-chosen', label: 'A colour of the library chosen: Save', model: model({ draft: 'COLOUR', saveHeld: null }) },
    { id: 'saved', label: 'Saved: the configurator offers only the colour picker', model: model({ view: { ...VIEW, takes: 'COLOUR', version: 5 }, draft: 'COLOUR', notice: { tone: 'success', words: { key: 'takes.saved' } } }) },
    { id: 'held-other-kind', label: 'Material asked while options pick library colours: Save held with why', model: model({ draft: 'MATERIAL', saveHeld: { key: 'takes.held.colours', params: { count: 3 } } }) },
    { id: 'refused', label: 'Refused by the API meanwhile (409 in words)', model: model({ draft: 'MATERIAL', saveHeld: null, notice: { tone: 'danger', words: { key: 'takes.problem.refused' } } }) },
    { id: 'saving', label: 'Saving', model: model({ draft: 'COLOUR', saveHeld: { key: 'takes.held.busy' } }) },
    { id: 'stale', label: 'Changed by someone else meanwhile', model: model({ draft: 'COLOUR', saveHeld: null, notice: { tone: 'danger', words: { key: 'takes.problem.stale' } } }) },
    { id: 'no-permission', label: 'A person who may only read it', model: model({ view: { ...VIEW, takes: 'MATERIAL', may: { change: false, held: w('Lo leggi: cambiarlo spetta a chi gestisce la libreria delle opzioni.', 'You may read it: changing it is for people who keep the option library.') } }, draft: 'MATERIAL' }) },
    { id: 'archived', label: 'An archived group: held with the reason', model: model({ view: { ...VIEW, may: { change: false, held: w('Il gruppo è archiviato: ripristinalo prima di cambiarlo.', 'The group is archived: restore it before changing it.') } } }) },
    { id: 'offline', label: 'Offline: Save held', model: model({ draft: 'COLOUR', offline: true, saveHeld: { key: 'takes.held.offline' } }) },
    { id: 'loading', label: 'Loading', model: model({ read: { status: 'loading' }, view: null }) },
    { id: 'error', label: 'Could not be read', model: model({ read: { status: 'error', problem: { key: 'takes.problem.load' } }, view: null }) },
  ],
})

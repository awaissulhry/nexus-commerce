import { defineDesignScreen } from '../../../lib/design/design-screen'
import { OverviewLab, type OverviewLabModel } from './view/OverviewLab'

/**
 * The shared overview kit's lab (`/design/record-overview`, F-CO-K1): every part of `areas/_shared/record-overview` alone, each in
 * three rooms — a 343 px card (a phone), a 425 px card (a pair's card beside the docked thread at 1440) and an 829 px card (a
 * full-width card there). This step holds the frame: the card (a bare title, a head row with its right side, the lead card, busy),
 * a card's loading and failed states, the headline (alone, with its quiet line, while read), a pair of two and of one, and the
 * frame's parts together. The record is made up — neither an order nor a customer; no name, no number, no amount.
 */
export const designScreen = defineDesignScreen<OverviewLabModel>({
  screen: 'record-overview',
  title: 'Shared record overview kit (F-CO-K1)',
  view: OverviewLab,
  cases: [
    { id: 'card', label: 'Card: a bare title', model: { show: 'card' }, note: 'No right side handed over (aside left out): the title alone, 12 px above the first row.' },
    { id: 'card-aside', label: 'Card: a head row with a link', model: { show: 'card-aside' }, note: 'The title and one right slot; the link carries the kit link and hint classes and takes the link colour.' },
    { id: 'card-aside-none', label: 'Card: a head row, nothing at its right', model: { show: 'card-aside-none' }, note: 'aside given as null: the head row keeps its shape while its right side has nothing to say.' },
    { id: 'card-lead', label: 'Lead card: the headline, its quiet line, content', model: { show: 'card-lead' }, note: 'The first card is a column: one 12 px gap between its parts.' },
    { id: 'card-busy', label: 'Card: busy', model: { show: 'card-busy' }, note: 'aria-busy on the card while its part is read; the title stays.' },
    { id: 'state-loading', label: 'Card state: loading', model: { show: 'state-loading' }, note: 'A whole card while its part loads: the spinner and "Loading {part}…".' },
    { id: 'state-failed', label: 'Card state: failed, with Try again', model: { show: 'state-failed' }, note: 'What went wrong in words (the page hands them), never a key.' },
    { id: 'state-failed-no-retry', label: 'Card state: failed, no Try again', model: { show: 'state-failed-no-retry' }, note: 'A page that cannot read it again hands no retry: no button.' },
    { id: 'headline', label: 'Headline: the sentence alone', model: { show: 'headline' } },
    { id: 'headline-quiet', label: 'Headline: with its quiet line', model: { show: 'headline-quiet' }, note: 'At 343 the sentence wraps: never a sideways scroll.' },
    { id: 'headline-reading', label: 'Headline: while it is read', model: { show: 'headline-reading' }, note: 'A placeholder of the sentence’s size; no quiet line before the sentence.' },
    { id: 'pair-two', label: 'Pair: two cards', model: { show: 'pair-two' }, note: 'Two equal columns in the 829 px room (720 px or wider), one column in the two narrow rooms; the two cards stretch to one height.' },
    { id: 'pair-one', label: 'Pair: one card', model: { show: 'pair-one' }, note: 'A card alone takes the whole row: never an empty cell.' },
    { id: 'overview', label: 'The frame together', model: { show: 'overview' }, note: 'The lead card, a pair of two, a pair of one: 16 px between them.' },
  ],
})

import { defineDesignScreen } from '../../lib/design/design-screen'
import { onFloor, signedInFrame } from '../frame/fixtures'
import { noticePages } from '../model'
import { NoticeView, type NoticeText, type NoticeViewModel } from './view/NoticeView'

/**
 * SCR-025's cases: the worker notice as the gate before the tile home. The text is a made-up SAMPLE (as the seed's):
 * the real notice comes from the company's privacy consultant.
 */

const IT = [
  'ESEMPIO - testo inventato per lo sviluppo. Il testo vero lo scrive il consulente privacy dell\'azienda.',
  'Cosa registra il tablet: quale fascio hai scansionato, a quale fase, quando e su quale postazione.',
  'Perché: i registri di produzione e di qualità.',
  'Chi lo vede: i totali di linea sul tabellone; in ufficio i ruoli che ne hanno bisogno.',
  'Cosa non registra mai: la tua posizione, dati biometrici, la telecamera, classifiche delle persone.',
  'I tuoi diritti: vedi i tuoi dati in La mia giornata e puoi contestare una registrazione. A chi chiedere: il personale e il referente privacy.',
].join('\n\n')
const EN = [
  'SAMPLE - made-up text for development. The real text comes from the company\'s privacy consultant.',
  'What the tablet records: which bundle you scanned, at which operation, when and at which station.',
  'Why: the production and quality records.',
  'Who sees it: line totals on the board; in the office the roles that need it.',
  'What is never recorded: where you are, biometric data, the camera, rankings of people.',
  'Your rights: see your own records on My day and dispute an entry. Who to ask: HR and the data protection contact.',
].join('\n\n')

const text = (locale: 'it' | 'en', extra: Partial<NoticeText> = {}): NoticeText => ({ label: '2026-10', locale, languages: ['it', 'en'], languageReady: true, pages: noticePages(locale === 'it' ? IT : EN), ...extra })
const notice = (state: NoticeViewModel['state'], blocksScans = true): NoticeViewModel => ({ frame: signedInFrame('notice.title'), state, blocksScans })
const last = (locale: 'it' | 'en') => text(locale).pages.length - 1

export const designScreen = defineDesignScreen<NoticeViewModel>({
  screen: 'SCR-025',
  title: 'Worker notice (the gate before Home)',
  view: onFloor(NoticeView),
  cases: [
    { id: 'first-page', label: 'Page 1, scans held', model: notice({ kind: 'reading', notice: text('it'), page: 0 }), note: 'Opens after sign-in while the version in force is not acknowledged. Big Next and Back, no swipe.' },
    { id: 'middle-page', label: 'A middle page', model: notice({ kind: 'reading', notice: text('it'), page: 1 }) },
    { id: 'last-page', label: 'Last page: I have read it', model: notice({ kind: 'reading', notice: text('it'), page: last('it') }), note: 'The button exists only on the last page. What it means is said in one line.' },
    { id: 'sending', label: 'Sending the acknowledgement', model: notice({ kind: 'reading', notice: text('it'), page: last('it'), busy: true }) },
    { id: 'english', label: 'In English (the worker\'s language)', model: notice({ kind: 'reading', notice: text('en'), page: 0 }) },
    {
      id: 'language-not-ready',
      label: 'The worker\'s language is not ready',
      model: notice({ kind: 'reading', notice: text('it', { languageReady: false }), page: 0 }),
      note: 'A worker who reads Romanian: Italian is shown, and HR gives a paper copy in their language.',
    },
    { id: 'not-blocking', label: 'A station site (nothing held)', model: notice({ kind: 'reading', notice: text('it'), page: 0 }, false) },
    { id: 'done', label: 'Acknowledged', model: notice({ kind: 'done', label: '2026-10' }), note: 'The version, the language shown and the text\'s fingerprint are recorded; Home\'s tiles open.' },
    { id: 'newer', label: 'A newer version came in force', model: notice({ kind: 'newer' }) },
    { id: 'none', label: 'No notice in force', model: notice({ kind: 'none' }, false) },
    { id: 'loading', label: 'Opening', model: notice({ kind: 'loading' }) },
    { id: 'unavailable', label: 'Server not answering', model: notice({ kind: 'unavailable' }) },
  ],
})

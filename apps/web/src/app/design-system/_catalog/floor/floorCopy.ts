/**
 * The words the floor kit examples pass in — fake, Italian and English, as the factory app will (A2 §3.1: the language
 * follows the person; each language named in its own words). The design-system parts hold no words of their own.
 * Every name, code and number here is made up.
 */
export type FloorLang = 'it' | 'en'

export interface FloorCopy {
  /** The other language, in its own words — the header's language button. */
  otherLanguage: string
  station: string
  operator: string
  operatorDetail: string
  operatorMenu: string
  help: string
  home: string
  offline: string
  sending: string
  pending: (n: number) => string
  refused: (n: number) => string
  synced: string
  lastSync: string
  queue: string
  idleTitle: string
  idleMessage: string
  seconds: (n: number) => string
  stay: string
  signOutNow: string
  signedOut: string
  tiles: { work: string; cutting: string; bundles: string; scan: string; receive: string; pick: string }
  tileHints: { work: string; locked: string }
  queued: (n: number) => string
  scan: string
  scanHint: string
  scanned: (code: string) => string
  type: string
  camera: string
  cameraStop: string
  cameraError: string
  source: { wedge: string; typed: string; camera: string }
  pin: string
  pinEntered: (n: number, total: number) => string
  pinClear: string
  pinBack: string
  pinChecking: string
  pinWrong: (left: number) => string
  pinLocked: string
  pinWelcome: string
  pick: string
  pieces: string
  rows: { done: string; short: string; held: string; todo: string }
  actions: { pause: string; scrap: string; refuse: string; done: string }
  counted: string
  feedbackDone: string
  feedbackCheck: string
  feedbackRefused: string
}

export const FLOOR_COPY: { readonly [L in FloorLang]: FloorCopy } = {
  it: {
    otherLanguage: 'English',
    station: 'Cucitura · Linea 2',
    operator: 'Maria Rossi',
    operatorDetail: 'Turno A',
    operatorMenu: 'Maria Rossi — esci o cambia lingua',
    help: 'Aiuto',
    home: 'Cosa vuoi fare',
    offline: 'Offline — il lavoro resta sul tablet',
    sending: 'Invio in corso',
    pending: (n) => (n === 1 ? 'azione da inviare' : 'azioni da inviare'),
    refused: (n) => (n === 1 ? '1 azione rifiutata' : `${n} azioni rifiutate`),
    synced: 'Tutto inviato',
    lastSync: 'Ultimo invio 10:42',
    queue: 'Apri coda',
    idleTitle: 'Ci sei ancora?',
    idleMessage: 'Tra poco esci da questo tablet. Il lavoro salvato resta.',
    seconds: (n) => (n === 1 ? 'secondo' : 'secondi'),
    stay: 'Sono qui',
    signOutNow: 'Esci ora',
    signedOut: 'Uscita automatica: il tablet aspetta il prossimo operatore.',
    tiles: { work: 'Il mio lavoro', cutting: 'Taglio', bundles: 'Fasci', scan: 'Scansiona', receive: 'Ricevi merce', pick: 'Preleva' },
    tileHints: { work: 'Prossimo: fascio 417', locked: 'Solo per il magazzino' },
    queued: (n) => `${n} in coda`,
    scan: 'Scansiona',
    scanHint: 'Scansiona il cartellino del fascio, del lotto o della pelle.',
    scanned: (code) => `Letto ${code}`,
    type: 'Digita',
    camera: 'Fotocamera',
    cameraStop: 'Chiudi fotocamera',
    cameraError: 'Fotocamera non disponibile. Usa lo scanner.',
    source: { wedge: 'scanner', typed: 'digitato', camera: 'fotocamera' },
    pin: 'Inserisci il PIN',
    pinEntered: (n, total) => `${n} di ${total} cifre`,
    pinClear: 'Cancella',
    pinBack: 'Indietro',
    pinChecking: 'Controllo…',
    pinWrong: (left) => `PIN non corretto. ${left === 1 ? 'Resta 1 tentativo' : `Restano ${left} tentativi`}.`,
    pinLocked: 'Troppi tentativi. Riprova tra 5 minuti o chiama il capo linea.',
    pinWelcome: 'Benvenuta, Maria.',
    pick: 'Da prelevare',
    pieces: 'pezzi',
    rows: { done: 'Prelevato', short: 'Manca 1', held: 'Bloccato', todo: 'Da fare' },
    actions: { pause: 'Pausa', scrap: 'Scarto', refuse: 'Rifiuta', done: 'Fatto' },
    counted: 'Pezzi buoni',
    feedbackDone: 'Fatto',
    feedbackCheck: 'Controlla',
    feedbackRefused: 'Rifiutato: il fascio non è di questa fase',
  },
  en: {
    otherLanguage: 'Italiano',
    station: 'Sewing · Line 2',
    operator: 'Maria Rossi',
    operatorDetail: 'Shift A',
    operatorMenu: 'Maria Rossi — sign out or change language',
    help: 'Help',
    home: 'What do you want to do',
    offline: 'Offline — your work stays on this tablet',
    sending: 'Sending',
    pending: (n) => (n === 1 ? 'action to send' : 'actions to send'),
    refused: (n) => (n === 1 ? '1 action refused' : `${n} actions refused`),
    synced: 'All sent',
    lastSync: 'Last sent 10:42',
    queue: 'Open queue',
    idleTitle: 'Are you still here?',
    idleMessage: 'You will be signed out of this tablet soon. Saved work stays.',
    seconds: (n) => (n === 1 ? 'second' : 'seconds'),
    stay: "I'm here",
    signOutNow: 'Sign out now',
    signedOut: 'Signed out automatically: the tablet waits for the next operator.',
    tiles: { work: 'My work', cutting: 'Cutting', bundles: 'Bundles', scan: 'Scan', receive: 'Receive goods', pick: 'Pick' },
    tileHints: { work: 'Next: bundle 417', locked: 'Warehouse only' },
    queued: (n) => `${n} waiting`,
    scan: 'Scan',
    scanHint: 'Scan the bundle, lot or hide label.',
    scanned: (code) => `Read ${code}`,
    type: 'Type',
    camera: 'Camera',
    cameraStop: 'Close camera',
    cameraError: 'Camera not available. Use the scanner.',
    source: { wedge: 'scanner', typed: 'typed', camera: 'camera' },
    pin: 'Enter your PIN',
    pinEntered: (n, total) => `${n} of ${total} digits`,
    pinClear: 'Clear',
    pinBack: 'Back',
    pinChecking: 'Checking…',
    pinWrong: (left) => `Wrong PIN. ${left === 1 ? '1 try left' : `${left} tries left`}.`,
    pinLocked: 'Too many tries. Try again in 5 minutes or call the line lead.',
    pinWelcome: 'Welcome, Maria.',
    pick: 'To pick',
    pieces: 'pcs',
    rows: { done: 'Picked', short: '1 short', held: 'On hold', todo: 'To do' },
    actions: { pause: 'Pause', scrap: 'Scrap', refuse: 'Refuse', done: 'Done' },
    counted: 'Good pieces',
    feedbackDone: 'Done',
    feedbackCheck: 'Check',
    feedbackRefused: 'Refused: this bundle is not for this step',
  },
}

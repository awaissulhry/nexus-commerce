import type { Issue } from '../core/errors'
import type { TemplateLanguage } from './language'
import { fillPlaceholders, placeholderProblems, type PlaceholderValues } from './placeholders'
// ---- B-TH-098: the fixed mail texts in German, French and Spanish (drafted by Claude, read once before they go on their own).
import { isLanguageRead, isMessageLanguage, type DraftedLanguage, type MessageLanguage } from './message-languages'

/**
 * E-mail templates (B-W2b-422; PLT-232; design admin.documents "E-mail templates": event, language, subject, last changed;
 * "Edit with placeholders and a preview on a sample record"): the subject and body of one mail the code sends, per event and
 * language, a company's own or every company's (the database's EmailTemplate, in versions DRAFT → ACTIVE → RETIRED). The
 * mail reads the company's version in use, else every company's, else the code's own words (each event's code below names
 * them). A template only changes the words: who gets the mail, when, and whether it goes at all stay the code's, and a mail
 * goes only when a person sends it or a switch that is ON says so. Pure.
 *
 *   service.status_changed   a service case moved and the case says to tell the customer (B-W2b-345; SAL-436; TM1:01)
 *   shipping.tracking_link   the customer's tracking page when the goods leave or a new link is asked (B-W2b-170; LOG-062)
 *   B-TH-279 (threads plan TH-6, O-ADM-MAILTPL.events-F01; N5): the request mails and the new-message notice —
 *   request.received         the receipt of a customer's request, with its number
 *   request.need_info        we ask the customer for what the request still needs ("Ask for info": the office's starting words)
 *   request.declined         we say no to a request, with the reason ("Decline": the office's starting words)
 *   thread.message_posted    a new message for the customer on one of its records, with the message's text — only a message shared
 *                            with that reader's customer, never an office note (cut per reader by the sender: B-TH-080)
 */

/** The company's names every template may use: its name as printed (trade name, else legal name), legal name and trade name. */
export const COMPANY_PLACEHOLDERS = ['company.name', 'company.legalName', 'company.tradeName'] as const

export const MAIL_EVENTS = ['service.status_changed', 'shipping.tracking_link', /* B-TH-279 */ 'request.received', 'request.need_info', 'request.declined', 'thread.message_posted'] as const
export type MailEvent = (typeof MAIL_EVENTS)[number]

export const isMailEvent = (value: unknown): value is MailEvent => typeof value === 'string' && (MAIL_EVENTS as readonly string[]).includes(value)

export interface MailWords {
  readonly subject: string
  readonly body: string
}

export interface MailEventDefinition {
  readonly event: MailEvent
  /** The record the mail is about (a thread's record type). */
  readonly recordType: string
  readonly placeholders: readonly string[]
  /** The code's own words as a template: what is sent without a template in use, and what a new one starts from. */
  readonly words: Readonly<Record<TemplateLanguage, MailWords>>
  /** Made-up values of a sample record for the preview (the company's names come from the company). */
  readonly sample: Readonly<Record<TemplateLanguage, PlaceholderValues>>
}

// ---- B-TH-279: what a request mail fills (the same names as a saved reply for a request: templates/replies.ts REPLY_PLACEHOLDERS).
// `inquiry.yourNumber`: the customer's OWN number of the request ("7": decision 1 A, the counts never leak, §0.5), the office's number
// only for a prospect's request (no customer yet); `inquiry.number` stays the office's series for the office's own words.
const REQUEST_PLACEHOLDERS: readonly string[] = ['inquiry.yourNumber', 'inquiry.number', 'inquiry.subject', 'inquiry.wantedDate', 'contact.name', 'party.name', 'me.name', ...COMPANY_PLACEHOLDERS]
const REQUEST_SAMPLE = {
  it: { 'inquiry.yourNumber': '7', 'inquiry.number': 'INQ-2026-0042', 'inquiry.subject': '40 giacche per la primavera', 'inquiry.wantedDate': '1 marzo 2027', 'contact.name': 'Anna Esempio', 'party.name': 'Moto Club Esempio', 'me.name': 'Marco Esempio' },
  en: { 'inquiry.yourNumber': '7', 'inquiry.number': 'INQ-2026-0042', 'inquiry.subject': '40 jackets for the spring', 'inquiry.wantedDate': '1 March 2027', 'contact.name': 'Ann Example', 'party.name': 'Example Moto Club', 'me.name': 'Mark Example' },
} as const satisfies Record<TemplateLanguage, PlaceholderValues>
// ---- end B-TH-279

export const MAIL_EVENT_DEFINITIONS: Readonly<Record<MailEvent, MailEventDefinition>> = Object.freeze({
  'service.status_changed': {
    event: 'service.status_changed',
    recordType: 'ServiceCase',
    placeholders: ['case.number', 'case.status', 'case.sentence', 'contact.name', 'message', ...COMPANY_PLACEHOLDERS],
    words: {
      it: {
        subject: 'Pratica di assistenza {{case.number}}: {{case.status}}',
        body: 'Gentile {{contact.name}},\nla sua pratica di assistenza {{case.number}} è {{case.status}}.\n\n{{case.sentence}}\n\n{{message}}\n\nPer qualsiasi domanda può rispondere a questa e-mail.\n\n{{company.name}}',
      },
      en: {
        subject: 'Service case {{case.number}}: {{case.status}}',
        body: 'Dear {{contact.name}},\nyour service case {{case.number}} is {{case.status}}.\n\n{{case.sentence}}\n\n{{message}}\n\nIf you have any question, just reply to this e-mail.\n\n{{company.name}}',
      },
    },
    sample: {
      it: { 'case.number': 'SVC-2026-0042', 'case.status': 'in lavorazione', 'case.sentence': 'Abbiamo preso in carico la sua richiesta e la stiamo esaminando.', 'contact.name': 'Anna Esempio', message: 'Il tecnico la chiamerà domani in mattinata.' },
      en: { 'case.number': 'SVC-2026-0042', 'case.status': 'in progress', 'case.sentence': 'We have taken your request on and are looking into it.', 'contact.name': 'Ann Example', message: 'The technician will call you tomorrow morning.' },
    },
  },
  'shipping.tracking_link': {
    event: 'shipping.tracking_link',
    recordType: 'Shipment',
    placeholders: ['order.number', 'shipment.number', 'shipment.where', 'shipment.facts', 'carrier.name', 'delivery.expected', 'trackingUrl', 'contact.name', ...COMPANY_PLACEHOLDERS],
    words: {
      it: {
        subject: 'Il suo ordine {{order.number}} — {{company.name}}',
        body: 'Buongiorno,\n\n{{shipment.where}}\n\n{{shipment.facts}}\n\nLo segua da questa pagina, nella sua lingua: dove si trova, le notizie del corriere e i documenti della spedizione.\n{{trackingUrl}}\n\nLa pagina resta aperta fino a 60 giorni dopo la consegna. Se qualcosa non va, dalla stessa pagina può segnalarcelo.',
      },
      en: {
        subject: 'Your order {{order.number}} — {{company.name}}',
        body: "Hello,\n\n{{shipment.where}}\n\n{{shipment.facts}}\n\nFollow it on this page, in your language: where it is, the carrier's news and the shipment's papers.\n{{trackingUrl}}\n\nThe page stays open until 60 days after delivery. If something is wrong, you can tell us from the same page.",
      },
    },
    sample: {
      it: {
        'order.number': 'SO-2026-0101',
        'shipment.number': 'SH-2026-0077',
        'shipment.where': 'il suo ordine SO-2026-0101 è in viaggio (spedizione SH-2026-0077).',
        'shipment.facts': 'Corriere: Corriere Esempio.\nConsegna prevista: 20 novembre 2026.',
        'carrier.name': 'Corriere Esempio',
        'delivery.expected': '20 novembre 2026',
        trackingUrl: 'https://example.com/l#token=sample',
        'contact.name': 'Anna Esempio',
      },
      en: {
        'order.number': 'SO-2026-0101',
        'shipment.number': 'SH-2026-0077',
        'shipment.where': 'your order SO-2026-0101 is on its way (shipment SH-2026-0077).',
        'shipment.facts': 'Carrier: Example Carrier.\nExpected delivery: 20 November 2026.',
        'carrier.name': 'Example Carrier',
        'delivery.expected': '20 November 2026',
        trackingUrl: 'https://example.com/l#token=sample',
        'contact.name': 'Ann Example',
      },
    },
  },
  // ---- B-TH-279: the request mails (a request of Sales › Incoming: its number, what it is about, the customer's contact who wrote it)
  // and the new-message notice. The words are the code's; a company changes them in Admin › Documents › E-mail templates.
  'request.received': {
    event: 'request.received',
    recordType: 'Inquiry',
    placeholders: REQUEST_PLACEHOLDERS,
    words: {
      it: {
        subject: 'Abbiamo ricevuto la sua richiesta {{inquiry.yourNumber}}',
        body: 'Gentile {{contact.name}},\nabbiamo ricevuto la sua richiesta {{inquiry.yourNumber}}: {{inquiry.subject}}.\n\nLa leggiamo e le rispondiamo al più presto. Per aggiungere qualcosa può rispondere a questa e-mail.\n\n{{company.name}}',
      },
      en: {
        subject: 'We received your request {{inquiry.yourNumber}}',
        body: 'Dear {{contact.name}},\nwe received your request {{inquiry.yourNumber}}: {{inquiry.subject}}.\n\nWe are reading it and will answer soon. To add anything, just reply to this e-mail.\n\n{{company.name}}',
      },
    },
    sample: { it: REQUEST_SAMPLE.it, en: REQUEST_SAMPLE.en },
  },
  'request.need_info': {
    event: 'request.need_info',
    recordType: 'Inquiry',
    placeholders: [...REQUEST_PLACEHOLDERS, 'question'],
    words: {
      it: {
        subject: 'La sua richiesta {{inquiry.yourNumber}}: ci serve ancora qualcosa',
        body: 'Gentile {{contact.name}},\nper andare avanti con la sua richiesta {{inquiry.yourNumber}} ({{inquiry.subject}}) ci serve ancora:\n\n{{question}}\n\nPuò rispondere a questa e-mail o scriverci nel portale.\n\n{{company.name}}',
      },
      en: {
        subject: 'Your request {{inquiry.yourNumber}}: we need one more thing',
        body: 'Dear {{contact.name}},\nto go on with your request {{inquiry.yourNumber}} ({{inquiry.subject}}) we still need:\n\n{{question}}\n\nYou can reply to this e-mail or write to us in the portal.\n\n{{company.name}}',
      },
    },
    sample: { it: { ...REQUEST_SAMPLE.it, question: 'Le misure del capo nella taglia L.' }, en: { ...REQUEST_SAMPLE.en, question: 'The measurements of the garment in size L.' } },
  },
  'request.declined': {
    event: 'request.declined',
    recordType: 'Inquiry',
    placeholders: [...REQUEST_PLACEHOLDERS, 'reason'],
    words: {
      it: {
        subject: 'La sua richiesta {{inquiry.yourNumber}}',
        body: 'Gentile {{contact.name}},\ngrazie per la sua richiesta {{inquiry.yourNumber}} ({{inquiry.subject}}). Questa volta purtroppo non possiamo accettarla.\n\n{{reason}}\n\nSperiamo di lavorare insieme in un\'altra occasione.\n\n{{company.name}}',
      },
      en: {
        subject: 'Your request {{inquiry.yourNumber}}',
        body: 'Dear {{contact.name}},\nthank you for your request {{inquiry.yourNumber}} ({{inquiry.subject}}). This time we cannot take it on.\n\n{{reason}}\n\nWe hope to work together another time.\n\n{{company.name}}',
      },
    },
    sample: { it: { ...REQUEST_SAMPLE.it, reason: 'La quantità è sotto il nostro minimo di produzione.' }, en: { ...REQUEST_SAMPLE.en, reason: 'The quantity is below our production minimum.' } },
  },
  'thread.message_posted': {
    event: 'thread.message_posted',
    recordType: 'Message',
    placeholders: ['record.label', 'author.name', 'message', 'link', 'contact.name', ...COMPANY_PLACEHOLDERS],
    words: {
      it: {
        subject: 'Nuovo messaggio da {{company.name}} per {{record.label}}',
        body: 'Ciao {{contact.name}},\n{{author.name}} ha scritto per {{record.label}}:\n\n{{message}}\n\nRispondi nel portale: {{link}}\n\n{{company.name}}',
      },
      en: {
        subject: 'New message from {{company.name}} on {{record.label}}',
        body: 'Hello {{contact.name}},\n{{author.name}} wrote on {{record.label}}:\n\n{{message}}\n\nAnswer in the portal: {{link}}\n\n{{company.name}}',
      },
    },
    sample: {
      it: { 'record.label': 'il vostro ordine 12', 'author.name': 'Marco Esempio', message: 'Il tessuto è arrivato: la produzione parte lunedì.', link: 'https://example.com/p/orders', 'contact.name': 'Anna Esempio' },
      en: { 'record.label': 'your order 12', 'author.name': 'Mark Example', message: 'The fabric arrived: production starts on Monday.', link: 'https://example.com/p/orders', 'contact.name': 'Ann Example' },
    },
  },
  // ---- end B-TH-279
})

export const EMAIL_TEMPLATE_LIMITS = Object.freeze({ subject: 200, body: 20000 })

/** Every problem of a mail template's words for its event and language (empty when it can be saved). */
export function emailTemplateProblems(event: string, language: string, words: MailWords): Issue[] {
  const problems: Issue[] = []
  if (!isMailEvent(event)) return [{ path: 'body/event', message: 'No mail of the code takes a template for this event.' }]
  // B-TH-098: a template a person writes may be in any of the five message languages (a person's words need no reading).
  if (!isMessageLanguage(language)) problems.push({ path: 'body/language', message: 'Mail is written in Italian, English, German, French or Spanish.' })
  const offered = MAIL_EVENT_DEFINITIONS[event].placeholders
  const subject = words.subject.trim()
  if (subject === '' || subject.length > EMAIL_TEMPLATE_LIMITS.subject || /[\r\n]/.test(subject)) problems.push({ path: 'body/subject', message: `One line of 1 to ${EMAIL_TEMPLATE_LIMITS.subject} characters.` })
  else problems.push(...placeholderProblems(subject, 'body/subject', offered))
  const body = words.body.trim()
  if (body === '' || body.length > EMAIL_TEMPLATE_LIMITS.body) problems.push({ path: 'body/body', message: `1 to ${EMAIL_TEMPLATE_LIMITS.body} characters.` })
  else problems.push(...placeholderProblems(body, 'body/body', offered))
  return problems
}

/** The mail's subject (one line) and body with the values filled. */
export function fillMail(words: MailWords, values: PlaceholderValues): MailWords {
  return { subject: fillPlaceholders(words.subject, values).replace(/\s+/g, ' ').trim(), body: fillPlaceholders(words.body, values) }
}

/** The company's names as placeholders. */
export function companyValues(company: { readonly legalName: string; readonly tradeName?: string | null }): PlaceholderValues {
  const tradeName = company.tradeName?.trim() || null
  return { 'company.name': tradeName ?? company.legalName.trim(), 'company.legalName': company.legalName.trim(), 'company.tradeName': tradeName }
}

// ---- B-TH-098 (threads plan TH-9, thread-G07; plan decision "mail texts in DE/FR/ES drafted by Claude, read once by the Owner or a
// trusted customer contact") -------------------------------------------------------------------------------------------------------
/**
 * The code's mail words in German, French and Spanish, DRAFTED BY CLAUDE and marked "to be read once by the Owner or a trusted customer
 * contact" (message-languages.ts LANGUAGE_REVIEW). Never machine-translated at send time: these are fixed texts, read once by a person
 * before they go out on their own. Same placeholders as the Italian and English words of each event.
 */
export const MAIL_DRAFTS: Readonly<Record<MailEvent, Readonly<Record<DraftedLanguage, MailWords>>>> = Object.freeze({
  'service.status_changed': {
    de: {
      subject: 'Serviceanfrage {{case.number}}: {{case.status}}',
      body: 'Guten Tag {{contact.name}},\nIhre Serviceanfrage {{case.number}} ist {{case.status}}.\n\n{{case.sentence}}\n\n{{message}}\n\nBei Fragen antworten Sie einfach auf diese E-Mail.\n\n{{company.name}}',
    },
    fr: {
      subject: 'Dossier SAV {{case.number}} : {{case.status}}',
      body: 'Bonjour {{contact.name}},\nvotre dossier SAV {{case.number}} est {{case.status}}.\n\n{{case.sentence}}\n\n{{message}}\n\nPour toute question, répondez simplement à cet e-mail.\n\n{{company.name}}',
    },
    es: {
      subject: 'Caso de asistencia {{case.number}}: {{case.status}}',
      body: 'Estimado/a {{contact.name}}:\nsu caso de asistencia {{case.number}} está {{case.status}}.\n\n{{case.sentence}}\n\n{{message}}\n\nSi tiene alguna pregunta, responda a este correo.\n\n{{company.name}}',
    },
  },
  'shipping.tracking_link': {
    de: {
      subject: 'Ihre Bestellung {{order.number}} — {{company.name}}',
      body: 'Guten Tag,\n\n{{shipment.where}}\n\n{{shipment.facts}}\n\nVerfolgen Sie die Sendung auf dieser Seite: wo sie ist, die Nachrichten des Kuriers und die Versandpapiere.\n{{trackingUrl}}\n\nDie Seite bleibt bis 60 Tage nach der Zustellung offen. Wenn etwas nicht stimmt, können Sie es uns auf derselben Seite mitteilen.',
    },
    fr: {
      subject: 'Votre commande {{order.number}} — {{company.name}}',
      body: "Bonjour,\n\n{{shipment.where}}\n\n{{shipment.facts}}\n\nSuivez-la sur cette page : où elle se trouve, les nouvelles du transporteur et les documents de l'expédition.\n{{trackingUrl}}\n\nLa page reste ouverte jusqu'à 60 jours après la livraison. Si quelque chose ne va pas, vous pouvez nous le signaler depuis la même page.",
    },
    es: {
      subject: 'Su pedido {{order.number}} — {{company.name}}',
      body: 'Buenos días:\n\n{{shipment.where}}\n\n{{shipment.facts}}\n\nSígalo en esta página: dónde está, las noticias del transportista y los documentos del envío.\n{{trackingUrl}}\n\nLa página sigue abierta hasta 60 días después de la entrega. Si algo no va bien, puede decírnoslo desde la misma página.',
    },
  },
  'request.received': {
    de: {
      subject: 'Wir haben Ihre Anfrage {{inquiry.yourNumber}} erhalten',
      body: 'Guten Tag {{contact.name}},\nwir haben Ihre Anfrage {{inquiry.yourNumber}} erhalten: {{inquiry.subject}}.\n\nWir lesen sie und antworten Ihnen so bald wie möglich. Um etwas hinzuzufügen, antworten Sie einfach auf diese E-Mail.\n\n{{company.name}}',
    },
    fr: {
      subject: 'Nous avons reçu votre demande {{inquiry.yourNumber}}',
      body: 'Bonjour {{contact.name}},\nnous avons reçu votre demande {{inquiry.yourNumber}} : {{inquiry.subject}}.\n\nNous la lisons et vous répondons au plus vite. Pour ajouter quelque chose, répondez simplement à cet e-mail.\n\n{{company.name}}',
    },
    es: {
      subject: 'Hemos recibido su solicitud {{inquiry.yourNumber}}',
      body: 'Estimado/a {{contact.name}}:\nhemos recibido su solicitud {{inquiry.yourNumber}}: {{inquiry.subject}}.\n\nLa estamos leyendo y le responderemos lo antes posible. Para añadir algo, responda a este correo.\n\n{{company.name}}',
    },
  },
  'request.need_info': {
    de: {
      subject: 'Ihre Anfrage {{inquiry.yourNumber}}: Wir benötigen noch etwas',
      body: 'Guten Tag {{contact.name}},\num mit Ihrer Anfrage {{inquiry.yourNumber}} ({{inquiry.subject}}) weiterzumachen, benötigen wir noch:\n\n{{question}}\n\nSie können auf diese E-Mail antworten oder uns im Portal schreiben.\n\n{{company.name}}',
    },
    fr: {
      subject: 'Votre demande {{inquiry.yourNumber}} : il nous manque encore quelque chose',
      body: 'Bonjour {{contact.name}},\npour avancer sur votre demande {{inquiry.yourNumber}} ({{inquiry.subject}}), il nous faut encore :\n\n{{question}}\n\nVous pouvez répondre à cet e-mail ou nous écrire sur le portail.\n\n{{company.name}}',
    },
    es: {
      subject: 'Su solicitud {{inquiry.yourNumber}}: necesitamos algo más',
      body: 'Estimado/a {{contact.name}}:\npara seguir con su solicitud {{inquiry.yourNumber}} ({{inquiry.subject}}) todavía necesitamos:\n\n{{question}}\n\nPuede responder a este correo o escribirnos en el portal.\n\n{{company.name}}',
    },
  },
  'request.declined': {
    de: {
      subject: 'Ihre Anfrage {{inquiry.yourNumber}}',
      body: 'Guten Tag {{contact.name}},\nvielen Dank für Ihre Anfrage {{inquiry.yourNumber}} ({{inquiry.subject}}). Diesmal können wir sie leider nicht annehmen.\n\n{{reason}}\n\nWir hoffen, ein anderes Mal mit Ihnen zusammenzuarbeiten.\n\n{{company.name}}',
    },
    fr: {
      subject: 'Votre demande {{inquiry.yourNumber}}',
      body: "Bonjour {{contact.name}},\nmerci pour votre demande {{inquiry.yourNumber}} ({{inquiry.subject}}). Cette fois, nous ne pouvons malheureusement pas l'accepter.\n\n{{reason}}\n\nNous espérons travailler ensemble une autre fois.\n\n{{company.name}}",
    },
    es: {
      subject: 'Su solicitud {{inquiry.yourNumber}}',
      body: 'Estimado/a {{contact.name}}:\ngracias por su solicitud {{inquiry.yourNumber}} ({{inquiry.subject}}). Esta vez, lamentablemente, no podemos aceptarla.\n\n{{reason}}\n\nEsperamos trabajar juntos en otra ocasión.\n\n{{company.name}}',
    },
  },
  'thread.message_posted': {
    de: {
      subject: 'Neue Nachricht von {{company.name}} zu {{record.label}}',
      body: 'Hallo {{contact.name}},\n{{author.name}} hat zu {{record.label}} geschrieben:\n\n{{message}}\n\nAntworten Sie im Portal: {{link}}\n\n{{company.name}}',
    },
    fr: {
      subject: 'Nouveau message de {{company.name}} sur {{record.label}}',
      body: 'Bonjour {{contact.name}},\n{{author.name}} a écrit sur {{record.label}} :\n\n{{message}}\n\nRépondez sur le portail : {{link}}\n\n{{company.name}}',
    },
    es: {
      subject: 'Nuevo mensaje de {{company.name}} sobre {{record.label}}',
      body: 'Hola {{contact.name}}:\n{{author.name}} ha escrito sobre {{record.label}}:\n\n{{message}}\n\nResponda en el portal: {{link}}\n\n{{company.name}}',
    },
  },
})

/** The code's words of an event in a language, and whether they may go out on their own. */
export interface CodeWords {
  readonly words: MailWords
  /** The language the words are in (an unread drafted language without the tick: English). */
  readonly language: MessageLanguage
  /** Whether the ASKED language's texts were read once by a person (Italian and English: always). */
  readonly read: boolean
  /** English was given instead of an unread drafted text (the office may tick "Send it anyway" to have the draft). */
  readonly fellBack: boolean
}

/**
 * The code's words of an event in a message language: Italian and English as they are; German, French and Spanish — Claude's drafts —
 * once that language was read (LANGUAGE_REVIEW), or when the office ticked "Send it anyway" (`sendUnread`); otherwise English, said
 * with `fellBack`, so a drafted text never goes out on its own before a person has read it.
 */
export function codeWordsOf(event: MailEvent, language: MessageLanguage, options: { readonly sendUnread?: boolean } = {}): CodeWords {
  if (language === 'it' || language === 'en') return { words: MAIL_EVENT_DEFINITIONS[event].words[language], language, read: true, fellBack: false }
  const read = isLanguageRead(language)
  if (read || options.sendUnread === true) return { words: MAIL_DRAFTS[event][language], language, read, fellBack: false }
  return { words: MAIL_EVENT_DEFINITIONS[event].words.en, language: 'en', read, fellBack: true }
}
// ---- end B-TH-098

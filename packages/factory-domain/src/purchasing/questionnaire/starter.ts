import type { Question } from './questions'

/**
 * The starter questionnaire (B-W2b-172; SCM-023): what a company publishes as its first version when it has none, and
 * edits from there. A due-diligence set for the Forced Labour Regulation (EU) 2024/3015 (it applies from 14 December
 * 2027: no product made with forced labour may be placed on, or exported from, the EU market) built on the ILO's
 * indicators of forced labour (identity documents, recruitment fees, freedom to leave, wages, overtime), child labour
 * (ILO C138 / C182), state-imposed forced labour, the sub-suppliers' commitment and a way to raise concerns; with the
 * company's facts, contacts, sites and sub-tier sites (who does each step for leather and where), and the documents a
 * leather goods maker needs from its suppliers (LWG, ISO 9001 / 14001, REACH, chromium VI tests: REACH Annex XVII entry
 * 47, EN ISO 17075). The code of conduct is a starting text: the company makes it its own before it publishes.
 */

const yes = (it: string, en: string) => ({ it, en })

const CODE_OF_CONDUCT = {
  title: yes('Codice di condotta per i fornitori', 'Supplier code of conduct'),
  paragraphs: {
    it: [
      "Questo codice vale per il fornitore, per tutti i suoi stabilimenti e per i suoi subfornitori che lavorano per noi. Il fornitore lo fa conoscere ai suoi subfornitori e ne chiede il rispetto per iscritto.",
      "Lavoro forzato. Nessuna forma di lavoro forzato, vincolato o obbligatorio, compreso quello imposto dallo Stato, il lavoro carcerario non volontario e la tratta di persone (Regolamento (UE) 2024/3015; Convenzioni ILO 29 e 105).",
      "Libertà dei lavoratori. I lavoratori tengono i propri documenti di identità, non pagano commissioni o costi per essere assunti, possono lasciare il lavoro con un preavviso ragionevole e lasciare il luogo di lavoro e l'alloggio liberamente.",
      "Lavoro minorile. Nessuna persona sotto l'età minima di legge, e in ogni caso sotto i 15 anni; i giovani lavoratori non svolgono lavori pericolosi né notturni (Convenzioni ILO 138 e 182).",
      "Salari e orari. Salari almeno pari al minimo di legge o di contratto, pagati regolarmente, per intero e direttamente al lavoratore; straordinario volontario, pagato e nei limiti di legge; almeno un giorno di riposo ogni sette.",
      "Salute e sicurezza. Luoghi di lavoro e alloggi sicuri e salubri; dispositivi di protezione forniti gratuitamente; uso e smaltimento corretto delle sostanze chimiche (REACH).",
      "Libertà di associazione e non discriminazione. I lavoratori possono aderire a un sindacato e contrattare collettivamente; nessuna discriminazione, molestia o punizione fisica.",
      "Segnalazioni. I lavoratori possono segnalare un problema in modo anonimo e senza ritorsioni. Il fornitore ci informa subito di ogni rischio o caso che riguardi questo codice e collabora alle verifiche, anche presso i suoi siti.",
      "Verifiche. Possiamo chiedere documenti, visitare gli stabilimenti o far svolgere un audit. Una violazione grave che non viene corretta comporta la fine del rapporto.",
    ],
    en: [
      'This code applies to the supplier, to all of its sites and to its sub-suppliers that work for us. The supplier makes it known to its sub-suppliers and asks them to follow it in writing.',
      'Forced labour. No form of forced, bonded or compulsory labour, including state-imposed forced labour, involuntary prison labour and human trafficking (Regulation (EU) 2024/3015; ILO Conventions 29 and 105).',
      'Freedom of workers. Workers keep their own identity documents, pay no fees or costs to be recruited, may leave their job with reasonable notice and leave the workplace and housing freely.',
      'Child labour. Nobody below the legal minimum age, and in any case nobody under 15; young workers do no hazardous work and no night work (ILO Conventions 138 and 182).',
      'Wages and hours. Wages at least at the legal or agreed minimum, paid regularly, in full and directly to the worker; overtime voluntary, paid and within legal limits; at least one day of rest in seven.',
      'Health and safety. Safe and healthy workplaces and housing; protective equipment free of charge; chemicals used and disposed of correctly (REACH).',
      'Freedom of association and no discrimination. Workers may join a union and bargain collectively; no discrimination, harassment or physical punishment.',
      'Raising concerns. Workers can raise a concern anonymously and without retaliation. The supplier tells us at once of any risk or case that concerns this code and cooperates with checks, at its sites too.',
      'Checks. We may ask for documents, visit the sites or have an audit done. A serious breach that is not put right ends the relationship.',
    ],
  },
}

export const STARTER_TITLE = 'Supplier due diligence'

export const STARTER_QUESTIONS: readonly Question[] = Object.freeze([
  // 1 · Company
  { key: 'company.legal-name', section: 'company', kind: 'TEXT', required: true, text: yes('Ragione sociale', 'Legal name') },
  { key: 'company.vat', section: 'company', kind: 'VAT', required: true, text: yes('Partita IVA', 'VAT number'), help: yes('Con il prefisso del paese, per esempio IT o DE: i numeri UE fuori dall’Italia sono verificati in VIES.', 'With the country prefix, for example IT or DE: EU numbers outside Italy are checked in VIES.') },
  { key: 'company.address', section: 'company', kind: 'ADDRESS', required: true, text: yes('Sede legale', 'Registered address') },
  { key: 'company.website', section: 'company', kind: 'URL', required: false, text: yes('Sito web', 'Website') },
  // 2 · Contacts
  { key: 'contacts.orders', section: 'contacts', kind: 'CONTACT', required: true, text: yes('Chi segue gli ordini', 'Who handles orders') },
  { key: 'contacts.invoices', section: 'contacts', kind: 'CONTACT', required: true, text: yes('Chi segue le fatture', 'Who handles invoices') },
  { key: 'contacts.quality', section: 'contacts', kind: 'CONTACT', required: true, text: yes('Chi segue la qualità', 'Who handles quality') },
  // 3 · Sites and sub-suppliers
  { key: 'sites.own', section: 'sites', kind: 'SITES', required: true, text: yes('I vostri stabilimenti', 'Your sites'), help: yes('Ogni sito dove si lavora per noi, con il paese e le fasi che vi si svolgono.', 'Every site where work for us is done, with its country and the steps done there.') },
  {
    key: 'sites.sub-tier',
    section: 'sites',
    kind: 'SUB_TIER_SITES',
    required: false,
    text: yes('I vostri subfornitori', 'Your sub-suppliers'),
    help: yes('Per la pelle: chi fa riviera, concia, riconcia e rifinizione, e in quale paese.', 'For leather: who does the beamhouse, tanning, retanning and finishing, and in which country.'),
  },
  // 4 · Certifications and tests
  {
    key: 'certs.lwg-rating',
    section: 'certifications',
    kind: 'CHOICE',
    required: true,
    text: yes('Valutazione Leather Working Group (LWG)', 'Leather Working Group (LWG) rating'),
    options: [
      { code: 'GOLD', text: yes('Oro', 'Gold') },
      { code: 'SILVER', text: yes('Argento', 'Silver') },
      { code: 'BRONZE', text: yes('Bronzo', 'Bronze') },
      { code: 'AUDITED', text: yes('Verificato, senza medaglia', 'Audited, no medal') },
      { code: 'NONE', text: yes('Nessuna valutazione', 'Not rated') },
      { code: 'NOT_LEATHER', text: yes('Non lavoriamo pelle', 'We do not work leather') },
    ],
  },
  { key: 'certs.lwg', section: 'certifications', kind: 'FILE', required: false, category: 'SUPPLIER_CERTIFICATE', text: yes('Certificato LWG', 'LWG certificate') },
  { key: 'certs.iso-9001', section: 'certifications', kind: 'FILE', required: false, category: 'SUPPLIER_CERTIFICATE', text: yes('Certificato ISO 9001', 'ISO 9001 certificate') },
  { key: 'certs.iso-14001', section: 'certifications', kind: 'FILE', required: false, category: 'SUPPLIER_CERTIFICATE', text: yes('Certificato ISO 14001', 'ISO 14001 certificate') },
  {
    key: 'certs.reach',
    section: 'certifications',
    kind: 'YES_NO',
    required: true,
    explain: 'NO',
    text: yes('I vostri materiali rispettano il REACH (Regolamento (CE) 1907/2006), compresa la lista delle sostanze candidate (SVHC)?', 'Do your materials comply with REACH (Regulation (EC) 1907/2006), including the candidate list of substances (SVHC)?'),
  },
  { key: 'certs.reach-declaration', section: 'certifications', kind: 'FILE', required: false, category: 'DECLARATION', text: yes('Dichiarazione REACH', 'REACH declaration') },
  {
    key: 'certs.cr6-testing',
    section: 'certifications',
    kind: 'LONG_TEXT',
    required: true,
    text: yes('Come testate il cromo VI (metodo, laboratorio, frequenza)?', 'How do you test for chromium VI (method, laboratory, how often)?'),
    help: yes('Limite REACH 3 mg/kg (Allegato XVII voce 47), metodo EN ISO 17075.', 'REACH limit 3 mg/kg (Annex XVII entry 47), method EN ISO 17075.'),
  },
  { key: 'certs.cr6-report', section: 'certifications', kind: 'FILE', required: false, category: 'TEST_REPORT', text: yes('Ultimo rapporto di prova cromo VI', 'Latest chromium VI test report') },
  // 5 · Labour and social (Regulation (EU) 2024/3015; ILO indicators of forced labour)
  { key: 'labour.id-documents', section: 'labour', kind: 'YES_NO', required: true, explain: 'NO', text: yes('I lavoratori tengono sempre con sé i propri documenti di identità e passaporti?', 'Do workers keep their own identity documents and passports at all times?') },
  { key: 'labour.recruitment-fees', section: 'labour', kind: 'YES_NO', required: true, explain: 'YES', text: yes('Qualche lavoratore ha pagato commissioni o costi per essere assunto?', 'Has any worker paid fees or costs to be recruited or hired?') },
  { key: 'labour.free-to-leave', section: 'labour', kind: 'YES_NO', required: true, explain: 'NO', text: yes('I lavoratori possono lasciare il lavoro con un preavviso ragionevole, senza penali?', 'Can workers leave their job with reasonable notice, without a penalty?') },
  { key: 'labour.wages', section: 'labour', kind: 'YES_NO', required: true, explain: 'NO', text: yes('I salari sono pagati regolarmente, per intero e direttamente ai lavoratori, almeno al minimo di legge?', 'Are wages paid regularly, in full and directly to the workers, at least at the legal minimum?') },
  { key: 'labour.overtime', section: 'labour', kind: 'YES_NO', required: true, explain: 'NO', text: yes('Lo straordinario è volontario e nei limiti di legge?', 'Is overtime voluntary and within legal limits?') },
  { key: 'labour.child-labour', section: 'labour', kind: 'YES_NO', required: true, explain: 'YES', text: yes('Lavora per voi qualcuno sotto l’età minima di legge, o sotto i 15 anni?', 'Does anyone below the legal minimum age, or under 15, work for you?') },
  {
    key: 'labour.state-imposed',
    section: 'labour',
    kind: 'YES_NO',
    required: true,
    explain: 'YES',
    text: yes('Voi o i vostri subfornitori usate materiali o lavoro da regioni o programmi dove il lavoro forzato è imposto dallo Stato?', 'Do you or your sub-suppliers use materials or labour from regions or programmes where forced labour is imposed by the state?'),
  },
  { key: 'labour.sub-suppliers', section: 'labour', kind: 'YES_NO', required: true, explain: 'NO', text: yes('I vostri subfornitori si impegnano per iscritto agli stessi principi (niente lavoro forzato o minorile)?', 'Do your sub-suppliers commit in writing to the same principles (no forced or child labour)?') },
  { key: 'labour.grievance', section: 'labour', kind: 'YES_NO', required: true, explain: 'NO', text: yes('I lavoratori possono segnalare un problema in modo anonimo e senza ritorsioni?', 'Can workers raise a concern anonymously and without retaliation?') },
  {
    key: 'labour.social-audit',
    section: 'labour',
    kind: 'YES_NO',
    required: true,
    explain: 'YES',
    text: yes('Negli ultimi 24 mesi è stato fatto un audit sociale (per esempio SA8000, SMETA, amfori BSCI)?', 'Has a social audit been done in the last 24 months (for example SA8000, SMETA, amfori BSCI)?'),
    help: yes('Se sì: quale, quando e da chi.', 'If yes: which one, when and by whom.'),
  },
  { key: 'labour.code-of-conduct', section: 'labour', kind: 'SIGN', required: true, text: yes('Il nostro codice di condotta per i fornitori', 'Our supplier code of conduct'), document: CODE_OF_CONDUCT },
] satisfies Question[])

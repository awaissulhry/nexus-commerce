import { formatDate, formatDateTime } from '../../documents/format'
import type { TechPackBomLine, TechPackPicture, TechPackView } from './contracts'
import { isPartnerAudience, type TechPackAudience, type TechPackLanguage, type TechPackSection } from './rules'
import { withoutMoney } from './view'

/**
 * The tech pack PDF (B-W2b-230; PRD-131 tech pack PDF, PRD-133 per audience, PRD-138 a QR to the current version on every
 * page; design `style.tp.preview` "The PDF with version stamp, date, watermark and a QR file index"), composed here from the
 * audience's view and painted by the API (modules/product/techpack pdf.ts) on A4 with pdfkit: every word in the paper's
 * language, every number as the view says it. Pure and deterministic.
 *
 * A PDF never carries money (the view's costs are left out here whatever the audience): a paper travels. The audience's other
 * rules are already the view's (factory-domain product/techpack view.ts).
 *
 *   header      on EVERY page: "Tech pack" · style code and name · revision and status · version · the audience; the QR to
 *               the current version (the factory web's /tech-pack/<code>) with its code printed under it
 *   banner      a draft or obsolete revision, in words
 *   sections    the sections asked, in the design's order: facts, tables, notes and pictures with their numbered callouts
 *   footer      printed on (date, time), "Page n of m"
 */

export interface PaperColumn {
  readonly label: string
  /** Share of the table's width, per mille. */
  readonly width: number
  readonly align: 'left' | 'right' | 'center'
}

export interface PaperTable {
  readonly title: string | null
  readonly columns: readonly PaperColumn[]
  readonly rows: readonly (readonly string[])[]
  readonly empty: string
}

export interface PaperFact {
  readonly label: string
  readonly value: string
}

export interface PaperPicture {
  readonly fileId: string
  readonly caption: string
  readonly callouts: readonly { readonly n: number; readonly x: string; readonly y: string; readonly text: string }[]
}

export type PaperBlock =
  | { readonly kind: 'facts'; readonly facts: readonly PaperFact[] }
  | { readonly kind: 'table'; readonly table: PaperTable }
  | { readonly kind: 'notes'; readonly title: string | null; readonly notes: readonly string[] }
  | { readonly kind: 'pictures'; readonly pictures: readonly PaperPicture[]; readonly missing: string }

export interface PaperSection {
  readonly section: TechPackSection
  readonly title: string
  readonly blocks: readonly PaperBlock[]
}

export interface TechPackPaper {
  readonly language: TechPackLanguage
  readonly title: string
  /** "SEED-JKT-01 · Touring jacket" */
  readonly styleLine: string
  /** "Revision 2 · released 10 Nov 2026 · version 3" */
  readonly versionLine: string
  /** "Copy for the workshop SC-W1 Workshop Srl" */
  readonly audienceLine: string
  /** What the QR holds (the address) and the code printed under it. */
  readonly qr: string
  readonly code: string
  readonly banner: string | null
  readonly sections: readonly PaperSection[]
  readonly footer: { readonly printed: string; readonly page: string; readonly continued: string; readonly scan: string }
  readonly meta: { readonly title: string; readonly subject: string; readonly createdAt: string }
}

export interface PaperMeta {
  readonly version: number
  readonly printedAt: Date
  readonly timeZone: string
  /** The QR's address and the printed code (scan.ts techPackAddress, formatTechPackCode). */
  readonly qr: string
  readonly code: string
  /** The party the copy is for (printed on the cover), or null. */
  readonly party: { readonly code: string; readonly name: string } | null
}

// ---- words ---------------------------------------------------------------------------------------------------------------------

const WORDS = {
  it: {
    title: 'Scheda tecnica',
    revision: 'Revisione',
    version: 'versione',
    status: { DRAFT: 'bozza', RELEASED: 'rilasciata', OBSOLETE: 'obsoleta' } as Record<string, string>,
    audience: { INTERNAL: 'Copia interna', SUBCONTRACTOR: 'Copia per il terzista', BRAND: 'Copia per il marchio' } as Record<TechPackAudience, string>,
    for: 'per',
    sections: {
      COVER: 'Copertina',
      SKETCHES: 'Disegni',
      BOM: 'Distinta base',
      COLOURWAYS: 'Varianti colore',
      SIZE_SPEC: 'Tabella misure',
      CONSTRUCTION: 'Costruzione',
      LABELS: 'Etichette e confezionamento',
      PROTECTION: 'Protezione e prestazioni',
      COMPLIANCE: 'Conformità',
      REVISION_LOG: 'Storico revisioni',
    } as Record<TechPackSection, string>,
    bomSections: { SHELL: 'Esterno', LINING: 'Fodera', INSULATION: 'Imbottitura e membrane', PROTECTION: 'Protezioni', TRIMS: 'Accessori', THREAD: 'Filati', LABELS: 'Etichette', PACKAGING: 'Imballo', OTHER: 'Altro' } as Record<string, string>,
    f: {
      style: 'Modello',
      name: 'Nome',
      description: 'Descrizione',
      season: 'Stagione',
      productType: 'Tipo di prodotto',
      brand: 'Marchio',
      sizes: 'Taglie',
      baseSize: 'Taglia base',
      revision: 'Revisione',
      released: 'Rilasciata il',
      effective: 'In vigore dal',
      scope: 'Rilasciata per',
      completeness: 'Completezza',
      output: 'Produce',
      preparedFor: 'Preparata per',
      customs: 'Dogana (HS · origine)',
      gender: 'Genere',
      note: 'Nota di revisione',
    },
    c: {
      seq: 'N.',
      material: 'Materiale',
      placement: 'Posizione',
      qty: 'Q.tà (base)',
      unit: 'U.m.',
      wastage: 'Sfrido %',
      colour: 'Colore',
      kit: 'Nel kit',
      note: 'Nota',
      supplier: 'Fornitore',
      line: 'Riga',
      code: 'Codice',
      main: 'Colore principale',
      details: 'Dettagli',
      point: 'Punto',
      unitShort: 'U.m.',
      operation: 'Operazione',
      centre: 'Reparto',
      machine: 'Macchina e punto',
      checkpoint: 'Controllo',
      minutes: 'Minuti',
      outside: 'Esterna',
      step: 'Passo',
      words: 'Istruzione',
      safety: 'Sicurezza',
      kind: 'Tipo',
      format: 'Formato',
      file: 'File',
      symbol: 'Simbolo',
      text: 'Testo',
      rule: 'Regola',
      quantity: 'Quantità',
      per: 'Per',
      pocket: 'Tasca',
      protector: 'Protezione',
      standard: 'Norma',
      level: 'Livello',
      where: 'Dove',
      certificate: 'Certificato',
      body: 'Organismo notificato',
      validity: 'Validità',
      covers: 'Copre',
      performance: 'Prestazioni',
      test: 'Prova',
      frequency: 'Frequenza',
      due: 'Scadenza',
      result: 'Esito',
      report: 'Rapporto',
      language: 'Lingua',
      state: 'Stato',
      from: 'Dal',
      to: 'Al',
      by: 'Rilasciata da',
      properties: 'Caratteristiche',
      for: 'Per',
    },
    yes: 'sì',
    no: '—',
    every: 'tutte',
    none: 'Niente da mostrare.',
    noPictures: 'Nessuna immagine.',
    pictureMissing: 'Immagine non disponibile nel PDF: aprire la scheda tecnica attuale.',
    noSpec: 'Nessuna tabella misure.',
    noTemplate: 'Nessun modello di etichetta collegato alla revisione.',
    composition: 'Composizione',
    care: 'Manutenzione',
    animal: 'Contiene parti non tessili di origine animale.',
    labelLines: 'Etichette e imballo della distinta',
    packaging: 'Regole di confezionamento del marchio',
    placements: 'Protezioni per tasca',
    protectors: 'Protezioni della distinta',
    certificates: 'Certificati di esame UE del tipo',
    tests: 'Prove di controllo della produzione',
    documents: 'Dichiarazione e nota informativa',
    steps: 'Ciclo di lavoro',
    instruction: (number: string, version: number) => `Istruzione ${number}, versione ${version}`,
    pages: 'Pagine con richiami',
    patterns: 'File dei cartamodelli',
    bySize: 'Quantità per taglia',
    colourGrid: 'Colori per variante',
    notUsed: 'non usata',
    customer: 'dal cliente',
    customerSupplied: 'Fornita dal cliente',
    printed: 'Stampata il',
    page: 'Pagina {page} di {pages}',
    continued: 'segue',
    scan: 'Inquadrare il QR per sapere se questa è la versione attuale.',
    draft: (revision: number) => `La revisione ${revision} è una bozza: può cambiare prima del rilascio.`,
    obsolete: (revision: number, inForce: number | null) => `La revisione ${revision} è obsoleta${inForce === null ? '' : `: è in vigore la revisione ${inForce}`}.`,
    everyCell: 'tutte le varianti e le taglie',
    everyColourway: 'tutte le varianti',
    sizesWord: 'taglie',
    specWords: (points: number, sizes: number, base: string, missing: number, status: string) => `${points} punti × ${sizes} taglie, taglia base ${base} · ${missing === 0 ? 'nessun valore mancante' : `${missing} valori mancanti`} · ${status}`,
    specStatus: { DRAFT: 'bozza', APPROVED: 'approvata', ARCHIVED: 'archiviata' } as Record<string, string>,
    notPpe: 'Non è un DPI: non servono certificato, dichiarazione di conformità né nota informativa.',
    category: { CATEGORY_I: 'DPI di categoria I', CATEGORY_II: 'DPI di categoria II', CATEGORY_III: 'DPI di categoria III' } as Record<string, string>,
    classWord: 'classe',
    noCertificate: 'Nessun certificato necessario.',
    noSku: 'Nessuno SKU attivo.',
    covered: (covered: number, all: number) => `Coperte dai certificati: ${covered} di ${all} combinazioni variante × taglia attive.`,
    documentKinds: { DECLARATION_OF_CONFORMITY: 'Dichiarazione UE di conformità', USER_INFORMATION: 'Nota informativa' } as Record<string, string>,
    documentStates: { CURRENT: 'attuale', OLDER_REVISION: 'di una revisione precedente', MISSING: 'mancante' } as Record<string, string>,
  },
  en: {
    title: 'Tech pack',
    revision: 'Revision',
    version: 'version',
    status: { DRAFT: 'draft', RELEASED: 'released', OBSOLETE: 'obsolete' } as Record<string, string>,
    audience: { INTERNAL: 'Internal copy', SUBCONTRACTOR: 'Copy for the workshop', BRAND: 'Copy for the brand' } as Record<TechPackAudience, string>,
    for: 'for',
    sections: {
      COVER: 'Cover',
      SKETCHES: 'Sketches',
      BOM: 'Bill of materials',
      COLOURWAYS: 'Colourways',
      SIZE_SPEC: 'Size spec',
      CONSTRUCTION: 'Construction',
      LABELS: 'Labels and packaging',
      PROTECTION: 'Protection and performance',
      COMPLIANCE: 'Compliance',
      REVISION_LOG: 'Revision log',
    } as Record<TechPackSection, string>,
    bomSections: { SHELL: 'Shell', LINING: 'Lining', INSULATION: 'Insulation and membranes', PROTECTION: 'Protection', TRIMS: 'Trims', THREAD: 'Thread', LABELS: 'Labels', PACKAGING: 'Packaging', OTHER: 'Other' } as Record<string, string>,
    f: {
      style: 'Style',
      name: 'Name',
      description: 'Description',
      season: 'Season',
      productType: 'Product type',
      brand: 'Brand',
      sizes: 'Sizes',
      baseSize: 'Base size',
      revision: 'Revision',
      released: 'Released on',
      effective: 'In force from',
      scope: 'Released for',
      completeness: 'Completeness',
      output: 'Makes',
      preparedFor: 'Prepared for',
      customs: 'Customs (HS · origin)',
      gender: 'Gender',
      note: 'Revision note',
    },
    c: {
      seq: 'No.',
      material: 'Material',
      placement: 'Placement',
      qty: 'Qty (base)',
      unit: 'Unit',
      wastage: 'Wastage %',
      colour: 'Colour',
      kit: 'In kit',
      note: 'Note',
      supplier: 'Supplier',
      line: 'Line',
      code: 'Code',
      main: 'Main colour',
      details: 'Details',
      point: 'Point',
      unitShort: 'Unit',
      operation: 'Operation',
      centre: 'Work centre',
      machine: 'Machine and stitch',
      checkpoint: 'Check',
      minutes: 'Minutes',
      outside: 'Outside',
      step: 'Step',
      words: 'Instruction',
      safety: 'Safety',
      kind: 'Kind',
      format: 'Format',
      file: 'File',
      symbol: 'Symbol',
      text: 'Text',
      rule: 'Rule',
      quantity: 'Quantity',
      per: 'Per',
      pocket: 'Pocket',
      protector: 'Protector',
      standard: 'Standard',
      level: 'Level',
      where: 'Where',
      certificate: 'Certificate',
      body: 'Notified body',
      validity: 'Valid',
      covers: 'Covers',
      performance: 'Performance',
      test: 'Test',
      frequency: 'Frequency',
      due: 'Due',
      result: 'Result',
      report: 'Report',
      language: 'Language',
      state: 'State',
      from: 'From',
      to: 'To',
      by: 'Released by',
      properties: 'Properties',
      for: 'For',
    },
    yes: 'yes',
    no: '—',
    every: 'all',
    none: 'Nothing to show.',
    noPictures: 'No pictures.',
    pictureMissing: 'Picture not in the PDF: open the current tech pack.',
    noSpec: 'No measurement spec.',
    noTemplate: 'No label template on the revision.',
    composition: 'Composition',
    care: 'Care',
    animal: 'Contains non-textile parts of animal origin.',
    labelLines: "The BOM's labels and packaging",
    packaging: "The brand's packing rules",
    placements: 'Protectors per pocket',
    protectors: "The BOM's protectors",
    certificates: 'EU type-examination certificates',
    tests: 'Production control tests',
    documents: 'Declaration and user information',
    steps: 'Operations',
    instruction: (number: string, version: number) => `Instruction ${number}, version ${version}`,
    pages: 'Pages with callouts',
    patterns: 'Pattern files',
    bySize: 'Quantities by size',
    colourGrid: 'Colours per colourway',
    notUsed: 'not used',
    customer: 'from the customer',
    customerSupplied: 'Supplied by the customer',
    printed: 'Printed on',
    page: 'Page {page} of {pages}',
    continued: 'continued',
    scan: 'Scan the QR to check that this is the current version.',
    draft: (revision: number) => `Revision ${revision} is a draft: it can change before it is released.`,
    obsolete: (revision: number, inForce: number | null) => `Revision ${revision} is obsolete${inForce === null ? '' : `: revision ${inForce} is in force`}.`,
    everyCell: 'every colourway and size',
    everyColourway: 'every colourway',
    sizesWord: 'sizes',
    specWords: (points: number, sizes: number, base: string, missing: number, status: string) => `${points} points × ${sizes} sizes, base size ${base} · ${missing === 0 ? 'nothing missing' : `${missing} values missing`} · ${status}`,
    specStatus: { DRAFT: 'draft', APPROVED: 'approved', ARCHIVED: 'archived' } as Record<string, string>,
    notPpe: 'Not PPE: no certificate, declaration of conformity or user information is needed.',
    category: { CATEGORY_I: 'Category I PPE', CATEGORY_II: 'Category II PPE', CATEGORY_III: 'Category III PPE' } as Record<string, string>,
    classWord: 'class',
    noCertificate: 'No certificate is needed.',
    noSku: 'No SKU is switched on.',
    covered: (covered: number, all: number) => `Covered by certificates: ${covered} of ${all} switched-on colourway × size.`,
    documentKinds: { DECLARATION_OF_CONFORMITY: 'EU Declaration of Conformity', USER_INFORMATION: 'User information' } as Record<string, string>,
    documentStates: { CURRENT: 'current', OLDER_REVISION: 'of an older revision', MISSING: 'missing' } as Record<string, string>,
  },
} as const

type Words = (typeof WORDS)['it'] | (typeof WORDS)['en']

const col = (label: string, width: number, align: PaperColumn['align'] = 'left'): PaperColumn => ({ label, width, align })
const orDash = (value: string | null | undefined, w: Words): string => (value === null || value === undefined || value === '' ? w.no : value)
const refText = (value: { readonly code: string; readonly name: string } | null | undefined, w: Words): string => (value ? (value.name && value.name !== value.code ? `${value.code} · ${value.name}` : value.code) : w.no)

/** What the release takes, in the paper's words. */
function scopeText(view: TechPackView, w: Words): string {
  const { scopeColourways, scopeSizes } = view.revision
  if (scopeColourways.length === 0 && scopeSizes.length === 0) return w.everyCell
  return `${scopeColourways.length === 0 ? w.everyColourway : scopeColourways.join(', ')} · ${w.sizesWord} ${scopeSizes.length === 0 ? w.every : scopeSizes.join(', ')}`
}

/** The PPE classification, in the paper's words. */
function classificationText(classification: { readonly category: string; readonly standard: string | null; readonly ppeClass: string | null }, w: Words): string {
  if (classification.category === 'NOT_PPE') return w.notPpe
  return [w.category[classification.category] ?? classification.category, classification.standard, classification.ppeClass ? `${w.classWord} ${classification.ppeClass}` : null].filter((part): part is string => part !== null).join(' · ')
}

/** Widths per mille that add up to 1000 (the last column takes what is left). */
function widths(columns: readonly PaperColumn[]): PaperColumn[] {
  const sum = columns.slice(0, -1).reduce((total, column) => total + column.width, 0)
  return columns.map((column, index) => (index === columns.length - 1 ? { ...column, width: Math.max(60, 1000 - sum) } : column))
}

const table = (title: string | null, columns: readonly PaperColumn[], rows: readonly (readonly string[])[], empty: string): PaperBlock => ({ kind: 'table', table: { title, columns: widths(columns), rows, empty } })

const pictureOf = (picture: TechPackPicture): PaperPicture => ({
  fileId: picture.fileId,
  caption: [picture.caption, picture.colourway ? refText(picture.colourway, WORDS.en) : null].filter((part): part is string => part !== null && part !== '').join(' · '),
  callouts: picture.callouts.map((callout) => ({ ...callout })),
})

// ---- sections --------------------------------------------------------------------------------------------------------------------

function coverOf(view: TechPackView, meta: PaperMeta, w: Words, language: TechPackLanguage): PaperBlock[] {
  const { style, revision } = view
  const facts: PaperFact[] = [
    { label: w.f.style, value: style.code },
    { label: w.f.name, value: style.name },
    { label: w.f.season, value: orDash(style.season, w) },
    { label: w.f.productType, value: style.productTypeName ?? style.productType },
    { label: w.f.brand, value: refText(style.brand, w) },
    { label: w.f.sizes, value: style.sizes.map((size) => size.label).join(', ') || w.no },
    { label: w.f.baseSize, value: orDash(style.baseSize, w) },
    { label: w.f.revision, value: `${revision.revision} · ${w.status[revision.status] ?? revision.status}` },
    { label: w.f.released, value: revision.releasedAt ? formatDateTime(new Date(revision.releasedAt), meta.timeZone, language) : w.no },
    { label: w.f.effective, value: revision.effectiveFrom ? formatDate(revision.effectiveFrom, language) : w.no },
    { label: w.f.scope, value: scopeText(view, w) },
    { label: w.f.output, value: revision.output },
    { label: w.f.gender, value: orDash(style.gender, w) },
    { label: w.f.customs, value: [style.hsCode, style.originCountry].filter((part): part is string => part !== null).join(' · ') || w.no },
  ]
  if (revision.completenessPct !== null && !isPartnerAudience(view.audience)) facts.push({ label: w.f.completeness, value: `${revision.completenessPct} %` })
  if (meta.party) facts.push({ label: w.f.preparedFor, value: refText(meta.party, w) })
  const notes = [style.shortDescription, style.longDescription, revision.changeNote ? `${w.f.note}: ${revision.changeNote}` : null].filter((note): note is string => note !== null && note !== undefined && note !== '')
  return [{ kind: 'facts', facts }, ...(notes.length > 0 ? [{ kind: 'notes' as const, title: w.f.description, notes }] : [])]
}

function lineRow(line: TechPackBomLine, view: TechPackView, w: Words): string[] {
  const colour = line.colourDependent ? line.colours.map((entry) => `${entry.colourway}: ${entry.colour ? refText(entry.colour, w) : w.notUsed}`).join('; ') : refText(line.colour, w)
  const extras = [
    line.option,
    line.colourwayOnly ? `${w.c.for} ${line.colourwayOnly.code}` : null,
    line.subAssembly ? `${line.subAssembly.styleCode} r${line.subAssembly.revision}` : null,
    line.customerSupplied ? w.customerSupplied + (line.customerParty ? ` (${line.customerParty.code})` : '') : null,
    line.note ?? null,
  ].filter((part): part is string => part !== null && part !== undefined && part !== '')
  const cells = [
    `${'  '.repeat(line.depth)}${line.seq}`,
    refText(line.material, w),
    orDash(line.placement, w),
    line.qty,
    line.uom,
    line.wastagePct,
    colour,
  ]
  if (view.audience !== 'BRAND') cells.push(line.kit ? w.yes : w.no)
  cells.push(extras.join(' · ') || w.no)
  if (!isPartnerAudience(view.audience)) cells.push(refText(line.supplierParty ?? null, w))
  return cells
}

function lineColumns(view: TechPackView, w: Words): PaperColumn[] {
  return [
    col(w.c.seq, 55),
    col(w.c.material, 200),
    col(w.c.placement, 110),
    col(w.c.qty, 70, 'right'),
    col(w.c.unit, 50),
    col(w.c.wastage, 60, 'right'),
    col(w.c.colour, 130),
    ...(view.audience !== 'BRAND' ? [col(w.c.kit, 50, 'center')] : []),
    col(w.c.note, 150),
    ...(isPartnerAudience(view.audience) ? [] : [col(w.c.supplier, 125)]),
  ]
}

function bomOf(view: TechPackView, w: Words): PaperBlock[] {
  if (!view.bom) return []
  const blocks: PaperBlock[] = view.bom.sections.map((section) => table(w.bomSections[section.section] ?? section.section, lineColumns(view, w), section.lines.map((line) => lineRow(line, view, w)), w.none))
  if (view.bom.sections.length === 0) blocks.push({ kind: 'notes', title: null, notes: [w.none] })
  const sized = view.bom.sections.flatMap((section) => section.lines).filter((line) => line.sizeDependent)
  if (sized.length > 0) {
    const sizes = view.style.sizes
    const share = Math.floor(720 / Math.max(1, sizes.length))
    blocks.push(
      table(
        w.bySize,
        [col(w.c.line, 280), ...sizes.map((size) => col(size.label, share, 'right'))],
        sized.map((line) => [`${line.seq} ${line.material.code} (${line.uom})`, ...sizes.map((size) => line.bySize.find((entry) => entry.size === size.code)?.qty ?? w.no)]),
        w.none,
      ),
    )
  }
  return blocks
}

function colourwaysOf(view: TechPackView, w: Words): PaperBlock[] {
  const colourways = view.colourways ?? []
  const blocks: PaperBlock[] = [
    table(
      null,
      [col(w.c.code, 120), col(w.f.name, 220), col(w.c.main, 280), col(w.c.details, 380)],
      colourways.map((colourway) => [
        colourway.code,
        colourway.name,
        colourway.colour ? [refText(colourway.colour, w), colourway.colour.system && colourway.colour.reference ? `${colourway.colour.system} ${colourway.colour.reference}` : null].filter((part): part is string => part !== null).join(' · ') : w.no,
        orDash(colourway.description, w),
      ]),
      w.none,
    ),
  ]
  const lines = [...new Map(colourways.flatMap((colourway) => colourway.colours.map((entry) => [entry.seq, entry.material] as const))).entries()].sort((a, b) => a[0] - b[0])
  if (lines.length > 0 && colourways.length > 0) {
    const share = Math.floor(700 / colourways.length)
    blocks.push(
      table(
        w.colourGrid,
        [col(w.c.line, 300), ...colourways.map((colourway) => col(colourway.code, share))],
        lines.map(([seq, material]) => [
          `${seq} ${refText(material, w)}`,
          ...colourways.map((colourway) => {
            const cell = colourway.colours.find((entry) => entry.seq === seq)
            return !cell || !cell.used ? w.notUsed : refText(cell.colour, w)
          }),
        ]),
        w.none,
      ),
    )
  }
  return blocks
}

function sizeSpecOf(view: TechPackView, w: Words): PaperBlock[] {
  const spec = view.sizeSpec
  if (!spec) return [{ kind: 'notes', title: null, notes: [w.noSpec] }]
  const share = Math.floor(640 / Math.max(1, spec.sizes.length))
  return [
    { kind: 'notes', title: null, notes: [w.specWords(spec.points.length, spec.sizes.length, spec.baseSize, spec.missing, w.specStatus[spec.status] ?? spec.status)] },
    table(
      null,
      [col(w.c.point, 140), col(w.f.name, 160), col(w.c.unitShort, 60), ...spec.sizes.map((size) => col(size, share, 'right'))],
      spec.points.map((point) => [point.code, point.name, point.unit, ...point.values.map((value) => (value ? value.words.replace(/\s*(cm|mm)$/i, '') : w.no))]),
      w.noSpec,
    ),
  ]
}

function constructionOf(view: TechPackView, w: Words): PaperBlock[] {
  const construction = view.construction
  if (!construction) return []
  const internal = !isPartnerAudience(view.audience)
  const blocks: PaperBlock[] = [
    table(
      w.steps,
      [
        col(w.c.seq, 50),
        col(w.c.operation, 190),
        col(w.c.centre, 120),
        col(w.c.machine, 290),
        col(w.c.checkpoint, 150),
        ...(internal ? [col(w.c.minutes, 70, 'right')] : []),
        col(w.c.outside, 130),
      ],
      construction.steps.map((step) => [
        String(step.seq),
        [`${step.code} · ${step.name}`, step.forCells].filter((part): part is string => part !== null).join('\n'),
        step.workCentre,
        step.settings.map((setting) => setting.line).join('\n') || w.no,
        orDash(step.checkpoint, w),
        ...(internal ? [step.standardMinutes ?? w.no] : []),
        step.subcontracted ? (internal && step.workshopParty ? refText(step.workshopParty, w) : w.yes) : w.no,
      ]),
      w.none,
    ),
  ]
  for (const step of construction.steps) {
    if (step.instruction) {
      blocks.push(
        table(
          `${step.seq} ${step.code} · ${w.instruction(step.instruction.number, step.instruction.version)}`,
          [col(w.c.step, 140), col(w.c.words, 560), col(w.c.safety, 300)],
          step.instruction.steps.map((entry) => [`${entry.code}${entry.critical ? ' !' : ''}`, entry.words, orDash(entry.safety, w)]),
          w.none,
        ),
      )
    } else if (step.instructions) {
      blocks.push({ kind: 'notes', title: `${step.seq} ${step.code}`, notes: [step.instructions] })
    }
  }
  if (construction.pages.length > 0) blocks.push({ kind: 'notes', title: w.pages, notes: [] }, { kind: 'pictures', pictures: construction.pages.map(pictureOf), missing: w.pictureMissing })
  if (construction.patterns.length > 0) {
    blocks.push(
      table(
        w.patterns,
        [col(w.c.kind, 140), col(w.c.format, 140), col(w.f.sizes, 200), col(w.c.file, 260), col(w.c.note, 260)],
        construction.patterns.map((entry) => [entry.kind, orDash(entry.format, w), entry.sizes.length === 0 ? w.every : entry.sizes.join(', '), entry.fileName, orDash(entry.note, w)]),
        w.none,
      ),
    )
  }
  return blocks
}

function labelsOf(view: TechPackView, w: Words): PaperBlock[] {
  const labels = view.labels
  if (!labels) return []
  const blocks: PaperBlock[] = []
  const template = labels.template
  if (template) {
    blocks.push({
      kind: 'facts',
      facts: [
        { label: w.c.code, value: `${template.code} r${template.revision} · ${template.name}` },
        { label: w.c.kind, value: template.kind },
        { label: w.c.state, value: template.status },
        { label: w.c.language, value: template.languages.join(', ') || w.no },
        { label: w.f.brand, value: template.maker },
        { label: w.c.format, value: template.size },
      ],
    })
    const composition = template.composition.map((part) => `${part.part}: ${part.fibres.map((fibre) => `${fibre.percent}% ${fibre.fibre}`).join(', ')}`)
    if (template.animalOriginPhrase) composition.push(w.animal)
    if (composition.length > 0) blocks.push({ kind: 'notes', title: w.composition, notes: composition })
    if (template.care.length > 0) blocks.push(table(w.care, [col(w.c.symbol, 300), col(w.c.text, 700)], template.care.map((entry) => [entry.symbol, entry.text]), w.none))
  } else {
    blocks.push({ kind: 'notes', title: null, notes: [w.noTemplate] })
  }
  blocks.push(table(w.labelLines, lineColumns(view, w), labels.lines.map((line) => lineRow(line, view, w)), w.none))
  if (labels.branding) {
    blocks.push(
      table(
        `${w.packaging}: ${labels.branding.code} · ${labels.branding.name}`,
        [col(w.c.rule, 160), col(w.c.text, 460), col(w.c.material, 200), col(w.c.quantity, 90, 'right'), col(w.c.per, 90)],
        labels.branding.rules.map((rule) => [rule.key, rule.text, refText(rule.material, w), orDash(rule.quantity, w), orDash(rule.per, w)]),
        w.none,
      ),
    )
  }
  return blocks
}

function protectionOf(view: TechPackView, w: Words, language: TechPackLanguage): PaperBlock[] {
  const protection = view.protection
  if (!protection) return []
  const day = (value: string | null) => (value ? formatDate(value, language) : w.no)
  return [
    {
      kind: 'notes',
      title: null,
      notes: [
        classificationText(protection.classification, w),
        !protection.coverage.required ? w.noCertificate : protection.coverage.covered + protection.coverage.notCovered === 0 ? w.noSku : w.covered(protection.coverage.covered, protection.coverage.covered + protection.coverage.notCovered),
      ],
    },
    table(
      w.placements,
      [col(w.c.pocket, 120), col(w.c.protector, 260), col(w.c.standard, 160), col(w.c.level, 70, 'center'), col(w.f.sizes, 150), col(w.c.where, 240)],
      protection.placements.map((entry) => [entry.pocket, refText(entry.protector, w), entry.standard, entry.level, entry.sizes.length === 0 ? w.every : entry.sizes.join(', '), orDash(entry.positionNote, w)]),
      w.none,
    ),
    table(
      w.protectors,
      [col(w.c.seq, 60), col(w.c.material, 280), col(w.c.placement, 180), col(w.c.qty, 80, 'right'), col(w.c.properties, 400)],
      protection.protectors.map((line) => [
        String(line.seq),
        refText(line.material, w),
        orDash(line.placement, w),
        `${line.qty} ${line.uom}`,
        line.properties ? Object.entries(line.properties).map(([key, value]) => `${key}: ${String(value)}`).join(' · ') : w.no,
      ]),
      w.none,
    ),
    table(
      w.certificates,
      [col(w.c.certificate, 170), col(w.c.standard, 150), col(w.c.body, 190), col(w.c.validity, 170), col(w.c.covers, 170), col(w.c.performance, 150)],
      protection.certificates.map((entry) => [
        `${entry.number}${entry.ppeClass ? ` · ${entry.ppeClass}` : ''}`,
        entry.standard,
        `${entry.notifiedBody} (${entry.notifiedBodyNumber})`,
        `${day(entry.validFrom)} – ${day(entry.validTo)} · ${entry.status}`,
        `${entry.colourways.length === 0 ? w.every : entry.colourways.join(', ')} / ${entry.sizes.length === 0 ? w.every : entry.sizes.join(', ')}`,
        Object.entries(entry.performanceLevels).map(([key, value]) => `${key} ${value}`).join(', ') || w.no,
      ]),
      w.none,
    ),
    table(
      w.tests,
      [col(w.c.test, 220), col(w.c.standard, 140), col(w.c.frequency, 120), col(w.c.due, 110), col(w.c.result, 130), col(w.c.report, 280)],
      protection.tests.map((entry) => [
        [entry.test, entry.name].filter((part): part is string => part !== null).join(' · '),
        orDash(entry.standardClause, w),
        entry.frequency,
        day(entry.dueOn),
        entry.result ? `${entry.result}${entry.testedOn ? ` · ${day(entry.testedOn)}` : ''}` : w.no,
        [entry.reportNumber, entry.resultNote].filter((part): part is string => part !== null && part !== '').join(' · ') || w.no,
      ]),
      w.none,
    ),
  ]
}

function complianceOf(view: TechPackView, w: Words): PaperBlock[] {
  const compliance = view.compliance
  if (!compliance) return []
  // The office's open blockers stay on screen (the live tech pack): the paper says what the garment is and its documents.
  return [
    { kind: 'notes', title: null, notes: [classificationText(compliance.classification, w), `${w.f.scope}: ${scopeText(view, w)}`] },
    table(
      w.documents,
      [col(w.c.kind, 420), col(w.c.language, 200), col(w.c.state, 380)],
      compliance.documents.map((entry) => [w.documentKinds[entry.kind] ?? entry.kind, entry.language, w.documentStates[entry.state] ?? entry.state]),
      w.none,
    ),
  ]
}

function revisionLogOf(view: TechPackView, meta: PaperMeta, w: Words, language: TechPackLanguage): PaperBlock[] {
  const log = view.revisionLog ?? []
  const internal = !isPartnerAudience(view.audience)
  const brand = view.audience === 'BRAND'
  return [
    table(
      null,
      [col(w.c.seq, 80), col(w.c.state, 120), col(w.f.released, 200), col(w.c.from, 120), col(w.c.to, 120), ...(brand ? [] : [col(w.c.note, internal ? 210 : 360)]), ...(internal ? [col(w.c.by, 150)] : [])],
      log.map((entry) => [
        String(entry.revision),
        w.status[entry.status] ?? entry.status,
        entry.releasedAt ? formatDateTime(new Date(entry.releasedAt), meta.timeZone, language) : w.no,
        entry.effectiveFrom ? formatDate(entry.effectiveFrom, language) : w.no,
        entry.effectiveTo ? formatDate(entry.effectiveTo, language) : w.no,
        ...(brand ? [] : [orDash(entry.changeNote ?? null, w)]),
        ...(internal ? [orDash(entry.releasedBy ?? null, w)] : []),
      ]),
      w.none,
    ),
  ]
}

/** The paper of one PDF version: the audience's view (its rules already applied), its words, the QR on every page. */
export function techPackPaper(source: TechPackView, meta: PaperMeta): TechPackPaper {
  // A paper travels: no money in it, whatever the audience.
  const view = withoutMoney(source)
  const language = view.language
  const w: Words = WORDS[language]
  const status = w.status[view.revision.status] ?? view.revision.status
  const sections: PaperSection[] = []
  const add = (section: TechPackSection, blocks: PaperBlock[]) => sections.push({ section, title: w.sections[section], blocks })
  const included = new Set(view.sections.filter((entry) => entry.included).map((entry) => entry.section))
  const shown = (section: TechPackSection): boolean => included.has(section)
  if (shown('COVER')) add('COVER', coverOf(view, meta, w, language))
  if (shown('SKETCHES')) add('SKETCHES', view.sketches && view.sketches.length > 0 ? [{ kind: 'pictures', pictures: view.sketches.map(pictureOf), missing: w.pictureMissing }] : [{ kind: 'notes', title: null, notes: [w.noPictures] }])
  if (shown('BOM')) add('BOM', bomOf(view, w))
  if (shown('COLOURWAYS')) add('COLOURWAYS', colourwaysOf(view, w))
  if (shown('SIZE_SPEC')) add('SIZE_SPEC', sizeSpecOf(view, w))
  if (shown('CONSTRUCTION')) add('CONSTRUCTION', constructionOf(view, w))
  if (shown('LABELS')) add('LABELS', labelsOf(view, w))
  if (shown('PROTECTION')) add('PROTECTION', protectionOf(view, w, language))
  if (shown('COMPLIANCE')) add('COMPLIANCE', complianceOf(view, w))
  if (shown('REVISION_LOG')) add('REVISION_LOG', revisionLogOf(view, meta, w, language))

  const versionLine = [`${w.revision} ${view.revision.revision} · ${status}`, `${w.version} ${meta.version}`].join(' · ')
  const audienceLine = `${w.audience[view.audience]}${meta.party ? ` ${w.for} ${refText(meta.party, w)}` : ''}`
  const title = `${w.title} ${view.style.code} r${view.revision.revision} v${meta.version}`
  return {
    language,
    title: w.title,
    styleLine: `${view.style.code} · ${view.style.name}`,
    versionLine,
    audienceLine,
    qr: meta.qr,
    code: meta.code,
    banner: view.revision.status === 'DRAFT' ? w.draft(view.revision.revision) : view.revision.status === 'OBSOLETE' ? w.obsolete(view.revision.revision, view.inForce?.revision ?? null) : null,
    sections,
    footer: { printed: `${w.printed} ${formatDateTime(meta.printedAt, meta.timeZone, language)}`, page: w.page, continued: w.continued, scan: w.scan },
    meta: { title, subject: `${view.style.code} · ${view.style.name}`, createdAt: meta.printedAt.toISOString() },
  }
}

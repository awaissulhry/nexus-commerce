import { NATURA_WORDED } from '../../_shared/model'

/**
 * The invoice's legal file shown readable (B-W2a-80; design finance.invoices tab:xml "XML view — the legal file, shown
 * readable for checking"), pure: a small reader of the FatturaPA XML (elements, text, entities; declarations, comments
 * and attributes skipped) and its sections as a person checks them — transmission, seller, buyer, the document, its DDTs
 * and orders, the lines, the VAT summary, the payment, the attachments. Every field keeps its legal tag name beside our
 * words, so the reader can hold it against the file; a tag we have no words for shows as itself. No fetching, no React.
 */

export interface XmlNode {
  /** The local name (a `p:` prefix dropped). */
  name: string
  text: string
  children: XmlNode[]
}

const ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

function decode(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith('#x')) return String.fromCodePoint(Number.parseInt(body.slice(2), 16))
    if (body.startsWith('#')) return String.fromCodePoint(Number.parseInt(body.slice(1), 10))
    return ENTITIES[body] ?? whole
  })
}

const localName = (name: string): string => name.slice(name.indexOf(':') + 1)

/** The XML's root element, or null when the text is not well-formed (a tag left open, a closing tag that does not match). */
export function parseXml(source: string): XmlNode | null {
  const stack: XmlNode[] = []
  let root: XmlNode | null = null
  let at = 0
  const text = source.replace(/^﻿/, '')
  while (at < text.length) {
    const open = text.indexOf('<', at)
    if (open < 0) {
      if (text.slice(at).trim() !== '' && stack.length > 0) stack[stack.length - 1]!.text += decode(text.slice(at))
      break
    }
    if (open > at && stack.length > 0) stack[stack.length - 1]!.text += decode(text.slice(at, open))
    if (text.startsWith('<?', open)) {
      const end = text.indexOf('?>', open)
      if (end < 0) return null
      at = end + 2
      continue
    }
    if (text.startsWith('<!--', open)) {
      const end = text.indexOf('-->', open)
      if (end < 0) return null
      at = end + 3
      continue
    }
    if (text.startsWith('<![CDATA[', open)) {
      const end = text.indexOf(']]>', open)
      if (end < 0) return null
      if (stack.length > 0) stack[stack.length - 1]!.text += text.slice(open + 9, end)
      at = end + 3
      continue
    }
    if (text.startsWith('<!', open)) {
      const end = text.indexOf('>', open)
      if (end < 0) return null
      at = end + 1
      continue
    }
    const close = text.indexOf('>', open)
    if (close < 0) return null
    const body = text.slice(open + 1, close).trim()
    at = close + 1
    if (body.startsWith('/')) {
      const name = localName(body.slice(1).trim())
      const node = stack.pop()
      if (!node || node.name !== name) return null
      node.text = node.text.trim()
      if (stack.length === 0) root = node
      continue
    }
    const selfClosing = body.endsWith('/')
    const name = localName((selfClosing ? body.slice(0, -1) : body).trim().split(/\s+/)[0] ?? '')
    if (name === '') return null
    const node: XmlNode = { name, text: '', children: [] }
    if (stack.length > 0) stack[stack.length - 1]!.children.push(node)
    else if (root !== null) return null
    if (selfClosing) {
      if (stack.length === 0) root = node
    } else stack.push(node)
  }
  return stack.length === 0 ? root : null
}

/** The FatturaPA tags this screen has words for (`xml.tag.<Tag>` in finance-daily); any other shows as itself. */
export const KNOWN_TAGS = [
  'DatiTrasmissione', 'IdTrasmittente', 'IdPaese', 'IdCodice', 'ProgressivoInvio', 'FormatoTrasmissione', 'CodiceDestinatario', 'PECDestinatario', 'ContattiTrasmittente',
  'CedentePrestatore', 'CessionarioCommittente', 'RappresentanteFiscale', 'TerzoIntermediarioOSoggettoEmittente', 'SoggettoEmittente', 'DatiAnagrafici', 'IdFiscaleIVA', 'CodiceFiscale', 'Anagrafica', 'Denominazione', 'Nome', 'Cognome', 'RegimeFiscale', 'Sede', 'StabileOrganizzazione', 'Indirizzo', 'NumeroCivico', 'CAP', 'Comune', 'Provincia', 'Nazione', 'IscrizioneREA', 'Ufficio', 'NumeroREA', 'CapitaleSociale', 'SocioUnico', 'StatoLiquidazione', 'Contatti', 'Telefono', 'Email', 'RiferimentoAmministrazione',
  'DatiGenerali', 'DatiGeneraliDocumento', 'TipoDocumento', 'Divisa', 'Data', 'Numero', 'ImportoTotaleDocumento', 'Arrotondamento', 'Causale', 'DatiBollo', 'BolloVirtuale', 'ImportoBollo', 'DatiOrdineAcquisto', 'DatiContratto', 'RiferimentoNumeroLinea', 'IdDocumento', 'CodiceCommessaConvenzione', 'DatiDDT', 'NumeroDDT', 'DataDDT', 'DatiFattureCollegate', 'DatiTrasporto',
  'DatiBeniServizi', 'DettaglioLinee', 'NumeroLinea', 'TipoCessionePrestazione', 'CodiceArticolo', 'CodiceTipo', 'CodiceValore', 'Descrizione', 'Quantita', 'UnitaMisura', 'PrezzoUnitario', 'ScontoMaggiorazione', 'Tipo', 'Percentuale', 'Importo', 'PrezzoTotale', 'AliquotaIVA', 'Natura', 'DatiRiepilogo', 'ImponibileImporto', 'Imposta', 'EsigibilitaIVA', 'RiferimentoNormativo', 'SpeseAccessorie', 'AltriDatiGestionali', 'TipoDato', 'RiferimentoTesto', 'RiferimentoData', 'RiferimentoNumero',
  'DatiPagamento', 'CondizioniPagamento', 'DettaglioPagamento', 'ModalitaPagamento', 'DataScadenzaPagamento', 'ImportoPagamento', 'IBAN', 'BIC', 'IstitutoFinanziario', 'Beneficiario', 'ScontoPagamentoAnticipato', 'DataLimitePagamentoAnticipato',
  'Allegati', 'NomeAttachment', 'FormatoAttachment', 'DescrizioneAttachment', 'Attachment',
] as const
const KNOWN = new Set<string>(KNOWN_TAGS)
export const tagKey = (tag: string): string | null => (KNOWN.has(tag) ? `xml.tag.${tag}` : null)

/** Elements a person reads as rows of a table (several per parent in FatturaPA). */
const TABLE_TAGS = new Set(['DettaglioLinee', 'DatiRiepilogo', 'DettaglioPagamento', 'DatiDDT', 'DatiOrdineAcquisto', 'DatiContratto', 'DatiFattureCollegate', 'Allegati', 'ScontoMaggiorazione', 'AltriDatiGestionali', 'CodiceArticolo'])

export interface XmlField {
  /** The tags from the section down to the value (the last one names it). */
  path: string[]
  value: string
}

export interface XmlTable {
  tag: string
  /** Each column is a path of tags below the row's element. */
  columns: string[][]
  rows: string[][]
}

export interface XmlSection {
  id: string
  tag: string
  /** A second body (a batch file) numbers its sections. */
  body: number
  fields: XmlField[]
  tables: XmlTable[]
}

const isLeaf = (node: XmlNode): boolean => node.children.length === 0

/** A long attachment (base64) is not drawn: its size in characters is. */
const shown = (node: XmlNode): string => (node.name === 'Attachment' ? `… (${node.text.length})` : node.text)

function leaves(node: XmlNode, path: string[], out: XmlField[]): void {
  for (const child of node.children) {
    if (isLeaf(child)) out.push({ path: [...path, child.name], value: shown(child) })
    else leaves(child, [...path, child.name], out)
  }
}

function tableOf(tag: string, nodes: readonly XmlNode[]): XmlTable {
  const columns: string[][] = []
  const keyOf = (path: string[]) => path.join('/')
  const rows = nodes.map((node) => {
    const fields: XmlField[] = []
    leaves(node, [], fields)
    const row = new Map<string, string>()
    for (const field of fields) {
      const key = keyOf(field.path)
      if (!columns.some((column) => keyOf(column) === key)) columns.push(field.path)
      row.set(key, row.has(key) ? `${row.get(key)}; ${field.value}` : field.value)
    }
    return row
  })
  return { tag, columns, rows: rows.map((row) => columns.map((column) => row.get(keyOf(column)) ?? '')) }
}

/** One section of an element: its leaf fields (nested elements flattened into paths) and its repeated rows as tables. */
function sectionOf(node: XmlNode, id: string, body: number): XmlSection {
  const fields: XmlField[] = []
  const tables: XmlTable[] = []
  const walk = (current: XmlNode, path: string[]) => {
    const seen = new Set<string>()
    for (const child of current.children) {
      if (isLeaf(child)) {
        fields.push({ path: [...path, child.name], value: shown(child) })
        continue
      }
      const same = current.children.filter((entry) => entry.name === child.name)
      if (TABLE_TAGS.has(child.name) || same.length > 1) {
        if (seen.has(child.name)) continue
        seen.add(child.name)
        tables.push(tableOf(child.name, same))
        continue
      }
      walk(child, [...path, child.name])
    }
  }
  walk(node, [])
  return { id, tag: node.name, body, fields, tables }
}

/**
 * The readable sections of a FatturaPA file: one per part of the header (transmission, seller, buyer …), then per body the
 * general data (the document; its orders, contracts, DDTs and linked invoices as tables), the lines and the VAT summary
 * (tables), each payment (its terms and instalments), the attachments. An unknown layout falls back to one section per
 * child of the root, so nothing in the file is ever hidden.
 */
export function xmlSections(root: XmlNode | null): XmlSection[] {
  if (!root) return []
  const sections: XmlSection[] = []
  const header = root.children.find((child) => child.name === 'FatturaElettronicaHeader')
  const bodies = root.children.filter((child) => child.name === 'FatturaElettronicaBody')
  if (!header && bodies.length === 0) return root.children.map((child, index) => sectionOf(child, `part-${index}`, 0))
  for (const [index, child] of (header?.children ?? []).entries()) sections.push(sectionOf(child, `header-${index}-${child.name}`, 0))
  for (const [b, body] of bodies.entries()) {
    for (const part of body.children) {
      if (part.name === 'DatiGenerali') {
        const groups = new Map<string, XmlNode[]>()
        for (const child of part.children) groups.set(child.name, [...(groups.get(child.name) ?? []), child])
        for (const [tag, nodes] of groups) {
          if (nodes.length === 1 && !TABLE_TAGS.has(tag)) sections.push(sectionOf(nodes[0]!, `body-${b}-${tag}`, b))
          else sections.push({ id: `body-${b}-${tag}`, tag, body: b, fields: [], tables: [tableOf(tag, nodes)] })
        }
      } else if (part.name === 'DatiBeniServizi') {
        const groups = new Map<string, XmlNode[]>()
        for (const child of part.children) groups.set(child.name, [...(groups.get(child.name) ?? []), child])
        for (const [tag, nodes] of groups) sections.push({ id: `body-${b}-${tag}`, tag, body: b, fields: [], tables: [tableOf(tag, nodes)] })
      } else if (part.name === 'Allegati') {
        continue
      } else {
        sections.push(sectionOf(part, `body-${b}-${part.name}-${sections.length}`, b))
      }
    }
    const attachments = body.children.filter((child) => child.name === 'Allegati')
    if (attachments.length > 0) sections.push({ id: `body-${b}-Allegati`, tag: 'Allegati', body: b, fields: [], tables: [tableOf('Allegati', attachments)] })
  }
  return sections
}

/** The FatturaPA version the root names (`versione="FPR12"`), read from the start tag. */
export function versionOf(source: string): string | null {
  return /<(?:[\w-]+:)?FatturaElettronica\b[^>]*\bversione="([^"]+)"/.exec(source)?.[1] ?? null
}

/** The source laid out one element per line, indented (the file as SDI receives it, made readable). */
export function prettyXml(source: string): string {
  const tokens = source.replace(/>\s+</g, '><').replace(/^﻿/, '').split(/(?=<)|(?<=>)/).filter((token) => token !== '')
  const lines: string[] = []
  let depth = 0
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!
    if (token.startsWith('</')) {
      depth = Math.max(0, depth - 1)
      lines.push(`${'  '.repeat(depth)}${token}`)
    } else if (token.startsWith('<?') || token.startsWith('<!') || token.endsWith('/>')) {
      lines.push(`${'  '.repeat(depth)}${token}`)
    } else if (token.startsWith('<')) {
      const next = tokens[index + 1]
      const after = tokens[index + 2]
      if (next !== undefined && !next.startsWith('<') && after?.startsWith('</')) {
        lines.push(`${'  '.repeat(depth)}${token}${next}${after}`)
        index += 2
      } else {
        lines.push(`${'  '.repeat(depth)}${token}`)
        depth += 1
      }
    } else if (token.trim() !== '') {
      lines.push(`${'  '.repeat(depth)}${token.trim()}`)
    }
  }
  return lines.join('\n')
}

/** Values with words of their own: the document type, the payment terms and method, the reason without VAT. */
export function valueWordsKey(tag: string, value: string): { ns: 'finance' | 'finance-daily'; key: string } | null {
  if (tag === 'TipoDocumento' && ['TD01', 'TD02', 'TD04', 'TD24'].includes(value)) return { ns: 'finance', key: `docType.${value}` }
  if (tag === 'CondizioniPagamento' && ['TP01', 'TP02', 'TP03'].includes(value)) return { ns: 'finance-daily', key: `xml.value.${value}` }
  if (tag === 'Natura' && (NATURA_WORDED as readonly string[]).includes(value)) return { ns: 'finance', key: `natura.${value.replace('.', '_')}` }
  return null
}

export type XmlView = 'readable' | 'source'
export const xmlViewOf = (params: { get(name: string): string | null } | null): XmlView => (params?.get('view') === 'source' ? 'source' : 'readable')

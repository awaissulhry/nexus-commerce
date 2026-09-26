/** CHMAP test fixtures: an Amazon template built in memory with JSZip (never the Owner's files; the repo is public). */
import JSZip from 'jszip'
import { detectAmazonTemplate } from '../../amazon/template-workbook.js'

export const IT = 'APJ6JRA9NG5V4'
const col = (n: number): string => n > 26 ? col(Math.floor((n - 1) / 26)) + col(((n - 1) % 26) + 1) : String.fromCharCode(64 + n)
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
export async function workbook(rows: Record<number, string[]>): Promise<Buffer> {
  const zip = new JSZip()
  const body = Object.entries(rows).map(([r, cells]) => `<row r="${r}">${cells.map((c, i) => c ? `<c r="${col(i + 1)}${r}" t="inlineStr"><is><t>${esc(c)}</t></is></c>` : '').join('')}</row>`).join('')
  zip.file('xl/workbook.xml', `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Modello" sheetId="1" r:id="rId1"/></sheets></workbook>`)
  zip.file('xl/_rels/workbook.xml.rels', `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`)
  zip.file('xl/worksheets/sheet1.xml', `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`)
  return zip.generateAsync({ type: 'nodebuffer' })
}
export const b64 = (v: unknown) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64')
export const settings = (extra: Record<string, string> = {}) => 'settings=' + Object.entries({ feedType: '256', primaryMarketplaceId: `amzn1.mp.o.${IT}`, contentLanguageTag: 'it_IT', attributeRow: '5', dataRow: '7',
  templateIdentifier: 'tmpl-it-1', Version: '2026.0713', TemplateSignature: b64('COAT,PANTS'), ...extra }).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')
export const h = (key: string, slot = 1, leaf = 'value', lang?: string) => `${key}[marketplace_id=${IT}]${lang ? `[language_tag=${lang}]` : ''}#${slot}.${leaf}`
export const SKU = 'contribution_sku#1.value', TYPE = 'product_type#1.value', ACTION = '::record_action'
export async function template(keys: string[], data: string[][], extra: Record<string, string> = {}) {
  const filler = Array.from({ length: 20 }, (_, i) => `filler_${i}#1.value`)
  const rows: Record<number, string[]> = { 1: [settings(extra)], 5: [...keys, ...filler] }
  data.forEach((cells, i) => { rows[7 + i] = cells })
  return (await detectAmazonTemplate(await workbook(rows), { strict: true }))!
}

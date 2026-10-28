import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { validateXML, type XMLValidationResult } from 'xmllint-wasm'
import { describe, expect, it } from 'vitest'
import { buildFatturaPa } from './build'
import { SAMPLES } from './__fixtures__/samples'

// Every document type is checked against the official schema (Agenzia delle Entrate, Schema_VFPR12_v1.2.3.xsd, see
// __fixtures__/README.md) with libxml2 (xmllint-wasm), offline. The schema imports the W3C xmldsig schema by URL;
// the test points that import at the local copy, since xmllint-wasm makes no network calls.

const FIXTURES = new URL('./__fixtures__/', import.meta.url)
const SCHEMA_FILE = 'Schema_VFPR12_v1.2.3.xsd'
const DSIG_FILE = 'xmldsig-core-schema.xsd'
const DSIG_URL = 'http://www.w3.org/TR/2002/REC-xmldsig-core-20020212/xmldsig-core-schema.xsd'

const schemaBytes = readFileSync(new URL(SCHEMA_FILE, FIXTURES))
const dsigBytes = readFileSync(new URL(DSIG_FILE, FIXTURES))
const schema = schemaBytes
  .toString('utf8')
  .replace(/^﻿/, '')
  .replace(`schemaLocation="${DSIG_URL}"`, `schemaLocation="${DSIG_FILE}"`)

function validate(files: readonly { fileName: string; contents: string }[]): Promise<XMLValidationResult> {
  return validateXML({
    xml: files,
    schema: [{ fileName: 'fatturapa.xsd', contents: schema }],
    preload: [{ fileName: DSIG_FILE, contents: dsigBytes.toString('utf8') }],
  })
}

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

describe('FatturaPA XML against the official XSD (VFPR12 v1.2.3)', () => {
  it('uses the official schema files unchanged (hashes as in __fixtures__/README.md)', () => {
    const readme = readFileSync(new URL('README.md', FIXTURES), 'utf8')
    expect(readme).toContain(sha256(schemaBytes))
    expect(readme).toContain(sha256(dsigBytes))
    expect(schema).toContain('version="1.2.3"')
    expect(schema).toContain(`schemaLocation="${DSIG_FILE}"`)
  })

  it('covers TD01, TD02, TD04 and TD24, Italian and foreign buyers, N3.1, N3.2 and N2.1', () => {
    const docs = Object.values(SAMPLES).map((input) => buildFatturaPa(input))
    expect(new Set(docs.map((doc) => doc.documentType))).toEqual(new Set(['TD01', 'TD02', 'TD04', 'TD24']))
    const xml = docs.map((doc) => doc.xml).join('\n')
    for (const natura of ['N3.1', 'N3.2', 'N2.1']) expect(xml).toContain(`<Natura>${natura}</Natura>`)
    expect(xml).toContain('<CodiceDestinatario>XXXXXXX</CodiceDestinatario>')
    expect(xml).toContain('<CodiceDestinatario>0000000</CodiceDestinatario>')
  })

  for (const [name, input] of Object.entries(SAMPLES)) {
    it(`${name} (${input.documentType}) is valid`, async () => {
      const result = await validate([{ fileName: `${name}.xml`, contents: buildFatturaPa(input).xml }])
      expect(result.errors.map((error) => error.rawMessage)).toEqual([])
      expect(result.valid).toBe(true)
    })
  }

  it('the check is not vacuous: an element out of schema order is refused', async () => {
    const xml = buildFatturaPa(SAMPLES.TD01_IT_B2B!).xml
    const broken = xml.replace(/(<Divisa>EUR<\/Divisa>\n)(\s*<Data>[^<]*<\/Data>\n)/, '$2$1')
    expect(broken).not.toEqual(xml)
    const result = await validate([{ fileName: 'broken.xml', contents: broken }])
    expect(result.valid).toBe(false)
    expect(result.errors.length).toBeGreaterThan(0)
  })

  it('the check is not vacuous: a value outside its type is refused', async () => {
    const xml = buildFatturaPa(SAMPLES.TD01_IT_B2B!).xml.replace('<TipoDocumento>TD01</TipoDocumento>', '<TipoDocumento>TD99</TipoDocumento>')
    const result = await validate([{ fileName: 'bad-type.xml', contents: xml }])
    expect(result.valid).toBe(false)
  })
})

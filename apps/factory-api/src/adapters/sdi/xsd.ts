import { readFileSync } from 'node:fs'

/**
 * The FAKE SDI's schema check (plan A1 §4: "the fake validates the XML against the schema"): the official FatturaPA
 * schema (Schema_VFPR12 v1.2.3 and the W3C xmldsig schema it imports, kept in factory-domain's FatturaPA fixtures)
 * through xmllint-wasm. Local and test only, like the fake itself: xmllint-wasm is a development package of the
 * workspace (factory-domain's XSD tests use it), loaded when the first file is checked, never by production, which
 * makes no FAKE. When it cannot be loaded here the check says so, and the fake refuses the file (fails closed).
 */

export type XmlValidator = (xml: string) => Promise<string[]>

const FIXTURES = new URL('../../../../../packages/factory-domain/src/invoicing/fatturapa/__fixtures__/', import.meta.url)
const DSIG = 'xmldsig-core-schema.xsd'

interface Schema {
  readonly schema: string
  readonly dsig: string
}

let loaded: Schema | null = null
function schema(): Schema {
  if (!loaded) {
    const main = readFileSync(new URL('Schema_VFPR12_v1.2.3.xsd', FIXTURES), 'utf8')
      .replace(/^﻿/, '')
      .replace('schemaLocation="http://www.w3.org/TR/2002/REC-xmldsig-core-20020212/xmldsig-core-schema.xsd"', `schemaLocation="${DSIG}"`)
    loaded = { schema: main, dsig: readFileSync(new URL(DSIG, FIXTURES), 'utf8') }
  }
  return loaded
}

/** The FatturaPA FPR12 schema's errors of an XML (empty when valid). */
export function fatturaPaSchemaValidator(): XmlValidator {
  return async (xml) => {
    let files: Schema
    let validateXML: (options: unknown) => Promise<{ errors: { rawMessage: string }[] }>
    try {
      files = schema()
      const name = 'xmllint-wasm'
      validateXML = ((await import(/* @vite-ignore */ name)) as { validateXML: typeof validateXML }).validateXML
    } catch (error) {
      return [`The fake SDI cannot load the FatturaPA schema here (${(error as Error).message}).`]
    }
    const result = await validateXML({ xml: [{ fileName: 'invoice.xml', contents: xml }], schema: [{ fileName: 'fatturapa.xsd', contents: files.schema }], preload: [{ fileName: DSIG, contents: files.dsig }] })
    return result.errors.map((error) => error.rawMessage)
  }
}

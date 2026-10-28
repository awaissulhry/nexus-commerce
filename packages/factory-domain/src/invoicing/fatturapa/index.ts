// FatturaPA (FPR12, schema VFPR12 v1.2.3): a pure builder from a typed, decimal-based invoice input to the XML SDI
// receives, with the offline checks. Import as `@nexus/factory-domain/invoicing/fatturapa/index`.
export { buildFatturaPa, checkFatturaPaInput, FATTURAPA_NAMESPACE, FATTURAPA_SCHEMA_VERSION } from './build'
export { depositDeductionFrom } from './deposit'
export * from './types'
export { validateFatturaPaInput } from './validate'

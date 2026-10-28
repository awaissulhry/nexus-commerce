# FatturaPA test fixtures

Official schema files, committed unchanged (byte for byte) so the tests validate offline. `xsd.vitest.test.ts`
checks their hashes against this file.

| File | Source | Version | SHA-256 |
|---|---|---|---|
| `Schema_VFPR12_v1.2.3.xsd` | Agenzia delle Entrate / SDI, "Schema del file xml Fattura Ordinaria", https://www.fatturapa.gov.it/export/documenti/fatturapa/v1.4/Schema_VFPR12_v1.2.3.xsd (listed on https://www.fatturapa.gov.it/it/norme-e-regole/documentazione-fattura-elettronica/formato-fatturapa/) | 1.2.3, valid from 1 April 2025 (Specifiche tecniche del formato FatturaPA v1.4) | `152944f6eef9f5d69ef6e955ee173b32142b00a8c1c5222fc97dfab5910e8a8c` |
| `xmldsig-core-schema.xsd` | W3C, imported by the schema above: https://www.w3.org/TR/2002/REC-xmldsig-core-20020212/xmldsig-core-schema.xsd | REC 2002-02-12 | `35cf8197da812c85e40d57891b35c94187569ed474a2dac813ce5090dafcd35c` |

Downloaded 2026-10-28. The schema imports xmldsig by its W3C URL; the test rewrites that import, in memory only, to
the local copy. Field rules (Natura codes, rounding, the SDI checks 004xx) follow the "Specifiche tecniche del
formato FatturaPA" v1.4 and the Agenzia delle Entrate "Allegato A - Specifiche tecniche" v1.9; v1.9.1 (in use from
15 May 2026) adds check 00327 and keeps schema 1.2.3.

`samples.ts` holds the sample invoices. Every company, person, tax number, SDI code, IBAN and address in it is fake.

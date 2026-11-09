import { defineContract, id, input, output } from '@nexus/factory-domain/core/contracts'
import { commerceImportView, startedStylesView } from '@nexus/factory-domain/product/commerce-import/source'

/** The Commerce import's two reads (factory-domain product/commerce-import/source). No money. */
export const commerceImportContract = defineContract({ response: { 200: output({ commerceImport: commerceImportView }) } })
export const startedStylesContract = defineContract({ params: input({ jobId: id() }), response: { 200: startedStylesView } })

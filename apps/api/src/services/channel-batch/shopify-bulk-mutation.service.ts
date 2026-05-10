/**
 * W12.2 — Shopify Admin GraphQL bulkOperationRunMutation wrapper.
 *
 * Bulk-mutation pattern for catalog updates (productUpdate /
 * inventoryAdjustQuantities / variantsBulkUpdate). Pipeline:
 *
 *   1. stagedUploadsCreate           → presigned target + parameters
 *   2. POST staged URL with JSONL    → upload the operation list
 *   3. bulkOperationRunMutation      → kicks off the bulk op
 *   4. currentBulkOperation poll     → terminal status + URL of
 *                                      JSONL result for parsing
 *
 * Dry-run path mirrors W12.1 — NEXUS_SHOPIFY_BULK_DRYRUN=1
 * short-circuits the staged upload + bulk mutation calls so
 * local CI/dev never burns Shopify quota.
 *
 * Note: only one bulk operation per shop can be in-flight at a
 * time. The check-current endpoint surfaces this so the bulk-
 * action handler can defer / fail-fast cleanly.
 */

import { logger } from '../../utils/logger.js'

export interface ShopifyBulkInput {
  /** Single mutation that the operation list will fan out. The
   *  JSONL upload provides the per-item input variables; this
   *  string is the GraphQL mutation Shopify runs for each line. */
  mutation: string
  /** One JSONL line per fan-out call; serialised JSON variables
   *  for the mutation. */
  operations: Array<Record<string, unknown>>
  /** Optional shop override; defaults to process.env. */
  shopName?: string
  accessToken?: string
  apiVersion?: string
}

export interface ShopifyBulkResult {
  bulkOperationId: string
  status: string
  dryRun: boolean
}

export interface ShopifyBulkPollResult {
  id: string
  status:
    | 'CREATED'
    | 'RUNNING'
    | 'COMPLETED'
    | 'FAILED'
    | 'CANCELED'
    | 'CANCELING'
    | 'EXPIRED'
  errorCode: string | null
  url: string | null
  partialDataUrl: string | null
  objectCount: number | null
  fileSize: number | null
}

const DEFAULT_API_VERSION = '2024-01'

function isDryRunEnv(): boolean {
  return process.env.NEXUS_SHOPIFY_BULK_DRYRUN === '1'
}

function resolveShop(input: ShopifyBulkInput): {
  shopName: string
  accessToken: string
  apiVersion: string
} {
  const shopName = input.shopName ?? process.env.SHOPIFY_SHOP_NAME
  const accessToken = input.accessToken ?? process.env.SHOPIFY_ACCESS_TOKEN
  const apiVersion = input.apiVersion ?? DEFAULT_API_VERSION
  if (!shopName) throw new Error('ShopifyBulk: SHOPIFY_SHOP_NAME required')
  if (!accessToken) throw new Error('ShopifyBulk: SHOPIFY_ACCESS_TOKEN required')
  return { shopName, accessToken, apiVersion }
}

function graphqlUrl(shopName: string, apiVersion: string): string {
  return `https://${shopName}.myshopify.com/admin/api/${apiVersion}/graphql.json`
}

async function gql<T>(
  shopName: string,
  accessToken: string,
  apiVersion: string,
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(graphqlUrl(shopName, apiVersion), {
    method: 'POST',
    headers: {
      'X-Shopify-Access-Token': accessToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  })
  if (!res.ok) {
    throw new Error(`ShopifyBulk: HTTP ${res.status} ${res.statusText}`)
  }
  const body = (await res.json()) as { data?: T; errors?: Array<{ message: string }> }
  if (body.errors && body.errors.length > 0) {
    throw new Error(
      `ShopifyBulk: GraphQL errors — ${body.errors.map((e) => e.message).join('; ')}`,
    )
  }
  if (!body.data) throw new Error('ShopifyBulk: empty data field')
  return body.data
}

/** Pack the operations list into JSONL — one minified JSON object
 *  per newline-terminated line. Shopify rejects the upload with a
 *  cryptic "BAD_FILE" if any line carries an unescaped newline, so
 *  we use JSON.stringify which already strips them. */
export function buildJsonl(
  operations: Array<Record<string, unknown>>,
): string {
  return operations.map((o) => JSON.stringify(o)).join('\n') + '\n'
}

interface StagedUploadParameter {
  name: string
  value: string
}

interface StagedTarget {
  url: string
  resourceUrl: string
  parameters: StagedUploadParameter[]
}

const STAGED_UPLOADS_CREATE = `
  mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
    stagedUploadsCreate(input: $input) {
      stagedTargets { url resourceUrl parameters { name value } }
      userErrors { field message }
    }
  }
`

const BULK_OPERATION_RUN_MUTATION = `
  mutation bulkOperationRunMutation($mutation: String!, $stagedUploadPath: String!) {
    bulkOperationRunMutation(mutation: $mutation, stagedUploadPath: $stagedUploadPath) {
      bulkOperation { id status }
      userErrors { field message }
    }
  }
`

const CURRENT_BULK_OPERATION = `
  query currentBulkOperation {
    currentBulkOperation(type: MUTATION) {
      id status errorCode url partialDataUrl objectCount fileSize
    }
  }
`

export async function submitShopifyBulkMutation(
  input: ShopifyBulkInput,
): Promise<ShopifyBulkResult> {
  if (!input.mutation || !input.mutation.trim()) {
    throw new Error('ShopifyBulk: mutation required')
  }
  if (!Array.isArray(input.operations) || input.operations.length === 0) {
    throw new Error('ShopifyBulk: operations must be non-empty')
  }
  const jsonl = buildJsonl(input.operations)

  if (isDryRunEnv()) {
    logger.info('[shopify-bulk] dryRun — bulk operation not submitted', {
      messageCount: input.operations.length,
      bytes: jsonl.length,
    })
    return {
      bulkOperationId: `gid://shopify/BulkOperation/dryrun-${Date.now()}`,
      status: 'CREATED',
      dryRun: true,
    }
  }

  const { shopName, accessToken, apiVersion } = resolveShop(input)

  // Step 1: stagedUploadsCreate — get a presigned upload target.
  type StagedRes = {
    stagedUploadsCreate: {
      stagedTargets: StagedTarget[]
      userErrors: Array<{ field: string[]; message: string }>
    }
  }
  const staged = await gql<StagedRes>(
    shopName,
    accessToken,
    apiVersion,
    STAGED_UPLOADS_CREATE,
    {
      input: [
        {
          resource: 'BULK_MUTATION_VARIABLES',
          filename: 'bulk_op_vars.jsonl',
          mimeType: 'text/jsonl',
          httpMethod: 'POST',
        },
      ],
    },
  )
  if (staged.stagedUploadsCreate.userErrors.length > 0) {
    throw new Error(
      `ShopifyBulk: stagedUploadsCreate userErrors — ${staged.stagedUploadsCreate.userErrors
        .map((e) => e.message)
        .join('; ')}`,
    )
  }
  const target = staged.stagedUploadsCreate.stagedTargets[0]
  if (!target) throw new Error('ShopifyBulk: no stagedTarget returned')

  // Step 2: POST jsonl to the staged target. Shopify uses S3-style
  // multipart/form-data with the parameters returned in step 1
  // appended ahead of the file.
  const form = new FormData()
  for (const p of target.parameters) form.append(p.name, p.value)
  form.append('file', new Blob([jsonl], { type: 'text/jsonl' }), 'bulk_op_vars.jsonl')
  const uploadRes = await fetch(target.url, {
    method: 'POST',
    body: form,
  })
  if (!uploadRes.ok) {
    throw new Error(
      `ShopifyBulk: upload failed HTTP ${uploadRes.status} ${uploadRes.statusText}`,
    )
  }

  // Step 3: bulkOperationRunMutation
  type RunRes = {
    bulkOperationRunMutation: {
      bulkOperation: { id: string; status: string } | null
      userErrors: Array<{ field: string[]; message: string }>
    }
  }
  const run = await gql<RunRes>(
    shopName,
    accessToken,
    apiVersion,
    BULK_OPERATION_RUN_MUTATION,
    {
      mutation: input.mutation,
      stagedUploadPath: target.resourceUrl,
    },
  )
  if (run.bulkOperationRunMutation.userErrors.length > 0) {
    throw new Error(
      `ShopifyBulk: bulkOperationRunMutation userErrors — ${run.bulkOperationRunMutation.userErrors
        .map((e) => e.message)
        .join('; ')}`,
    )
  }
  const op = run.bulkOperationRunMutation.bulkOperation
  if (!op) throw new Error('ShopifyBulk: bulkOperation null')
  return { bulkOperationId: op.id, status: op.status, dryRun: false }
}

export async function pollShopifyBulkStatus(
  input: { shopName?: string; accessToken?: string; apiVersion?: string } = {},
): Promise<ShopifyBulkPollResult> {
  if (isDryRunEnv()) {
    return {
      id: `gid://shopify/BulkOperation/dryrun-${Date.now()}`,
      status: 'COMPLETED',
      errorCode: null,
      url: null,
      partialDataUrl: null,
      objectCount: 0,
      fileSize: 0,
    }
  }
  const { shopName, accessToken, apiVersion } = resolveShop({
    ...input,
    mutation: '',
    operations: [{}],
  })
  type PollRes = {
    currentBulkOperation: ShopifyBulkPollResult | null
  }
  const r = await gql<PollRes>(
    shopName,
    accessToken,
    apiVersion,
    CURRENT_BULK_OPERATION,
  )
  if (!r.currentBulkOperation) {
    throw new Error('ShopifyBulk: no current bulk operation in flight')
  }
  return r.currentBulkOperation
}

/**
 * eBay Sell Feed API client (v1)
 *
 * Wraps the three Feed API operations needed by the flat-file push flow:
 *   1. createInventoryTask  — POST /sell/feed/v1/task
 *   2. uploadFeedFile       — POST /sell/feed/v1/task/{taskId}/upload_file
 *   3. getTaskStatus        — GET  /sell/feed/v1/task/{taskId}
 *   4. downloadResultFile   — follows task.resultFileReferenceId → content
 *
 * Also exports buildInventoryNdjson() which converts EbayFlatRow[]
 * into the NDJSON format eBay expects for INVENTORY_TASK feeds
 * (matches the PUT /sell/inventory/v1/inventory_item/{sku} shape per row).
 */

import { logger } from '../utils/logger.js';

const EBAY_API_BASE = process.env.EBAY_API_BASE ?? 'https://api.ebay.com';

// ── Public types ───────────────────────────────────────────────────────

export interface EbayFlatRow {
  // Identifiers
  sku: string;
  ebay_item_id?: string;
  ean?: string;
  mpn?: string;
  // Listing
  title?: string;
  condition?: string;
  category_id?: string;
  subtitle?: string;
  // Content
  description?: string;
  // Pricing
  price?: number | string;
  best_offer_enabled?: boolean | string;
  best_offer_floor?: number | string;
  best_offer_ceiling?: number | string;
  // Inventory
  quantity?: number | string;
  handling_time?: number | string;
  // Images
  image_1?: string;
  image_2?: string;
  image_3?: string;
  image_4?: string;
  image_5?: string;
  image_6?: string;
  // Item Specifics
  brand?: string;
  colour?: string;
  size?: string;
  material?: string;
  model_number?: string;
  custom_label?: string;
  // Policies
  fulfillment_policy_id?: string;
  payment_policy_id?: string;
  return_policy_id?: string;
  // Status (read-only in UI)
  listing_status?: string;
  last_pushed_at?: string;
  sync_status?: string;
  // Internal tracking
  _productId?: string;
  _dirty?: boolean;
  _rowId?: string;
  _status?: string;
  _feedMessage?: string;
  // Group info
  platformProductId?: string;
  [key: string]: unknown;
}

export interface FeedTaskStatus {
  status: string;
  completionDate?: string;
  summaryCount?: number;
  failureCount?: number;
}

// ── NDJSON builder ─────────────────────────────────────────────────────

/**
 * Converts flat EbayFlatRow[] into NDJSON for the eBay Inventory Task feed.
 * Each line is a JSON object matching the Inventory API PUT /inventory_item/{sku} body.
 */
export function buildInventoryNdjson(rows: EbayFlatRow[]): string {
  const lines = rows.map((row) => {
    const imageUrls: string[] = [];
    for (let i = 1; i <= 6; i++) {
      const url = row[`image_${i}`] as string | undefined;
      if (url) imageUrls.push(url);
    }

    const aspects: Record<string, string[]> = {};
    if (row.brand) aspects['Brand'] = [row.brand];
    if (row.colour) aspects['Colour'] = [row.colour];
    if (row.size) aspects['Size'] = [row.size];
    if (row.material) aspects['Material'] = [row.material];
    if (row.model_number) aspects['Model Number'] = [row.model_number];
    if (row.custom_label) aspects['Custom Label'] = [row.custom_label];
    if (row.ean) aspects['EAN'] = [row.ean];
    if (row.mpn) aspects['MPN'] = [row.mpn];

    const inventoryItem: Record<string, unknown> = {
      sku: row.sku,
      product: {
        title: row.title ?? row.sku,
        description: row.description ?? '',
        imageUrls,
        aspects,
        ...(row.ean ? { ean: [row.ean] } : {}),
        ...(row.mpn ? { mpn: row.mpn } : {}),
      },
      condition: mapCondition(row.condition),
      availability: {
        shipToLocationAvailability: {
          quantity: Number(row.quantity ?? 0),
        },
      },
    };

    return JSON.stringify(inventoryItem);
  });

  return lines.join('\n');
}

function mapCondition(condition?: string): string {
  const MAP: Record<string, string> = {
    NEW: 'NEW',
    LIKE_NEW: 'LIKE_NEW',
    VERY_GOOD: 'VERY_GOOD',
    GOOD: 'GOOD',
    ACCEPTABLE: 'ACCEPTABLE',
  };
  return MAP[condition?.toUpperCase() ?? ''] ?? 'NEW';
}

// ── Feed API client ────────────────────────────────────────────────────

/**
 * Creates an INVENTORY_TASK feed task on eBay's Sell Feed API.
 * Returns the taskId to use for file upload and status polling.
 */
export async function createInventoryTask(
  marketplace: string,
  token: string,
): Promise<string> {
  const marketplaceId = toMarketplaceId(marketplace);
  const url = `${EBAY_API_BASE}/sell/feed/v1/task`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-EBAY-C-MARKETPLACE-ID': marketplaceId,
    },
    body: JSON.stringify({
      feedType: 'LMS_ACTIVE_INVENTORY_REPORT',
      marketplaceIds: [marketplaceId],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    logger.error('ebay-feed: createInventoryTask failed', { status: res.status, body });
    throw new Error(`eBay createInventoryTask failed: ${res.status} ${body.slice(0, 300)}`);
  }

  // eBay returns 201 with Location header or a body with taskId
  const location = res.headers.get('location') ?? '';
  const taskId = location.split('/').pop();

  if (taskId) return taskId;

  // Fallback: parse body
  const json = await res.json().catch(() => ({})) as Record<string, unknown>;
  const bodyTaskId = json.taskId as string | undefined;
  if (!bodyTaskId) {
    throw new Error('eBay createInventoryTask: could not extract taskId from response');
  }
  return bodyTaskId;
}

/**
 * Uploads the NDJSON feed file to an existing task.
 */
export async function uploadFeedFile(
  taskId: string,
  ndjson: string,
  token: string,
): Promise<void> {
  const url = `${EBAY_API_BASE}/sell/feed/v1/task/${encodeURIComponent(taskId)}/upload_file`;

  const blob = new Blob([ndjson], { type: 'application/json' });

  const formData = new FormData();
  formData.append('file', blob, 'inventory.ndjson');

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
    },
    body: formData,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    logger.error('ebay-feed: uploadFeedFile failed', { taskId, status: res.status, body });
    throw new Error(`eBay uploadFeedFile failed: ${res.status} ${body.slice(0, 300)}`);
  }
}

/**
 * Polls the status of a Sell Feed task.
 */
export async function getTaskStatus(
  taskId: string,
  token: string,
): Promise<FeedTaskStatus> {
  const url = `${EBAY_API_BASE}/sell/feed/v1/task/${encodeURIComponent(taskId)}`;

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    logger.error('ebay-feed: getTaskStatus failed', { taskId, status: res.status, body });
    throw new Error(`eBay getTaskStatus failed: ${res.status} ${body.slice(0, 300)}`);
  }

  const json = await res.json() as Record<string, unknown>;

  return {
    status: (json.status as string) ?? 'UNKNOWN',
    completionDate: json.completionDate as string | undefined,
    summaryCount: (json.uploadSummary as Record<string, unknown> | undefined)?.successCount as number | undefined,
    failureCount: (json.uploadSummary as Record<string, unknown> | undefined)?.failureCount as number | undefined,
  };
}

/**
 * Downloads the result file content for a completed task.
 * Returns the raw text content of the result file.
 */
export async function downloadResultFile(
  taskId: string,
  token: string,
): Promise<string> {
  // First get the task to find resultFileReferenceId
  const statusUrl = `${EBAY_API_BASE}/sell/feed/v1/task/${encodeURIComponent(taskId)}`;

  const statusRes = await fetch(statusUrl, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!statusRes.ok) {
    const body = await statusRes.text().catch(() => '');
    throw new Error(`eBay getTask for result file failed: ${statusRes.status} ${body.slice(0, 300)}`);
  }

  const taskJson = await statusRes.json() as Record<string, unknown>;
  const resultFileId = taskJson.resultFileReferenceId as string | undefined;

  if (!resultFileId) {
    return '';
  }

  const resultUrl = `${EBAY_API_BASE}/sell/feed/v1/task/${encodeURIComponent(taskId)}/download_result_file`;

  const resultRes = await fetch(resultUrl, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!resultRes.ok) {
    const body = await resultRes.text().catch(() => '');
    throw new Error(`eBay downloadResultFile failed: ${resultRes.status} ${body.slice(0, 300)}`);
  }

  return resultRes.text();
}

// ── Helpers ────────────────────────────────────────────────────────────

function toMarketplaceId(marketplace: string): string {
  const MAP: Record<string, string> = {
    IT: 'EBAY_IT',
    DE: 'EBAY_DE',
    FR: 'EBAY_FR',
    ES: 'EBAY_ES',
    UK: 'EBAY_GB',
    GB: 'EBAY_GB',
  };
  const upper = marketplace.toUpperCase();
  return MAP[upper] ?? `EBAY_${upper}`;
}

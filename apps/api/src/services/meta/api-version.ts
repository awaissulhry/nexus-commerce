/**
 * The Meta Graph / Marketing API version Nexus speaks — ONE value for the gateway, the connector and the read client
 * (Meta ads M1, 2026-10-20). Meta ships a Marketing API version about every four months and serves the previous one at
 * least 90 days after a new one ships; an unversioned Marketing API call fails. Checked 2026-10-20 on
 * developers.facebook.com/documentation/ads-commerce/marketing-api/marketing-api-changelog/versions: v26.0 is current
 * (2026-07-29), v24.0 expired 2026-10-06.
 *
 *   META_GRAPH_API_VERSION   env, default v26.0; only the form vNN.N is taken (anything else falls back to the default)
 *
 * The gateway refuses a Meta call to any other version (gateway/meta-calls.ts), so the version moves only here.
 */

export const META_DEFAULT_GRAPH_API_VERSION = 'v26.0'
export const META_GRAPH_HOST = 'graph.facebook.com'

/** The pinned version: META_GRAPH_API_VERSION when it is written vNN.N, else v26.0. */
export function metaGraphApiVersion(): string {
  const value = process.env.META_GRAPH_API_VERSION?.trim()
  return value && /^v\d{2,3}\.\d$/.test(value) ? value : META_DEFAULT_GRAPH_API_VERSION
}

/** `https://graph.facebook.com/<version>` — every Meta call Nexus makes starts here. */
export function metaGraphBase(): string {
  return `https://${META_GRAPH_HOST}/${metaGraphApiVersion()}`
}

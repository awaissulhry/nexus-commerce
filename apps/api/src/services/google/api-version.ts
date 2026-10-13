/**
 * The Google Ads API version Nexus speaks — one value for the gateway, the connector's discovery and the
 * read client. Google ships a major version about every quarter and sunsets each one about a year later;
 * moving it is a change to this line plus the field names the release notes rename.
 */
export const GOOGLE_ADS_API_VERSION = 'v25'
export const GOOGLE_ADS_API_BASE = `https://googleads.googleapis.com/${GOOGLE_ADS_API_VERSION}`

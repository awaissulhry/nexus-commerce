/**
 * Returns the backend API base URL, always with an https:// protocol.
 *
 * NEXT_PUBLIC_API_URL is sometimes set on Vercel without the protocol prefix
 * (e.g. "nexusapi-production-b7bb.up.railway.app" instead of
 * "https://nexusapi-production-b7bb.up.railway.app"), which causes fetch()
 * to throw "Failed to parse URL". This function normalises the value so
 * every fetch in the app is safe regardless of how the env var is written.
 */
export declare function getBackendUrl(): string;

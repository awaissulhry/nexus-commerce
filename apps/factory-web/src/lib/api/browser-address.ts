/**
 * A stored file's presigned address as the browser opens it (end check, B-TH-017 / B-TH-063). The API answers R2's
 * addresses absolute, and the local store's (FAKE: local and test only) as a path on the API, `/local-files?token=…`.
 * A page on this app reaches the API through its own `/api` proxy, so a path gets that prefix; an absolute address,
 * or a protocol-relative one, is used as it is. The same rule the export and document downloads already apply.
 */
export function browserAddress(url: string): string {
  return url.startsWith('/') && !url.startsWith('//') ? `/api${url}` : url
}

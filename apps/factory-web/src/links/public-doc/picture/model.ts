/**
 * The public DoC page's picture (B-W2b-236, SY3:03): the style's main picture, served by the API only as its copy stripped of
 * camera and location data (`GET /public/doc/<code>/picture/<file id>`, a permanent address of that picture: a new main
 * picture is a new address), never the office's file.
 */
export function publicDocPictureUrl(code: string, fileId: string): string {
  return `/api/public/doc/${encodeURIComponent(code)}/picture/${encodeURIComponent(fileId)}`
}

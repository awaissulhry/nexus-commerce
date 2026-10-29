import { floorIconSvg } from '../../../../floor/install'

/** The floor app's icon: a placeholder drawn from the DS brand colour until the Owner's own mark exists. */
export function GET() {
  return new Response(floorIconSvg(), { headers: { 'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': 'public, max-age=86400' } })
}

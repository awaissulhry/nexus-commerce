import { z } from 'zod'
import type { PictureSource } from './model'

/**
 * owb-ss7 (S3; the server Shape `Picture` of owb-ss5: `{ kind: 'LETTERS' | 'ICON'; icon; colour; letters }`) — a team's, a unit's or a
 * person's picture as the API sends it, checked (zod), and turned into what PeoplePicture / TeamChip draw. Letters · 12 icons · 10
 * tones; no photo (Owner decision K). An unknown kind reads as letters, an unknown icon or colour falls back in the model (letters,
 * slate): a new value on the server never breaks a screen. The Teams page, the order's Team part, Give to a team…, the Factory
 * structure and the Order structures all read it from here (one shape, one reader).
 */
export const pictureSchema = z.object({
  kind: z.enum(['LETTERS', 'ICON']).catch('LETTERS'),
  icon: z.string().nullable().catch(null),
  colour: z.string().nullable().catch(null),
  letters: z.string().catch(''),
})
export type ApiPicture = z.infer<typeof pictureSchema>

/** What the picture parts draw for a name and its API picture (absent: the name's letters on slate). */
export function sourceOfPicture(name: string, picture: ApiPicture | null | undefined, who: 'person' | 'team'): PictureSource & { readonly name: string } {
  return picture ? { name, who, kind: picture.kind, icon: picture.icon, colour: picture.colour, letters: picture.letters } : { name, who }
}

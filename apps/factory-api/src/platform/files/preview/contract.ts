import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'

/**
 * The preview's contract (COL-047; B-W2b-160): a presigned GET that lives 60 seconds. `inline`: a picture or a PDF the
 * browser shows in place (open the URL in a new tab or an <img>/<iframe>); `download`: any other kind, as an attachment.
 */
export const previewContract = defineContract({
  params: input({ fileId: id() }),
  response: {
    200: output({
      preview: output({
        mode: z.enum(['inline', 'download']),
        method: z.literal('GET'),
        url: z.string(),
        headers: z.record(z.string(), z.string()),
        expiresAt: instant(),
      }),
    }),
  },
})

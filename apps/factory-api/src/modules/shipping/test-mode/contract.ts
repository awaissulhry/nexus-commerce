import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { TEST_MODE_REFUSALS } from '@nexus/factory-domain/shipping/test-mode/rules'

/**
 * Test carrier mode per site (B-W2b-390; LOG-035; design warehouse.shipping "Test mode", pop-up "Switch to live labels"). No
 * money. `liveSetById` is the person who switched the site live, inside the site's own settings (the screens name them).
 */

export const testModeSiteSchema = output({
  siteId: id(),
  companyId: id(),
  code: z.string(),
  name: z.string(),
  /** The site has shipping settings (without them it is in test mode and cannot go live). */
  hasSettings: z.boolean(),
  /** The settings' version (the switch's edit-conflict guard); null without settings. */
  version: z.number().int().nullable(),
  testMode: z.boolean(),
  liveSince: instant().nullable(),
  liveSetById: id().nullable(),
  /** What the mode does, in words (TEST_MODE_WORDS). */
  words: z.string(),
  goLive: output({
    /** It may switch to live labels now. */
    ready: z.boolean(),
    refusal: output({ code: z.enum(TEST_MODE_REFUSALS), message: z.string() }).nullable(),
    /** The words of the confirmation: labels are bought and charged from then on. */
    warning: z.string(),
    /** TEST labels of the site's shipments that have not left, cleared by the switch (labelled again, live). */
    testLabelsToClear: z.number().int(),
  }),
})

export const getTestModesContract = defineContract({
  querystring: input({ companyId: id().optional(), siteId: id().optional() }),
  response: { 200: output({ sites: z.array(testModeSiteSchema), anyInTestMode: z.boolean() }) },
})

export const switchTestModeContract = defineContract({
  params: input({ siteId: id() }),
  /** testMode false = Switch to live labels (a fresh step-up); true = back to test mode. `version`: the settings' version. */
  body: input({ testMode: z.boolean(), version: z.number().int().min(1).optional() }),
  response: { 200: output({ site: testModeSiteSchema, clearedTestLabels: z.number().int() }) },
})

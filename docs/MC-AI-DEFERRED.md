# Marketing Content (MC-series) — AI integration deferrals

**Status:** AI integration work deferred per operator request 2026-05-10. UI shells are still built in their respective waves; this file tracks what needs to be wired when AI work resumes.

## Scope of deferrals

The `/marketing/content` engagement is approved as 76 commits across 14 waves. Five waves contain AI integration work that is being held:

| Wave | Commits affected | UI built? | What's deferred |
|---|---|---|---|
| MC.4 — AI Image Studio | 8 commits | YES (shell + modals + buttons) | All provider integrations + cost tracking |
| MC.5 — AI Image Generation | 5 commits | YES (text-to-image UI, brand-kit constraints UI) | DALL-E / Stable Diffusion / Imagen calls |
| MC.7.4–7.5 — Video AI | 2 commits | YES (caption editor, language picker) | Whisper / Gemini caption + translation calls |
| MC.8.6 — A+ Content multi-locale | 1 commit | YES (per-locale tabs with translate button) | Auto-translate via Gemini |
| MC.11 — Templates & Automation | 6 commits | YES (visual rule builder, rule list, history) | AI-driven rule actions (auto-alt, auto-tag, auto-resize via AI) |

Total: 22 of 76 commits affected. UI for all of them ships; AI execution is stubbed with toasts.

## Stub pattern

Every AI button/action in deferred waves shows a toast on click:

```ts
toast({
  title: t('marketingContent.ai.deferredTitle'),
  description: t('marketingContent.ai.deferredBody'),
  tone: 'info',
})
```

The toast strings explain the feature is queued. Backend endpoints, when present, return 503 with a clear "AI integration not yet wired" body so a rogue caller doesn't get silent zeros.

## Wave-by-wave plan when AI work resumes

### MC.4 — AI Image Studio CORNERSTONE

Each commit lands provider integration + cost tracking. Cost ceiling per asset $1, per day $100, hard-stop with operator override.

- **MC.4.1** — Provider config: Stability API key, Replicate API key, Cloudinary AI key, Remove.bg key. Settings live under `/settings/ai-providers`. Each provider has a status indicator (configured / unconfigured / rate-limited / over-budget).
- **MC.4.2** — Background removal: Cloudinary `e_background_removal` transformation, Remove.bg fallback. POST `/api/assets/:id/process/remove-background` → ImageProcessingJob row → async job runs transform → updates DigitalAsset url + creates AssetVersion. Cost: $0.02/image (Remove.bg), free (Cloudinary in plan tier).
- **MC.4.3** — Smart crop per channel: Cloudinary `c_crop,g_auto` for 7 channel variants. POST `/api/assets/:id/process/smart-crop` returns 7 child assets. Free with Cloudinary plan.
- **MC.4.4** — Auto-tagging: Cloudinary `categorization=google_tagging` or AWS Rekognition. Tags piped into DigitalAsset.metadata.tags. Cost: ~$0.001-0.005/image.
- **MC.4.5** — Auto-alt-text generation (multilingual): Gemini Vision multimodal call with image URL → "Describe this product image for a motorcycle gear catalog in {locale}". Pulls TerminologyPreference glossary into prompt (extends existing pattern). Cost: ~$0.0005/image (Gemini Flash).
- **MC.4.6** — Object detection + color extraction: Cloudinary `colors=true` + Rekognition labels. Used to power similar-image search (MC.4.6 follow-up).
- **MC.4.7** — Upscaling: Stability AI `image-to-image` upscale endpoint or Replicate Real-ESRGAN. 2x/4x/8x with progress. Cost: $0.05–0.15/image.
- **MC.4.8** — AI cost tracking extension: extend existing AIUsageLog model with `imageOperationType` + `assetId` columns. Per-asset, per-provider, per-day rollups. Hard ceiling enforcement before queueing the job.

### MC.5 — AI Image Generation

- **MC.5.1** — Text-to-image: provider switcher (DALL-E 3, Stable Diffusion via Replicate, Imagen). Generation modal with prompt + negative prompt + style preset (photographic, lifestyle, product-on-white). Cost varies $0.04–0.20/image.
- **MC.5.2** — Variant generation (color swap): SDXL with ControlNet edge detection — preserves silhouette while swapping fabric color. Uses existing master image as reference.
- **MC.5.3** — Lifestyle scene generation: Multi-step pipeline — extract product (background removal) → composite onto generated scene (SDXL inpainting). Slower (~20s) but visible value for motorcycle gear marketing.
- **MC.5.4** — Brand kit constraints: pre-prompt injection of brand colors + logo placement rules. Reuses BrandKit model from MC.10.
- **MC.5.5** — Generation audit log: every generation persists prompt, provider, model, cost, output URL, accepted/rejected. Operator can re-run with same prompt.

### MC.7.4–7.5 — Video AI

- **MC.7.4** — AI captions/subtitles: Whisper via Replicate or OpenAI directly. Output WebVTT, attached as VideoCaption rows. Cost: $0.006/minute.
- **MC.7.5** — AI translations/dubbing: Gemini for caption translation; voice cloning (ElevenLabs / RVC) for dubbing in IT/DE/UK/FR/ES. Dubbing is expensive (~$0.30/minute) — gate behind explicit operator opt-in per video.

### MC.8.6 — A+ Content per-marketplace localization

- AI translate from IT master to DE/UK/FR/ES. Pulls TerminologyPreference glossary. Per-module translate button + bulk "translate all modules" with cost preview. Cost: ~$0.001–0.003 per A+ module per locale.

### MC.11 — Templates & Automation rule actions

- **AI rule actions**: 6 rule action types use AI (auto-alt-text, auto-tag, auto-translate-caption, auto-bg-removal, auto-resize-via-ai, auto-watermark-via-ai). Each action calls into MC.4 endpoints; rule executor enforces global daily budget cap before running.
- **Visual rule builder UI** ships with full action picker (including AI actions); the actions just won't fire until MC.4 is complete.

## Cost-control gates required when AI lands

- **Per-asset ceiling:** $1 default, configurable in settings.
- **Per-day ceiling:** $100 default, configurable.
- **Hard stop:** when ceiling hit, queue is paused — operator sees a banner and can raise the ceiling or wait until next day.
- **Provider fallback chain:** primary → secondary → none (with toast). Configurable per operation type.
- **Sensitive-data redaction:** never send customer-facing review text or order data through AI providers.
- **Rate-limit handling:** exponential backoff, max 3 retries, then mark job failed with operator notification.
- **Failsafe emergency disable:** single env flag `AI_PROCESSING_DISABLED=true` halts all AI operations.

## Schema changes deferred with the AI work

```prisma
model ImageProcessingJob {
  id              String   @id @default(cuid())
  assetId         String   // links to DigitalAsset.id (or "pi_<id>" placeholder)
  asset           DigitalAsset? @relation(fields: [assetId], references: [id])
  operationType   String   // 'remove_background' | 'upscale' | 'smart_crop' | 'auto_tag' | 'auto_alt' | 'generate' | ...
  provider        String   // 'cloudinary' | 'stability' | 'replicate' | 'gemini' | ...
  model           String?
  status          String   // 'queued' | 'running' | 'completed' | 'failed'
  costCents       Int      @default(0)
  inputParams     Json?
  outputAssetIds  String[] @default([])
  errorMessage    String?
  startedAt       DateTime?
  completedAt     DateTime?
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
  @@index([assetId])
  @@index([status, createdAt])
}

model AIGeneratedAsset {
  id              String   @id @default(cuid())
  assetId         String   @unique
  asset           DigitalAsset @relation(fields: [assetId], references: [id], onDelete: Cascade)
  prompt          String
  negativePrompt  String?
  provider        String
  model           String
  costCents       Int
  approvedBy      String?
  approvedAt      DateTime?
  createdAt       DateTime @default(now())
}

// Extension to existing AIUsageLog (W4.5 model):
//   - imageOperationType String?
//   - assetId            String?  (FK to DigitalAsset)
```

## Open questions when AI work resumes

1. Do we use Cloudinary's bundled AI (Plus plan) for background removal, or pay per-call Remove.bg / Stability? Cloudinary is cheaper at scale but locks us in.
2. Whisper via Replicate vs direct OpenAI for captions — direct is cheaper but adds another API key + billing surface.
3. Per-marketplace A+ Content translation — should we cache translations or regenerate on every "Translate" click? Cache hit rate likely high; freshness rarely matters for product copy.
4. Storage tier for AI-generated assets — same as master, or separate "drafts" bucket that gets cleaned up if not approved within N days?

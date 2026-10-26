/**
 * Meta ads step 10 — the fixed lists Meta's media reads name, in ONE place for the reads (marketing/meta-ads/live-media.ts)
 * and the gateway (gateway/meta-calls.ts), which lets the organic-insight and preview query keys travel only on a read
 * that names these and nothing else (round 2, item c).
 *
 * Checked 2026-10-21: pages-api/platforminsights/page.md and …/deprecated-metrics.md (Page and post metrics: the ones Meta
 * names as the alternatives, and the rest not on its deprecated list), instagram-graph-api reference ig-media/insights and
 * ig-user/insights (metric tables), marketing-api reference ad-account/generatepreviews and ad-creative/previews
 * (`ad_format` enum, v26.0) and Meta's Python Business SDK.
 */

/** Page metrics Meta has not deprecated. */
export const PAGE_METRICS = [
  'page_media_view', 'page_total_media_view_unique', 'page_post_engagements', 'page_follows', 'page_daily_follows', 'page_daily_follows_unique',
  'page_daily_unfollows_unique', 'page_follows_city', 'page_follows_country', 'page_views_total', 'page_total_actions',
  'page_actions_post_reactions_total', 'page_video_views', 'page_video_views_paid', 'page_video_views_organic', 'page_video_complete_views_30s',
] as const
/** Page-post metrics Meta has not deprecated. */
export const POST_METRICS = [
  'post_media_view', 'post_total_media_view_unique', 'post_clicks', 'post_clicks_by_type', 'post_reactions_by_type_total', 'post_reactions_like_total',
  'post_reactions_love_total', 'post_reactions_wow_total', 'post_reactions_haha_total', 'post_reactions_sorry_total', 'post_reactions_anger_total',
  'post_video_views', 'post_video_avg_time_watched', 'post_video_complete_views_30s_unique',
] as const
/** Page and post insights `period` (pages-api/platforminsights/page.md); moved here from live-media.ts for the gateway's Page-token list. */
export const PAGE_PERIODS = ['day', 'week', 'days_28', 'month', 'lifetime', 'total_over_range'] as const
/** The breakdowns Meta's deprecation page names for the media-view metrics (moved here from live-media.ts, as above). */
export const PAGE_BREAKDOWNS = ['is_from_ads', 'is_from_followers'] as const
/** ig-media/insights metrics (impressions: deprecated for media made after 2024-07-02, not offered). */
export const IG_MEDIA_METRICS = [
  'views', 'reach', 'likes', 'comments', 'saved', 'shares', 'reposts', 'total_interactions', 'follows', 'profile_visits', 'profile_activity',
  'navigation', 'replies', 'link_clicks', 'ig_reels_avg_watch_time', 'ig_reels_video_view_total_time', 'reels_skip_rate', 'facebook_views',
  'crossposted_views', 'total_views', 'total_likes', 'total_comments',
] as const
/** ig-user/insights metrics (impressions: deprecated since v22, not offered). */
export const IG_ACCOUNT_METRICS = [
  'reach', 'views', 'accounts_engaged', 'total_interactions', 'likes', 'comments', 'saves', 'shares', 'reposts', 'replies', 'follows_and_unfollows',
  'profile_links_taps', 'follower_demographics', 'engaged_audience_demographics',
] as const

/** Every organic metric a Nexus read names: the gateway lets `metric` (and its period and range) go only with these. */
export const META_ORGANIC_METRICS: ReadonlySet<string> = new Set<string>([...PAGE_METRICS, ...POST_METRICS, ...IG_MEDIA_METRICS, ...IG_ACCOUNT_METRICS])

/**
 * ad_format: the generatepreviews / previews reference enum (v26.0) and SDK, exactly (THREADS_STREAM, which only the Instagram
 * preview guide names, is not offered). Some name placements Meta has retired (MESSENGER_MOBILE_STORY_MEDIA,
 * INSTANT_ARTICLE_*): Meta refuses them, and the answer says so for that placement.
 */
export const AD_FORMATS = [
  'AUDIENCE_NETWORK_INSTREAM_VIDEO', 'AUDIENCE_NETWORK_INSTREAM_VIDEO_MOBILE', 'AUDIENCE_NETWORK_OUTSTREAM_VIDEO', 'AUDIENCE_NETWORK_REWARDED_VIDEO',
  'BIZ_DISCO_FEED_MOBILE', 'DESKTOP_FEED_STANDARD', 'FACEBOOK_IFU_REELS_MOBILE', 'FACEBOOK_PROFILE_FEED_DESKTOP', 'FACEBOOK_PROFILE_FEED_MOBILE',
  'FACEBOOK_PROFILE_REELS_MOBILE', 'FACEBOOK_REELS_BANNER', 'FACEBOOK_REELS_BANNER_DESKTOP', 'FACEBOOK_REELS_BANNER_FEED_ANDROID',
  'FACEBOOK_REELS_BANNER_FEED_ANDROID_LARGE', 'FACEBOOK_REELS_BANNER_FULLSCREEN_IOS', 'FACEBOOK_REELS_BANNER_FULLSCREEN_MOBILE', 'FACEBOOK_REELS_MOBILE',
  'FACEBOOK_REELS_POSTLOOP', 'FACEBOOK_REELS_POSTLOOP_FEED', 'FACEBOOK_REELS_SIMILAR_PRODUCTS_MOBILE', 'FACEBOOK_REELS_STICKER', 'FACEBOOK_STORY_MOBILE',
  'FACEBOOK_STORY_STICKER_MOBILE', 'INSTAGRAM_EXPLORE_CONTEXTUAL', 'INSTAGRAM_EXPLORE_GRID_HOME', 'INSTAGRAM_EXPLORE_IMMERSIVE', 'INSTAGRAM_FEED_WEB',
  'INSTAGRAM_FEED_WEB_M_SITE', 'INSTAGRAM_LEAD_GEN_MULTI_SUBMIT_ADS', 'INSTAGRAM_PROFILE_FEED', 'INSTAGRAM_PROFILE_REELS', 'INSTAGRAM_REELS',
  'INSTAGRAM_REELS_OVERLAY', 'INSTAGRAM_REELS_WEB', 'INSTAGRAM_REELS_WEB_M_SITE', 'INSTAGRAM_SEARCH_CHAIN', 'INSTAGRAM_SEARCH_GRID', 'INSTAGRAM_STANDARD',
  'INSTAGRAM_STORY', 'INSTAGRAM_STORY_EFFECT_TRAY', 'INSTAGRAM_STORY_WEB', 'INSTAGRAM_STORY_WEB_M_SITE', 'INSTANT_ARTICLE_RECIRCULATION_AD',
  'INSTANT_ARTICLE_STANDARD', 'INSTREAM_BANNER_DESKTOP', 'INSTREAM_BANNER_FEED_IOS', 'INSTREAM_BANNER_FULLSCREEN_IOS', 'INSTREAM_BANNER_FULLSCREEN_MOBILE',
  'INSTREAM_BANNER_IMMERSIVE_MOBILE', 'INSTREAM_BANNER_MOBILE', 'INSTREAM_VIDEO_DESKTOP', 'INSTREAM_VIDEO_FULLSCREEN_IOS', 'INSTREAM_VIDEO_FULLSCREEN_MOBILE',
  'INSTREAM_VIDEO_IMAGE', 'INSTREAM_VIDEO_IMMERSIVE_MOBILE', 'INSTREAM_VIDEO_MOBILE', 'JOB_BROWSER_DESKTOP', 'JOB_BROWSER_MOBILE', 'MARKETPLACE_MOBILE',
  'MESSENGER_MOBILE_INBOX_MEDIA', 'MESSENGER_MOBILE_STORY_MEDIA', 'MOBILE_BANNER', 'MOBILE_FEED_BASIC', 'MOBILE_FEED_STANDARD', 'MOBILE_FULLWIDTH',
  'MOBILE_INTERSTITIAL', 'MOBILE_MEDIUM_RECTANGLE', 'MOBILE_NATIVE', 'RIGHT_COLUMN_STANDARD', 'SUGGESTED_VIDEO_DESKTOP', 'SUGGESTED_VIDEO_FULLSCREEN_MOBILE',
  'SUGGESTED_VIDEO_IMMERSIVE_MOBILE', 'SUGGESTED_VIDEO_MOBILE', 'WATCH_FEED_HOME', 'WATCH_FEED_MOBILE', 'WHATSAPP_STATUS_MEDIA',
] as const
/** The gateway lets the preview keys go only on a read naming one of these. */
export const META_AD_FORMATS: ReadonlySet<string> = new Set<string>(AD_FORMATS)

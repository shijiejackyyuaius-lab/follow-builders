#!/usr/bin/env node

// ============================================================================
// Follow Builders — Central Feed Generator
// ============================================================================
// Runs on GitHub Actions (every 6h for tweets, every 24h for podcasts) to
// fetch content and publish feed-x.json and feed-podcasts.json.
//
// Deduplication: tracks previously seen tweet IDs and video IDs in
// state-feed.json so content is never repeated across runs.
//
// Usage: node generate-feed.js [--tweets-only | --podcasts-only]
// Env vars needed: X_BEARER_TOKEN, SUPADATA_API_KEY
// ============================================================================

import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';

// -- Constants ---------------------------------------------------------------

const SUPADATA_BASE = 'https://api.supadata.ai/v1';
const X_API_BASE = 'https://api.x.com/2';
const TWEET_LOOKBACK_HOURS = 24;
const PODCAST_LOOKBACK_HOURS = 72;
const MAX_TWEETS_PER_USER = 3;

// State file lives in the repo root so it gets committed by GitHub Actions
const SCRIPT_DIR = decodeURIComponent(new URL('.', import.meta.url).pathname);
const STATE_PATH = join(SCRIPT_DIR, '..', 'state-feed.json');

// -- State Management --------------------------------------------------------

// Tracks which tweet IDs and video IDs we've already included in feeds
// so we never send the same content twice across runs.

async function loadState() {
  if (!existsSync(STATE_PATH)) {
    return { seenTweets: {}, seenVideos: {} };
  }
  try {
    return JSON.parse(await readFile(STATE_PATH, 'utf-8'));
  } catch {
    return { seenTweets: {}, seenVideos: {} };
  }
}

async function saveState(state) {
  // Prune entries older than 7 days to prevent the file from growing forever
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  for (const [id, ts] of Object.entries(state.seenTweets)) {
    if (ts < cutoff) delete state.seenTweets[id];
  }
  for (const [id, ts] of Object.entries(state.seenVideos)) {
    if (ts < cutoff) delete state.seenVideos[id];
  }
  await writeFile(STATE_PATH, JSON.stringify(state, null, 2));
}

// -- Load Sources ------------------------------------------------------------

async function loadSources() {
  const sourcesPath = join(SCRIPT_DIR, '..', 'config', 'default-sources.json');
  return JSON.parse(await readFile(sourcesPath, 'utf-8'));
}

// -- YouTube Fetching (Supadata API) -----------------------------------------

async function fetchYouTubeContent(podcasts, apiKey, state, errors) {
  const cutoff = new Date(Date.now() - PODCAST_LOOKBACK_HOURS * 60 * 60 * 1000);
  const allCandidates = [];

  for (const podcast of podcasts) {
    try {
      let videosUrl;
      if (podcast.type === 'youtube_playlist') {
        videosUrl = `${SUPADATA_BASE}/youtube/playlist/videos?id=${podcast.playlistId}`;
      } else {
        videosUrl = `${SUPADATA_BASE}/youtube/channel/videos?id=${podcast.channelHandle}&type=video`;
      }

      const videosRes = await fetch(videosUrl, {
        headers: { 'x-api-key': apiKey }
      });

      if (!videosRes.ok) {
        errors.push(`YouTube: Failed to fetch videos for ${podcast.name}: HTTP ${videosRes.status}`);
        continue;
      }

      const videosData = await videosRes.json();
      const videoIds = videosData.videoIds || videosData.video_ids || [];

      // Check first 2 videos per channel, skip already-seen ones
      for (const videoId of videoIds.slice(0, 2)) {
        if (state.seenVideos[videoId]) continue; // dedup

        try {
          const metaRes = await fetch(
            `${SUPADATA_BASE}/youtube/video?id=${videoId}`,
            { headers: { 'x-api-key': apiKey } }
          );
          if (!metaRes.ok) continue;
          const meta = await metaRes.json();
          const publishedAt = meta.uploadDate || meta.publishedAt || meta.date || null;

          allCandidates.push({
            podcast, videoId,
            title: meta.title || 'Untitled',
            publishedAt
          });
          await new Promise(r => setTimeout(r, 300));
        } catch (err) {
          errors.push(`YouTube: Error fetching metadata for ${videoId}: ${err.message}`);
        }
      }
    } catch (err) {
      errors.push(`YouTube: Error processing ${podcast.name}: ${err.message}`);
    }
  }

  // Pick 1 unseen video from the last 72 hours.
  // Sort OLDEST first so videos are featured in chronological order —
  // if 3 videos were published in 72h, day 1 gets the oldest, day 2 the
  // next, day 3 the newest. Dedup ensures each is featured exactly once.
  const withinWindow = allCandidates
    .filter(v => v.publishedAt && new Date(v.publishedAt) >= cutoff)
    .sort((a, b) => new Date(a.publishedAt) - new Date(b.publishedAt)); // oldest first

  const selected = withinWindow[0]; // oldest unseen video
  if (!selected) return [];

  // Fetch transcript
  try {
    const videoUrl = `https://www.youtube.com/watch?v=${selected.videoId}`;
    const transcriptRes = await fetch(
      `${SUPADATA_BASE}/youtube/transcript?url=${encodeURIComponent(videoUrl)}&text=true`,
      { headers: { 'x-api-key': apiKey } }
    );

    if (!transcriptRes.ok) {
      errors.push(`YouTube: Failed to get transcript for ${selected.videoId}: HTTP ${transcriptRes.status}`);
      return [];
    }

    const transcriptData = await transcriptRes.json();

    // Mark as seen
    state.seenVideos[selected.videoId] = Date.now();

    return [{
      source: 'podcast',
      name: selected.podcast.name,
      title: selected.title,
      videoId: selected.videoId,
      url: `https://youtube.com/watch?v=${selected.videoId}`,
      publishedAt: selected.publishedAt,
      transcript: transcriptData.content || ''
    }];
  } catch (err) {
    errors.push(`YouTube: Error fetching transcript for ${selected.videoId}: ${err.message}`);
    return [];
  }
}

// -- X/Twitter Fetching (Apify tweet-scraper) --------------------------------

async function fetchXContent(xAccounts, apifyToken, state, errors, cookies = {}) {
  const results = [];
  const cutoff = new Date(Date.now() - TWEET_LOOKBACK_HOURS * 60 * 60 * 1000);

  // Start Apify run — scrape all profile pages in one batch
  const startUrls = xAccounts.map(a => ({ url: `https://x.com/${a.handle}` }));

  let runId;
  try {
    const runRes = await fetch(
      `https://api.apify.com/v2/acts/apidojo~tweet-scraper/runs?token=${apifyToken}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          startUrls,
          maxItems: xAccounts.length * 5,
          sort: 'Latest',
          includeSearchTerms: false,
          onlyImage: false,
          onlyQuote: false,
          onlyVideo: false,
          ...(cookies.auth_token && {
            cookies: [
              { name: 'auth_token', value: cookies.auth_token, domain: '.x.com' },
              { name: 'ct0', value: cookies.ct0, domain: '.x.com' }
            ]
          })
        })
      }
    );

    if (!runRes.ok) {
      const body = await runRes.text();
      errors.push(`Apify: Failed to start run: HTTP ${runRes.status} — ${body}`);
      return results;
    }

    const runData = await runRes.json();
    runId = runData.data?.id;
    if (!runId) {
      errors.push(`Apify: No run ID returned. Response: ${JSON.stringify(runData).slice(0, 200)}`);
      return results;
    }
    console.error(`  Apify run started: ${runId}`);
  } catch (err) {
    errors.push(`Apify: Error starting run: ${err.message}`);
    return results;
  }

  // Poll until the run finishes (max 5 min)
  let status = 'RUNNING';
  const deadline = Date.now() + 5 * 60 * 1000;
  while ((status === 'RUNNING' || status === 'READY') && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 6000));
    try {
      const statusRes = await fetch(
        `https://api.apify.com/v2/actor-runs/${runId}?token=${apifyToken}`
      );
      const statusData = await statusRes.json();
      status = statusData.data?.status || 'FAILED';
    console.error(`  Apify run status: ${status}`);
    } catch (err) {
      errors.push(`Apify: Error polling run status: ${err.message}`);
      break;
    }
  }

  if (status !== 'SUCCEEDED') {
    errors.push(`Apify: Run ended with status ${status}`);
    return results;
  }

  // Fetch scraped items
  let items = [];
  try {
    const itemsRes = await fetch(
      `https://api.apify.com/v2/actor-runs/${runId}/dataset/items?token=${apifyToken}`
    );
    if (!itemsRes.ok) {
      errors.push(`Apify: Failed to fetch dataset: HTTP ${itemsRes.status}`);
      return results;
    }
    items = await itemsRes.json();
    console.error(`  Apify dataset: ${items.length} items`);
    if (items.length > 0) console.error(`  Sample item keys: ${Object.keys(items[0]).join(', ')}`);
  } catch (err) {
    errors.push(`Apify: Error fetching dataset: ${err.message}`);
    return results;
  }

  // Group tweets by author handle
  const byHandle = {};
  for (const tweet of items) {
    const handle = (tweet.author?.userName || tweet.author?.username || '').toLowerCase();
    if (!handle) continue;
    if (!byHandle[handle]) byHandle[handle] = [];
    byHandle[handle].push(tweet);
  }

  // Process each account
  for (const account of xAccounts) {
    const tweets = byHandle[account.handle.toLowerCase()] || [];
    const newTweets = [];

    for (const t of tweets) {
      if (state.seenTweets[t.id]) continue;
      if (t.isRetweet || t.isReply) continue;
      const createdAt = new Date(t.createdAt || t.created_at);
      if (createdAt < cutoff) continue;
      if (newTweets.length >= MAX_TWEETS_PER_USER) break;

      newTweets.push({
        id: t.id,
        text: t.fullText || t.text || '',
        createdAt: t.createdAt || t.created_at,
        url: t.url || `https://x.com/${account.handle}/status/${t.id}`,
        likes: t.likeCount || t.favoriteCount || 0,
        retweets: t.retweetCount || 0,
        replies: t.replyCount || 0,
        isQuote: t.isQuote || false,
        quotedTweetId: t.quotedTweet?.id || null
      });

      state.seenTweets[t.id] = Date.now();
    }

    if (newTweets.length === 0) continue;

    results.push({
      source: 'x',
      name: account.name,
      handle: account.handle,
      bio: tweets[0]?.author?.description || '',
      tweets: newTweets
    });
  }

  return results;
}

// -- Main --------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const tweetsOnly = args.includes('--tweets-only');
  const podcastsOnly = args.includes('--podcasts-only');

  const apifyToken = process.env.APIFY_TOKEN;
  const supadataKey = process.env.SUPADATA_API_KEY;
  const xCookies = {
    auth_token: process.env.X_AUTH_TOKEN,
    ct0: process.env.X_CT0
  };

  if (!tweetsOnly && !supadataKey) {
    console.error('SUPADATA_API_KEY not set');
    process.exit(1);
  }
  if (!podcastsOnly && !apifyToken) {
    console.error('APIFY_TOKEN not set');
    process.exit(1);
  }

  const sources = await loadSources();
  const state = await loadState();
  const errors = [];

  // Fetch tweets (unless --podcasts-only)
  let xContent = [];
  if (!podcastsOnly) {
    console.error('Fetching X/Twitter content...');
    xContent = await fetchXContent(sources.x_accounts, apifyToken, state, errors, xCookies);
    console.error(`  Found ${xContent.length} builders with new tweets`);

    const totalTweets = xContent.reduce((sum, a) => sum + a.tweets.length, 0);
    const xFeed = {
      generatedAt: new Date().toISOString(),
      lookbackHours: TWEET_LOOKBACK_HOURS,
      x: xContent,
      stats: { xBuilders: xContent.length, totalTweets },
      errors: errors.filter(e => e.startsWith('X API')).length > 0
        ? errors.filter(e => e.startsWith('X API')) : undefined
    };
    await writeFile(join(SCRIPT_DIR, '..', 'feed-x.json'), JSON.stringify(xFeed, null, 2));
    console.error(`  feed-x.json: ${xContent.length} builders, ${totalTweets} tweets`);
  }

  // Fetch podcasts (unless --tweets-only)
  let podcasts = [];
  if (!tweetsOnly) {
    console.error('Fetching YouTube content...');
    podcasts = await fetchYouTubeContent(sources.podcasts, supadataKey, state, errors);
    console.error(`  Found ${podcasts.length} new episodes`);

    const podcastFeed = {
      generatedAt: new Date().toISOString(),
      lookbackHours: PODCAST_LOOKBACK_HOURS,
      podcasts,
      stats: { podcastEpisodes: podcasts.length },
      errors: errors.filter(e => e.startsWith('YouTube')).length > 0
        ? errors.filter(e => e.startsWith('YouTube')) : undefined
    };
    await writeFile(join(SCRIPT_DIR, '..', 'feed-podcasts.json'), JSON.stringify(podcastFeed, null, 2));
    console.error(`  feed-podcasts.json: ${podcasts.length} episodes`);
  }

  // Save dedup state
  await saveState(state);

  if (errors.length > 0) {
    console.error(`  ${errors.length} non-fatal errors`);
  }
}

main().catch(err => {
  console.error('Feed generation failed:', err.message);
  process.exit(1);
});

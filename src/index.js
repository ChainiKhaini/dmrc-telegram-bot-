/**
 * Main Cloudflare Worker for DMRC Service Update Telegram Bot
 * Entrypoint for Cron Triggers (scheduled) and HTTP Requests (fetch)
 *
 * Monitors @OfficialDMRC tweets via SocialData API, classifies them
 * using Cloudflare Workers AI, and sends service update notifications
 * to Telegram.
 */

import { fetchRecentTweets } from "./twitter.js";
import { analyzeTweetText, analyzeNoticeImage } from "./analyzer.js";
import { formatAdvisoryMessage } from "./formatter.js";
import { sendTelegramNotification } from "./telegram.js";
import { renderDashboardHtml } from "./dashboard.js";

export default {
  /**
   * Cron Trigger Handler
   * Runs every 15 minutes during 6 AM – 11:45 PM IST
   */
  async scheduled(event, env, ctx) {
    console.log(`Cron trigger executed at ${new Date().toISOString()} (Cron: ${event.cron})`);
    ctx.waitUntil(runServiceUpdatePipeline(env));
  },

  /**
   * HTTP Request Handler
   * Serves dashboard, health, stats, and manual trigger endpoints
   */
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Root Endpoint / Dashboard: Serve rich HTML dashboard
    if ((url.pathname === "/" || url.pathname === "/dashboard") && request.method === "GET") {
      const stats = await getKVStats(env);
      const html = renderDashboardHtml(stats);
      return new Response(html, {
        headers: { "Content-Type": "text/html; charset=utf-8" }
      });
    }

    // Public Endpoint: /health (sanitized — no state or stack traces leaked)
    if (url.pathname === "/health" && request.method === "GET") {
      return Response.json({
        status: "ok",
        service: "DMRC Service Update Bot",
        time: new Date().toISOString()
      });
    }

    // Authenticated Endpoint: /stats
    if (url.pathname === "/stats" && request.method === "GET") {
      if (!isAuthorized(request, env)) {
        return new Response("Unauthorized", { status: 401 });
      }
      const stats = await getKVStats(env);
      return Response.json(stats);
    }

    // Authenticated Endpoint: /trigger (POST only)
    if (url.pathname === "/trigger") {
      if (request.method !== "POST") {
        return Response.json({ error: "Method not allowed. Use POST." }, { status: 405 });
      }

      if (!isAuthorized(request, env)) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }

      try {
        const result = await runServiceUpdatePipeline(env);
        return Response.json({
          status: "completed",
          timestamp: new Date().toISOString(),
          result: result
        });
      } catch (err) {
        console.error("Pipeline error in /trigger:", err);
        return Response.json({
          status: "error",
          message: "Internal server error during pipeline execution"
        }, { status: 500 });
      }
    }

    return new Response("Not Found", { status: 404 });
  }
};

/**
 * Validates request authorization header against TRIGGER_SECRET
 * @param {Request} request - Incoming HTTP request
 * @param {object} env - Worker environment
 * @returns {boolean} Whether the request is authorized
 */
function isAuthorized(request, env) {
  const triggerSecret = env.TRIGGER_SECRET;
  if (!triggerSecret) return true; // No secret configured = open access

  const authHeader = request.headers.get("X-Trigger-Secret") || request.headers.get("Authorization");
  return authHeader === triggerSecret || authHeader === `Bearer ${triggerSecret}`;
}

/**
 * Main pipeline: fetch tweets → analyze with AI → send Telegram notifications → update state
 * @param {object} env - Worker environment bindings
 * @returns {Promise<object>} Pipeline execution result
 */
async function runServiceUpdatePipeline(env) {
  console.log("Starting DMRC Service Update Pipeline...");

  const kv = env.TWEET_STORE;

  // Concurrency Lock Guard (Distributed KV Lock with 60s TTL)
  if (kv) {
    const isLocked = await kv.get("lock:pipeline");
    if (isLocked) {
      console.warn("Pipeline run already in progress (KV lock active). Exiting.");
      return { status: "locked", message: "Concurrent run prevented by lock" };
    }
    await kv.put("lock:pipeline", "true", { expirationTtl: 60 });
  }

  try {
    // 1. Get last processed tweet ID from KV
    let lastTweetId = null;
    if (kv) {
      try {
        lastTweetId = await kv.get("last_tweet_id");
      } catch (e) {
        console.warn("KV fetch last_tweet_id warning:", e.message);
      }
    }
    console.log(`Last processed tweet ID from KV: ${lastTweetId || "None (First Run)"}`);

    // 2. Fetch recent tweets from @OfficialDMRC
    let tweets = [];
    let apiHits = 0;
    try {
      const result = await fetchRecentTweets(env, lastTweetId);
      tweets = Array.isArray(result) ? result : (result.tweets || []);
      apiHits = typeof result === "object" && typeof result.apiHits === "number" ? result.apiHits : 1;
    } catch (err) {
      console.error("Failed to fetch tweets from SocialData:", err);
      throw err;
    }

    if (!tweets || tweets.length === 0) {
      console.log("No new tweets found.");
      await updateStats(env, 0, 0, apiHits);
      return { tweets_checked: 0, updates_sent: 0, api_hits: apiHits, message: "No new tweets available" };
    }

    console.log(`Processing ${tweets.length} new tweets in ascending order...`);

    let updatesSent = 0;
    let skippedTweets = 0;
    let highWaterMarkId = lastTweetId;
    let hasFailure = false;

    // 3. Process each tweet (sorted chronologically ascending)
    for (const tweet of tweets) {
      if (hasFailure) {
        console.warn(`Skipping remaining batch due to earlier tweet processing failure.`);
        break;
      }

      try {
        // Deduplication check via KV
        if (kv) {
          const alreadyProcessed = await kv.get(`processed:${tweet.id_str}`);
          if (alreadyProcessed) {
            console.log(`Tweet ${tweet.id_str} already processed, skipping.`);
            highWaterMarkId = tweet.id_str;
            continue;
          }
        }

        console.log(`Analyzing Tweet ID: ${tweet.id_str}`);

        // Stage 1: AI Text Analysis
        const textAnalysis = await analyzeTweetText(env, tweet.text);

        // Stage 2: AI Vision Analysis (only if needed)
        let imageAnalysis = null;
        const hasImages = tweet.images && tweet.images.length > 0;
        const textHasStations = textAnalysis.affected_stations && textAnalysis.affected_stations.length > 0;

        // Trigger vision if: has images AND (not confirmed update, OR low confidence, OR no stations extracted)
        if (hasImages && (!textAnalysis.is_service_update || textAnalysis.confidence < 0.8 || !textHasStations)) {
          console.log(`Triggering Vision OCR analysis for image: ${tweet.images[0]}`);
          imageAnalysis = await analyzeNoticeImage(env, tweet.images[0]);
        }

        // Determine final service update verdict
        const isServiceUpdate = Boolean(
          textAnalysis.is_service_update || (imageAnalysis && imageAnalysis.is_service_update)
        );

        if (isServiceUpdate) {
          console.log(`🎯 Service update detected for tweet ${tweet.id_str}! Sending to Telegram...`);

          const fullHtmlMsg = formatAdvisoryMessage(tweet, textAnalysis, imageAnalysis);
          await sendTelegramNotification(env, tweet, textAnalysis, imageAnalysis, fullHtmlMsg);

          updatesSent++;
        } else {
          console.log(`⏭️ Tweet ${tweet.id_str} is not a service update. Skipping.`);
          skippedTweets++;
        }

        // Mark processed in KV (TTL: 7 days = 604800 seconds)
        if (kv) {
          await kv.put(`processed:${tweet.id_str}`, JSON.stringify({
            processed_at: new Date().toISOString(),
            is_service_update: isServiceUpdate,
            category: textAnalysis.category
          }), { expirationTtl: 604800 });

          highWaterMarkId = tweet.id_str;
          await kv.put("last_tweet_id", highWaterMarkId);
        }

      } catch (tweetErr) {
        console.error(`Error processing tweet ${tweet.id_str}:`, tweetErr);
        hasFailure = true;
      }
    }

    // Update statistics with actual SocialData HTTP requests count (apiHits)
    await updateStats(env, tweets.length, updatesSent, apiHits);

    return {
      tweets_checked: tweets.length,
      updates_sent: updatesSent,
      skipped: skippedTweets,
      api_hits: apiHits,
      last_tweet_id: highWaterMarkId
    };

  } finally {
    // Always release lock
    if (kv) {
      await kv.delete("lock:pipeline");
    }
  }
}

/**
 * Update system statistics in KV
 * @param {object} env - Worker environment
 * @param {number} newCheckedCount - Number of tweets checked this run
 * @param {number} newUpdatesCount - Number of service updates sent this run
 * @param {number} apiHits - Number of SocialData API calls made
 */
async function updateStats(env, newCheckedCount, newUpdatesCount, apiHits = 1) {
  if (!env.TWEET_STORE) return;

  try {
    const currentMonth = new Date().toISOString().substring(0, 7); // e.g. "2026-07"
    const rawStats = await env.TWEET_STORE.get("stats");
    let stats = rawStats ? JSON.parse(rawStats) : {};

    // Reset monthly counter if month changed
    if (stats.current_month !== currentMonth) {
      stats.current_month = currentMonth;
      stats.api_hits_this_month = apiHits;
    } else {
      stats.api_hits_this_month = (stats.api_hits_this_month || 0) + apiHits;
    }

    stats.total_checked = (stats.total_checked || 0) + newCheckedCount;
    stats.advisories_sent = (stats.advisories_sent || 0) + newUpdatesCount;
    stats.runs = (stats.runs || 0) + 1;
    stats.last_run = new Date().toISOString();

    await env.TWEET_STORE.put("stats", JSON.stringify(stats));
  } catch (err) {
    console.error("Failed to update stats in KV:", err);
  }
}

/**
 * Get KV statistics for dashboard and /stats endpoint
 * @param {object} env - Worker environment
 * @returns {Promise<object>} Current statistics
 */
async function getKVStats(env) {
  if (!env.TWEET_STORE) {
    return { status: "KV binding not configured" };
  }

  try {
    const lastId = await env.TWEET_STORE.get("last_tweet_id");
    const rawStats = await env.TWEET_STORE.get("stats");
    const stats = rawStats ? JSON.parse(rawStats) : {};

    return {
      last_processed_tweet_id: lastId || null,
      api_hits_this_month: stats.api_hits_this_month || 0,
      ...stats
    };
  } catch (err) {
    return { error: err.message };
  }
}

/**
 * Twitter/X API Client using SocialData API (https://socialdata.tools)
 * Targets @OfficialDMRC (Delhi Metro Rail Corporation)
 */

import { fetchWithTimeout } from "./utils.js";

/**
 * Fetch recent tweets from @OfficialDMRC via SocialData API
 * @param {object} env - Cloudflare Worker environment bindings
 * @param {string|null} lastTweetId - Last processed tweet ID for pagination
 * @returns {Promise<Array>} Array of normalized tweet objects sorted chronologically
 */
export async function fetchRecentTweets(env, lastTweetId = null) {
  const apiKey = env.SOCIALDATA_API_KEY;
  const username = env.DMRC_USERNAME || "OfficialDMRC";
  const maxTweets = parseInt(env.MAX_TWEETS_PER_CHECK || "20", 10);

  if (!apiKey) {
    throw new Error("SOCIALDATA_API_KEY secret is not set.");
  }

  // Validate lastTweetId is a proper numeric string
  const validLastId = (lastTweetId && lastTweetId !== "null" && lastTweetId !== "undefined" && /^\d+$/.test(String(lastTweetId).trim()))
    ? String(lastTweetId).trim()
    : null;

  let query = `from:${username} -filter:replies`;
  if (validLastId) {
    query += ` since_id:${validLastId}`;
  }

  const url = `https://api.socialdata.tools/twitter/search?query=${encodeURIComponent(query)}`;
  console.log(`Fetching recent tweets from SocialData API (Single Call): ${url}`);

  const response = await fetchWithTimeout(url, {
    method: "GET",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Accept": "application/json"
    }
  }, 10000);

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`SocialData API HTTP ${response.status}: ${errText}`);
  }

  const data = await response.json();
  const rawTweets = data.tweets || data.data || (Array.isArray(data) ? data : []);

  console.log(`Retrieved ${rawTweets.length} raw tweets from SocialData.`);

  // Normalize, filter valid numeric IDs, and exclude retweets
  const normalizedTweets = rawTweets
    .map(tweet => parseTweet(tweet, username))
    .filter(tweet => tweet && /^\d+$/.test(tweet.id_str) && !tweet.is_retweet);

  // Sort chronologically ascending (oldest first) using BigInt for large IDs
  normalizedTweets.sort((a, b) => {
    try {
      const idA = BigInt(a.id_str);
      const idB = BigInt(b.id_str);
      return idA > idB ? 1 : idA < idB ? -1 : 0;
    } catch (e) {
      return 0;
    }
  });

  // Enforce MAX_TWEETS_PER_CHECK ceiling and return exactly 1 API hit
  return {
    tweets: normalizedTweets.slice(0, maxTweets),
    apiHits: 1
  };
}

/**
 * Normalizes a raw tweet object from SocialData into a standard format
 * @param {object} tweet - Raw tweet from API
 * @param {string} username - Twitter username
 * @returns {object|null} Normalized tweet object
 */
function parseTweet(tweet, username) {
  if (!tweet) return null;

  const idStr = tweet.id_str || (tweet.id ? String(tweet.id) : null);
  if (!idStr) return null;

  const text = tweet.full_text || tweet.text || "";
  const createdAt = tweet.tweet_created_at || tweet.created_at || new Date().toISOString();
  const isRetweet = text.startsWith("RT @") || Boolean(tweet.retweeted_status);

  // Extract image URLs from media entities
  const mediaEntities = tweet.extended_entities?.media || tweet.entities?.media || [];
  const images = mediaEntities
    .filter(m => m.type === "photo")
    .map(m => m.media_url_https || m.media_url)
    .filter(Boolean);

  const tweetUrl = `https://x.com/${username}/status/${idStr}`;

  return {
    id_str: idStr,
    text: text,
    created_at: createdAt,
    images: images,
    tweet_url: tweetUrl,
    is_retweet: isRetweet
  };
}

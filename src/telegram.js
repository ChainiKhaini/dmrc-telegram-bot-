/**
 * Telegram Bot API Client
 * Handles sending notifications via sendPhoto (with caption) or sendMessage (text fallback)
 */

import { fetchWithTimeout } from "./utils.js";
import { formatPhotoCaption } from "./formatter.js";

/**
 * Send a DMRC service update notification to Telegram
 * Tries sendPhoto first (if tweet has images), falls back to sendMessage
 * @param {object} env - Worker environment with Telegram secrets
 * @param {object} tweet - Normalized tweet object
 * @param {object} textAnalysis - Stage 1 AI text analysis result
 * @param {object|null} imageAnalysis - Stage 2 AI vision analysis result
 * @param {string|null} fullHtmlMessage - Pre-formatted full HTML message
 * @returns {Promise<object>} Telegram API response
 */
export async function sendTelegramNotification(env, tweet, textAnalysis, imageAnalysis = null, fullHtmlMessage = null) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    throw new Error("TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is missing.");
  }

  const hasPhoto = tweet.images && tweet.images.length > 0;
  const photoUrl = hasPhoto ? tweet.images[0] : null;

  // If photo is available, try sending via sendPhoto with dedicated short caption
  if (photoUrl) {
    try {
      const photoCaption = formatPhotoCaption(tweet, textAnalysis, imageAnalysis);
      const photoResult = await sendPhoto(token, chatId, photoUrl, photoCaption);
      if (photoResult.ok) {
        return photoResult;
      }
      console.warn("sendPhoto failed, falling back to sendMessage:", photoResult);
    } catch (err) {
      console.warn("Error sending photo to Telegram, falling back to text:", err);
    }
  }

  // Fallback or standard text message
  const textToSend = fullHtmlMessage || formatPhotoCaption(tweet, textAnalysis, imageAnalysis);
  return await sendMessage(token, chatId, textToSend);
}

/**
 * Send HTML text message via Telegram sendMessage with 4096-char safety guard
 * @param {string} token - Bot token
 * @param {string} chatId - Target chat ID
 * @param {string} htmlText - HTML-formatted message
 * @param {number} maxRetries - Maximum retry attempts (default 3)
 * @returns {Promise<object>} Telegram API response
 */
async function sendMessage(token, chatId, htmlText, maxRetries = 3) {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;

  // Cap message length to avoid Telegram 4096-char limit
  let safeText = htmlText;
  if (safeText.length > 4000) {
    safeText = safeText.substring(0, 3950) + "...\n\n<i>[Message truncated due to length]</i>";
  }

  const payload = {
    chat_id: chatId,
    text: safeText,
    parse_mode: "HTML",
    disable_web_page_preview: false
  };

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const response = await fetchWithTimeout(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }, 10000);

    const data = await response.json();

    if (response.ok && data.ok) {
      console.log(`Telegram message sent successfully (msg_id: ${data.result.message_id})`);
      return data;
    }

    // Handle rate limiting with exponential backoff
    if (response.status === 429) {
      const retryAfter = data.parameters?.retry_after || 5;
      console.warn(`Telegram rate limited. Waiting ${retryAfter}s before retry...`);
      await new Promise(r => setTimeout(r, retryAfter * 1000));
      continue;
    }

    throw new Error(`Telegram API Error (HTTP ${response.status}): ${data.description || JSON.stringify(data)}`);
  }

  throw new Error("Failed to send Telegram message after max retries.");
}

/**
 * Send photo with HTML caption via Telegram sendPhoto
 * @param {string} token - Bot token
 * @param {string} chatId - Target chat ID
 * @param {string} photoUrl - Photo URL
 * @param {string} photoCaption - HTML caption (max ~1024 chars)
 * @returns {Promise<object>} Telegram API response
 */
async function sendPhoto(token, chatId, photoUrl, photoCaption) {
  const url = `https://api.telegram.org/bot${token}/sendPhoto`;

  const payload = {
    chat_id: chatId,
    photo: photoUrl,
    caption: photoCaption,
    parse_mode: "HTML"
  };

  const response = await fetchWithTimeout(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  }, 12000);

  return await response.json();
}

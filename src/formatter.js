/**
 * Formatter for building rich HTML Telegram messages from DMRC AI analysis results
 */

/**
 * Format a full advisory message for Telegram sendMessage
 * @param {object} tweet - Normalized tweet object
 * @param {object} textAnalysis - Stage 1 AI text classification result
 * @param {object|null} imageAnalysis - Stage 2 AI vision analysis result
 * @returns {string} HTML-formatted Telegram message
 */
export function formatAdvisoryMessage(tweet, textAnalysis, imageAnalysis = null) {
  const category = escapeHtml(textAnalysis.category || "Service Update");
  const summary = escapeHtml(imageAnalysis?.notice_summary || textAnalysis.summary_en || "Service update from Delhi Metro Rail Corporation.");

  // Combine affected stations from text + image analysis
  const combinedStationsSet = new Set([
    ...(textAnalysis.affected_stations || []),
    ...(imageAnalysis?.affected_stations || [])
  ]);
  const affectedStations = Array.from(combinedStationsSet).filter(Boolean);

  // Combine affected lines
  const combinedLinesSet = new Set([
    ...(textAnalysis.affected_lines || []),
    ...(imageAnalysis?.affected_lines || [])
  ]);
  const affectedLines = Array.from(combinedLinesSet).filter(Boolean);

  // Interchange availability
  const combinedInterchangeSet = new Set([
    ...(textAnalysis.interchange_available || []),
    ...(imageAnalysis?.interchange_available || [])
  ]);
  const interchangeStations = Array.from(combinedInterchangeSet).filter(Boolean);

  const tweetDate = formatDate(tweet.created_at);

  let message = `🚇 <b>DMRC SERVICE UPDATE</b>\n`;
  message += `━━━━━━━━━━━━━━━━━━━━\n\n`;
  message += `📋 <b>Category:</b> ${category}\n`;
  message += `📅 <b>Date:</b> ${tweetDate}\n\n`;

  message += `📝 <b>Summary:</b>\n${summary}\n\n`;

  if (affectedStations.length > 0) {
    const formattedStations = affectedStations.map(s => escapeHtml(s)).join(", ");
    message += `🚉 <b>Affected Stations:</b>\n${formattedStations}\n\n`;
  }

  if (interchangeStations.length > 0) {
    const formattedInterchange = interchangeStations.map(s => escapeHtml(s)).join(", ");
    message += `🔀 <b>Interchange Available At:</b>\n${formattedInterchange}\n\n`;
  }

  if (affectedLines.length > 0) {
    const formattedLines = affectedLines.map(l => escapeHtml(l)).join(", ");
    message += `🚊 <b>Affected Lines:</b>\n${formattedLines}\n\n`;
  }

  const duration = imageAnalysis?.timing_info || textAnalysis.duration;
  if (duration) {
    message += `⏰ <b>Duration:</b> ${escapeHtml(duration)}\n\n`;
  }

  // Include sanitized original tweet snippet
  const rawSnippet = tweet.text.length > 280 ? tweet.text.substring(0, 277) + "..." : tweet.text;
  const tweetSnippet = escapeHtml(rawSnippet);
  message += `💬 <b>Original Post:</b>\n<blockquote>${tweetSnippet}</blockquote>\n\n`;

  message += `🔗 <a href="${tweet.tweet_url}">View Post on X/Twitter</a>`;

  return message;
}

/**
 * Builds a shorter photo caption (capped under 900 chars for Telegram sendPhoto)
 * @param {object} tweet - Normalized tweet object
 * @param {object} textAnalysis - Stage 1 AI result
 * @param {object|null} imageAnalysis - Stage 2 AI result
 * @returns {string} HTML-formatted caption
 */
export function formatPhotoCaption(tweet, textAnalysis, imageAnalysis = null) {
  const category = escapeHtml(textAnalysis.category || "Service Update");
  const summary = escapeHtml(imageAnalysis?.notice_summary || textAnalysis.summary_en || "Service update from Delhi Metro Rail Corporation.");
  const tweetDate = formatDate(tweet.created_at);

  let caption = `🚇 <b>DMRC SERVICE UPDATE</b>\n`;
  caption += `📋 <b>Category:</b> ${category}\n`;
  caption += `📅 <b>Date:</b> ${tweetDate}\n\n`;
  caption += `📝 <b>Summary:</b>\n${summary}\n\n`;

  // Include affected stations if they fit within caption limit
  const combinedStations = [
    ...(textAnalysis.affected_stations || []),
    ...(imageAnalysis?.affected_stations || [])
  ].filter(Boolean);

  if (combinedStations.length > 0) {
    const stationStr = combinedStations.slice(0, 10).map(s => escapeHtml(s)).join(", ");
    if (caption.length + stationStr.length < 750) {
      caption += `🚉 <b>Stations:</b> ${stationStr}\n\n`;
    }
  }

  caption += `🔗 <a href="${tweet.tweet_url}">View Post on X/Twitter</a>`;

  return caption;
}

/**
 * Escapes HTML special characters for Telegram HTML parse_mode
 * @param {string} str - Input string
 * @returns {string} HTML-escaped string
 */
export function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Format ISO timestamp into user-friendly date format (IST)
 * @param {string} isoString - ISO date string
 * @returns {string} Formatted date string
 */
function formatDate(isoString) {
  try {
    const date = new Date(isoString);
    return date.toLocaleDateString("en-IN", {
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "Asia/Kolkata"
    }) + " IST";
  } catch (e) {
    return isoString || "Today";
  }
}

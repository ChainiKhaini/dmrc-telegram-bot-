/**
 * Shared utility functions
 */

/**
 * Fetch wrapper with timeout support using AbortController
 * @param {string} url - URL to fetch
 * @param {object} options - Fetch options
 * @param {number} timeoutMs - Timeout in milliseconds (default 12000)
 * @returns {Promise<Response>}
 */
export async function fetchWithTimeout(url, options = {}, timeoutMs = 12000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });
    return response;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Safely parse boolean values from mixed types (boolean, string, number)
 * @param {*} value - Input value to parse
 * @returns {boolean}
 */
export function parseBoolean(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const lower = value.trim().toLowerCase();
    if (lower === "true" || lower === "1" || lower === "yes") return true;
    if (lower === "false" || lower === "0" || lower === "no") return false;
  }
  if (typeof value === "number") return value !== 0;
  return false;
}

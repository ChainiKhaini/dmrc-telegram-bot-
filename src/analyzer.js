/**
 * AI Analysis module using Cloudflare Workers AI
 * - Stage 1: Text classification using Meta Llama 3.1 8B (DMRC service updates)
 * - Stage 2: Vision analysis (OCR + extraction) using Meta Llama 3.2 11B Vision
 */

import { fetchWithTimeout, parseBoolean } from "./utils.js";

const TEXT_MODELS = [
  "@cf/meta/llama-3.1-8b-instruct-fast",
  "@cf/meta/llama-3.1-8b-instruct",
  "@cf/meta/llama-3-8b-instruct"
];

const VISION_MODELS = [
  "@cf/meta/llama-3.2-11b-vision-instruct"
];

/**
 * Stage 1: Classify if tweet text is a DMRC service update
 * @param {object} env - Worker environment with AI binding
 * @param {string} tweetText - Raw tweet text
 * @returns {Promise<object>} Classification result
 */
export async function analyzeTweetText(env, tweetText) {
  const systemPrompt = `You are an AI classifier for Delhi Metro Rail Corporation (@OfficialDMRC) tweets.
Your job is to determine if a tweet is a SERVICE UPDATE that commuters need to act on or be aware of.

SERVICE UPDATE tweets include:
- Metro station closures or reopenings
- Service delays on specific lines (Red, Yellow, Blue, Green, Violet, Magenta, Pink, Grey, Orange/Airport Express, Rapid Metro)
- Line suspensions or partial service between stations
- Speed restrictions or single-line operations
- Service restoration announcements ("All stations are now open")
- Emergency evacuations or security alerts at stations
- Gate closures at specific stations
- Last metro timing changes

NOT a service update (exclude these):
- General promotional content, metro ridership milestones
- Festive greetings, HR/recruitment posts
- Retweets without specific service information
- Awareness campaigns ("Metro etiquette" slogans)
- Event inaugurations or award ceremonies
- Tourist/heritage corridor announcements without operational impact

Analyze the tweet text and return ONLY a raw JSON object (no markdown, no backticks) with this structure:
{
  "is_service_update": true or false,
  "confidence": 0.0 to 1.0,
  "category": "Station Closure" | "Service Delay" | "Line Suspension" | "Speed Restriction" | "Service Restoration" | "Security Alert" | "Gate Closure" | "Timing Change" | "General Update",
  "summary_en": "A concise 1-2 sentence English summary of the update",
  "affected_stations": ["List of station names if mentioned, else empty array"],
  "affected_lines": ["List of metro line names/colors if mentioned, else empty array"],
  "interchange_available": ["Stations where interchange is still available, if mentioned"],
  "duration": "Duration or time info if mentioned, else null"
}`;

  for (const model of TEXT_MODELS) {
    try {
      console.log(`Running text analysis with model: ${model}`);
      const response = await env.AI.run(model, {
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: `Tweet: "${tweetText}"` }
        ],
        max_tokens: 400
      });

      const outputText = typeof response === "object" ? (response.response || JSON.stringify(response)) : String(response);
      const parsed = cleanAndParseJson(outputText);

      if (parsed && parsed.is_service_update !== undefined) {
        parsed.is_service_update = parseBoolean(parsed.is_service_update);
        parsed.confidence = typeof parsed.confidence === "number" ? parsed.confidence : 0.7;
        return parsed;
      }

      console.warn(`Model ${model} output was not valid JSON:`, outputText);
    } catch (error) {
      console.warn(`Error running AI text model ${model}:`, error.message || error);
    }
  }

  console.warn("All AI text models failed. Using fallback text analysis.");
  return fallbackTextAnalysis(tweetText);
}

/**
 * Stage 2: Vision OCR & Structured Data Extraction from Metro Notice Image
 * @param {object} env - Worker environment with AI binding
 * @param {string} imageUrl - URL of the notice image
 * @returns {Promise<object|null>} Extracted structured data or null
 */
export async function analyzeNoticeImage(env, imageUrl) {
  console.log(`Fetching image for vision analysis: ${imageUrl}`);

  try {
    const imgResponse = await fetchWithTimeout(imageUrl, {}, 10000);
    if (!imgResponse.ok) {
      console.error(`Failed to fetch image: HTTP ${imgResponse.status}`);
      return null;
    }

    const imageBuffer = await imgResponse.arrayBuffer();
    const uint8Array = new Uint8Array(imageBuffer);

    const prompt = `This is an official notice or infographic from Delhi Metro Rail Corporation (DMRC).
Please extract all structured text and details from this image.

Return ONLY a raw JSON object (no markdown, no backticks) with this exact schema:
{
  "is_service_update": true or false,
  "title": "Title/Header of the notice",
  "affected_stations": ["List every single station name mentioned"],
  "affected_lines": ["Metro line names/colors mentioned (e.g. Yellow Line, Blue Line)"],
  "interchange_available": ["Stations where interchange facility remains available"],
  "closure_date": "Date mentioned (e.g. 22/07/2026)",
  "timing_info": "Time range or duration mentioned",
  "notice_summary": "1-2 sentence summary of what the notice states"
}`;

    for (const model of VISION_MODELS) {
      try {
        console.log(`Running vision analysis with model: ${model}`);
        const response = await env.AI.run(model, {
          prompt: prompt,
          image: uint8Array
        });

        const outputText = typeof response === "object" ? (response.response || JSON.stringify(response)) : String(response);
        const parsed = cleanAndParseJson(outputText);

        if (parsed) {
          parsed.is_service_update = parseBoolean(parsed.is_service_update);
          return parsed;
        }
      } catch (err) {
        console.warn(`Vision model ${model} error:`, err.message || err);
      }
    }

    return null;

  } catch (error) {
    console.error("Error in AI Vision analysis pipeline:", error);
    return null;
  }
}

/**
 * Helper to extract clean JSON from AI output (stripping markdown backticks)
 * @param {string} text - Raw AI output text
 * @returns {object|null} Parsed JSON or null
 */
function cleanAndParseJson(text) {
  if (typeof text !== "string") return null;

  try {
    let cleaned = text.replace(/```json\s*/gi, "").replace(/```\s*/gi, "").trim();

    const firstBrace = cleaned.indexOf("{");
    const lastBrace = cleaned.lastIndexOf("}");

    if (firstBrace !== -1 && lastBrace > firstBrace) {
      cleaned = cleaned.substring(firstBrace, lastBrace + 1);
    }

    return JSON.parse(cleaned);
  } catch (err) {
    return null;
  }
}

/**
 * Heuristic keyword fallback if all AI models fail
 * @param {string} text - Tweet text
 * @returns {object} Fallback classification result
 */
function fallbackTextAnalysis(text) {
  const lower = text.toLowerCase();
  const serviceKeywords = [
    "service update",
    "closed",
    "closure",
    "delay",
    "delayed",
    "suspended",
    "restored",
    "restoration",
    "normal services",
    "stations",
    "interchange",
    "single line",
    "speed restriction",
    "evacuated",
    "security alert",
    "gate no",
    "entry/exit",
    "now open"
  ];
  const matches = serviceKeywords.filter(kw => lower.includes(kw));

  const isUpdate = matches.length >= 2 || lower.includes("service update");

  return {
    is_service_update: isUpdate,
    confidence: isUpdate ? 0.75 : 0.2,
    category: isUpdate ? "Station Closure" : "General Update",
    summary_en: text.substring(0, 200) + (text.length > 200 ? "..." : ""),
    affected_stations: [],
    affected_lines: [],
    interchange_available: [],
    duration: null
  };
}

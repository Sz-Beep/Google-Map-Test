// Reads a screenshot or photo of a blocker and turns it into a structured,
// time-boxed report the routing engine can use. Uses the Claude API (vision).
// Without ANTHROPIC_API_KEY the app still works: the reporter picks the type.

const KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5";
const TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

const PROMPT = `You help New Yorkers get around the Macy's Thanksgiving Day Parade.
This image was uploaded as evidence of something blocking travel: a photo of a barricade or crowd,
a closed subway entrance, a posted notice, or a screenshot of an MTA/NYPD/NYC DOT alert or social post.

Reply with ONLY a JSON object, no prose:
{
  "kind": "barricade" | "closure" | "crowd" | "station" | "bus" | "other" | "not_a_blocker",
  "summary": "one plain sentence a traveler can act on, under 140 characters",
  "where": "street, intersection or station named in the image, or null",
  "lines": ["subway or bus lines named, e.g. C, M7"],
  "until": "any reopening time stated in the image, verbatim, or null",
  "source_seen": "who published it if it is a screenshot of an official post (e.g. MTA, NYPD), else null",
  "confidence": 0.0-1.0
}
Use "not_a_blocker" for anything unrelated, unreadable, or personal. Never transcribe faces, names, phone numbers or license plates.`;

export const visionEnabled = () => !!KEY;

export async function readScreenshot({ base64, mediaType, note }) {
  if (!KEY) return null;
  if (!TYPES.has(mediaType)) throw new Error("Upload a JPG, PNG, WebP or GIF.");
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 400,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
          { type: "text", text: PROMPT + (note ? `\n\nThe reporter added: "${String(note).slice(0, 280)}"` : "") },
        ],
      }],
    }),
    signal: AbortSignal.timeout(30e3),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data?.error?.message ?? `Claude API ${r.status}`);
  const text = (data.content ?? []).map((c) => c.text ?? "").join("");
  const json = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  try {
    const out = JSON.parse(json);
    return {
      kind: String(out.kind ?? "other"),
      summary: String(out.summary ?? "").slice(0, 200),
      where: out.where ? String(out.where).slice(0, 120) : null,
      lines: Array.isArray(out.lines) ? out.lines.map(String).slice(0, 6) : [],
      until: out.until ? String(out.until).slice(0, 60) : null,
      sourceSeen: out.source_seen ? String(out.source_seen).slice(0, 60) : null,
      confidence: Math.max(0, Math.min(1, Number(out.confidence) || 0)),
    };
  } catch {
    return { kind: "other", summary: "Couldn't read this image clearly.", lines: [], confidence: 0 };
  }
}

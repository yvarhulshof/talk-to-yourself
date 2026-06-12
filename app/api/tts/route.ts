export const runtime = "nodejs";

const DEFAULT_STOCK_VOICE = "21m00Tcm4TlvDq8ikWAM"; // ElevenLabs "Rachel"

// POST { text, voiceId?, settings? } -> audio/mpeg stream.
// Proxies ElevenLabs Flash v2.5; the client calls this once per sentence as
// the Claude reply streams in, so latency stays low.
export async function POST(req: Request) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    return Response.json(
      { error: "ELEVENLABS_API_KEY is not set. Add it to .env.local to enable voice." },
      { status: 500 },
    );
  }

  let text: string;
  let voiceId: string;
  let settings: Record<string, number | boolean> | undefined;
  try {
    const body = await req.json();
    text = typeof body.text === "string" ? body.text.trim() : "";
    voiceId =
      typeof body.voiceId === "string" && /^[A-Za-z0-9]{8,64}$/.test(body.voiceId)
        ? body.voiceId
        : process.env.ELEVENLABS_STOCK_VOICE_ID || DEFAULT_STOCK_VOICE;
    if (body.settings && typeof body.settings === "object") {
      settings = {
        stability: Number(body.settings.stability ?? 0.5),
        similarity_boost: Number(body.settings.similarity_boost ?? 0.75),
        style: Number(body.settings.style ?? 0),
        use_speaker_boost: Boolean(body.settings.use_speaker_boost ?? true),
      };
    }
    if (!text || text.length > 2000) throw new Error("bad text");
  } catch {
    return Response.json(
      { error: "Body must be { text: string (<=2000 chars), voiceId?, settings? }." },
      { status: 400 },
    );
  }

  const upstream = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?output_format=mp3_44100_64`,
    {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text,
        model_id: "eleven_flash_v2_5",
        ...(settings ? { voice_settings: settings } : {}),
      }),
    },
  );

  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => "");
    return Response.json(
      { error: `TTS failed (${upstream.status}): ${detail.slice(0, 300)}` },
      { status: 502 },
    );
  }

  return new Response(upstream.body, {
    headers: { "Content-Type": "audio/mpeg" },
  });
}

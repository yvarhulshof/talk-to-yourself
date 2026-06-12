export const runtime = "nodejs";

// POST raw audio body -> { transcript }.
// Deepgram pre-recorded transcription, used as the push-to-talk fallback in
// browsers without the Web Speech API. Chrome users never hit this route.
export async function POST(req: Request) {
  const apiKey = process.env.DEEPGRAM_API_KEY;
  if (!apiKey) {
    return Response.json(
      { error: "DEEPGRAM_API_KEY is not set. Use Chrome (Web Speech API) or add the key to .env.local." },
      { status: 500 },
    );
  }

  const audio = await req.arrayBuffer();
  if (!audio.byteLength || audio.byteLength > 10 * 1024 * 1024) {
    return Response.json(
      { error: "Body must be a non-empty audio file (<=10MB)." },
      { status: 400 },
    );
  }

  const upstream = await fetch(
    "https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true",
    {
      method: "POST",
      headers: {
        Authorization: `Token ${apiKey}`,
        "Content-Type": req.headers.get("content-type") || "audio/webm",
      },
      body: audio,
    },
  );

  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => "");
    return Response.json(
      { error: `STT failed (${upstream.status}): ${detail.slice(0, 300)}` },
      { status: 502 },
    );
  }

  const data = await upstream.json();
  const transcript: string =
    data?.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? "";
  return Response.json({ transcript: transcript.trim() });
}

export const runtime = "nodejs";

const MAX_TOTAL_BYTES = 25 * 1024 * 1024;

// POST multipart/form-data { files: Blob[] } -> { voiceId }.
// Creates an ElevenLabs instant voice clone from the user's accumulated
// utterance recordings. Consent is collected client-side before any
// recording starts; users clone only their own voice.
export async function POST(req: Request) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    return Response.json(
      { error: "ELEVENLABS_API_KEY is not set. Add it to .env.local to enable voice." },
      { status: 500 },
    );
  }

  let files: File[];
  try {
    const form = await req.formData();
    files = form.getAll("files").filter((f): f is File => f instanceof File);
    const total = files.reduce((sum, f) => sum + f.size, 0);
    if (!files.length || total === 0 || total > MAX_TOTAL_BYTES) {
      throw new Error("bad files");
    }
  } catch {
    return Response.json(
      { error: "Body must be multipart/form-data with 1+ non-empty audio 'files' (<=25MB total)." },
      { status: 400 },
    );
  }

  const upstream = new FormData();
  upstream.append("name", `talk-to-yourself-${Date.now()}`);
  upstream.append(
    "description",
    "Instant clone of the user's own voice, created with their consent by the Talk to Yourself app.",
  );
  // ElevenLabs accepts multiple sample files; send the utterances as-is.
  files.slice(0, 25).forEach((file, i) => {
    upstream.append("files", file, file.name || `utterance-${i}.webm`);
  });

  const res = await fetch("https://api.elevenlabs.io/v1/voices/add", {
    method: "POST",
    headers: { "xi-api-key": apiKey },
    body: upstream,
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    return Response.json(
      { error: `Voice clone failed (${res.status}): ${detail.slice(0, 300)}` },
      { status: 502 },
    );
  }

  const data = await res.json();
  return Response.json({ voiceId: data.voice_id });
}

// DELETE /api/voice?id=<voiceId> — clone cleanup ("forget me").
export async function DELETE(req: Request) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    return Response.json({ error: "ELEVENLABS_API_KEY is not set." }, { status: 500 });
  }

  const id = new URL(req.url).searchParams.get("id");
  if (!id || !/^[A-Za-z0-9]{8,64}$/.test(id)) {
    return Response.json({ error: "Pass ?id=<voiceId>." }, { status: 400 });
  }

  const res = await fetch(`https://api.elevenlabs.io/v1/voices/${id}`, {
    method: "DELETE",
    headers: { "xi-api-key": apiKey },
  });

  if (!res.ok && res.status !== 404) {
    const detail = await res.text().catch(() => "");
    return Response.json(
      { error: `Voice delete failed (${res.status}): ${detail.slice(0, 300)}` },
      { status: 502 },
    );
  }

  return Response.json({ ok: true });
}

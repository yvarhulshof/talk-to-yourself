import Anthropic from "@anthropic-ai/sdk";
import {
  PROFILE_REQUEST,
  buildProfileSystemPrompt,
  withTranscriptCacheBreakpoint,
} from "@/lib/persona";

export const runtime = "nodejs";

let client: Anthropic | null = null;

// Regenerates the USER MODEL document from the full transcript. Called by
// the client in the background after every completed turn; the result is
// fed back into the next /api/chat request's system prompt.
export async function POST(req: Request) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return Response.json(
      { error: "ANTHROPIC_API_KEY is not set. Copy .env.example to .env.local and add your key." },
      { status: 500 },
    );
  }
  client ??= new Anthropic();

  let messages: Anthropic.MessageParam[];
  try {
    const body = await req.json();
    messages = body.messages;
    if (
      !Array.isArray(messages) ||
      messages.length === 0 ||
      !messages.some((m) => m.role === "user")
    ) {
      throw new Error("bad shape");
    }
  } catch {
    return Response.json(
      { error: "Body must be { messages: MessageParam[] } containing at least one user turn." },
      { status: 400 },
    );
  }

  try {
    const response = await client.messages.create({
      model: "claude-opus-4-8",
      max_tokens: 2048,
      system: buildProfileSystemPrompt(),
      messages: [
        ...withTranscriptCacheBreakpoint(messages),
        { role: "user", content: PROFILE_REQUEST },
      ],
    });
    const profile = response.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    return Response.json({ profile });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Profile update failed." },
      { status: 502 },
    );
  }
}

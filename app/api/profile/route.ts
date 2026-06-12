import Anthropic from "@anthropic-ai/sdk";
import {
  PROFILE_REQUEST,
  buildProfileSystemPrompt,
  withTranscriptCacheBreakpoint,
} from "@/lib/persona";

export const runtime = "nodejs";

let client: Anthropic | null = null;

// Updates the USER MODEL document: merges the prior document (the app's
// cross-conversation memory, persisted in the browser) with new evidence
// from the current transcript. Called by the client in the background after
// every completed turn; the result feeds the next /api/chat request.
export async function POST(req: Request) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return Response.json(
      { error: "ANTHROPIC_API_KEY is not set. Copy .env.example to .env.local and add your key." },
      { status: 500 },
    );
  }
  client ??= new Anthropic();

  let messages: Anthropic.MessageParam[];
  let priorProfile: string | null;
  try {
    const body = await req.json();
    messages = body.messages;
    priorProfile =
      typeof body.profile === "string" && body.profile.trim()
        ? body.profile
        : null;
    if (
      !Array.isArray(messages) ||
      messages.length === 0 ||
      !messages.some((m) => m.role === "user")
    ) {
      throw new Error("bad shape");
    }
  } catch {
    return Response.json(
      { error: "Body must be { messages: MessageParam[], profile?: string } containing at least one user turn." },
      { status: 400 },
    );
  }

  try {
    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 2048,
      system: buildProfileSystemPrompt(priorProfile),
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

import Anthropic from "@anthropic-ai/sdk";
import {
  buildChatSystemPrompt,
  withTranscriptCacheBreakpoint,
} from "@/lib/persona";

export const runtime = "nodejs";

let client: Anthropic | null = null;

export async function POST(req: Request) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return Response.json(
      { error: "ANTHROPIC_API_KEY is not set. Copy .env.example to .env.local and add your key." },
      { status: 500 },
    );
  }
  client ??= new Anthropic();

  let messages: Anthropic.MessageParam[];
  let profile: string | null;
  try {
    const body = await req.json();
    messages = body.messages;
    profile =
      typeof body.profile === "string" && body.profile.trim()
        ? body.profile
        : null;
    if (
      !Array.isArray(messages) ||
      messages.length === 0 ||
      messages[messages.length - 1].role !== "user"
    ) {
      throw new Error("bad shape");
    }
  } catch {
    return Response.json(
      { error: "Body must be { messages: MessageParam[], profile?: string } ending in a user turn." },
      { status: 400 },
    );
  }

  const stream = client.messages.stream({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    system: buildChatSystemPrompt(profile),
    messages: withTranscriptCacheBreakpoint(messages),
  });

  const encoder = new TextEncoder();
  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      stream.on("text", (delta) => {
        controller.enqueue(encoder.encode(delta));
      });
      stream.on("end", () => controller.close());
      stream.on("error", (err) => controller.error(err));
    },
    cancel() {
      stream.abort();
    },
  });

  return new Response(readable, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
}

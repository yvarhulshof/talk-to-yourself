# Handover — Talk to Yourself

Context doc for the next Claude Code instance picking up this project. Read
[PLAN.md](./PLAN.md) first (full technical plan + cost analysis), then this.

## What this project is

A web app where the user talks to an AI that starts as a generic assistant and
gradually morphs into *them* — personality first (done), voice later (next).
The end state: the AI mimics the user's voice via instant voice cloning and
their persona via in-context modeling, until talking to it feels like talking
to yourself.

## Current state

**Branch:** work continued on `claude/brave-galileo-7pnfze` (branched from
`claude/pensive-pascal-5etp7w`; repo default branch has no commits). Develop
here unless the user says otherwise.

**Phase 1 + tuning is complete and verified** (builds clean, smoke-tested):

- Next.js 15 App Router app, TypeScript, no UI framework — hand-rolled CSS in
  `app/globals.css` (dark, serif, terracotta accent).
- Text chat with token-streamed Claude replies.
- **No mimicry stages** (user removed them deliberately): full mimicry from
  the first message; fidelity grows naturally with the amount of transcript.
  The word-count levels, thresholds, morph meter, and pace slider are gone.
- **User-model document:** after every completed turn the client fires a
  background call to `/api/profile`, which regenerates a markdown document
  describing the user (facts, personality/psychology, values, interests,
  likes/dislikes, humor, knowledge boundaries, writing-style fingerprint with
  verbatim quotes). The client stores it and sends it with the next chat
  request, where it's injected as the volatile system block. Viewable in the
  UI via the "its model of you" header toggle.

**Not yet built:** Phases 2–4 (voice). See "Next steps" below.

## Key files

| File | What it does |
|---|---|
| `lib/persona.ts` | The heart. System prompts: `CHAT_CORE` (cached, full-mimicry instruction) + the user-model document as the volatile block; `PROFILE_CORE` (cached analyst prompt) for the document; `withTranscriptCacheBreakpoint` for incremental transcript caching. |
| `app/api/chat/route.ts` | POST `{messages, profile?}` → streams plain-text Claude reply. Lazy Anthropic client with explicit missing-key 500. |
| `app/api/profile/route.ts` | POST `{messages}` → JSON `{profile}`: regenerates the user-model document from the full transcript (non-streaming, called in background). |
| `app/page.tsx` | Client chat UI: streaming bubbles, background profile refresh, "its model of you" panel. |
| `PLAN.md` | Vendor comparison, morph mechanics, costs, build phases. |

## Decisions already made (don't relitigate without the user)

1. **No real fine-tuning anywhere.** Voice = instant voice cloning (IVC);
   persona = in-context modeling via system prompt. Rationale in PLAN.md §1.
2. **Model:** `claude-opus-4-8` for both calls — streaming with
   `max_tokens: 1024` for chat (replies are deliberately short),
   non-streaming with `max_tokens: 2048` for the user-model document.
3. **Prompt-cache discipline:** `CHAT_CORE` and `PROFILE_CORE` must stay
   byte-identical across requests; each carries a `cache_control` breakpoint.
   The user-model document is volatile, so it lives in a *separate* system
   block appended after the cached core — never merge them. The transcript
   also gets a breakpoint on its last message (`withTranscriptCacheBreakpoint`)
   so it caches incrementally.
4. **TTS vendor (Phase 2/3):** ElevenLabs Flash v2.5, WebSocket streaming;
   Starter plan ($5/mo) gates instant cloning. Cartesia is the fallback if
   earlier/iterative cloning matters more than clone quality.
5. **STT:** browser Web Speech API for v1 (free, Chrome), Deepgram Nova-3
   streaming ($0.0077/min) for production. Always record raw audio with
   MediaRecorder in parallel — the clone needs real audio, not transcripts.
6. **Indistinguishability bar (user's explicit requirement):** an outside
   observer who knows the user must not be able to tell which side is real.
   The chat prompt enforces writing fingerprint, opinions/humor, matched
   knowledge boundaries, and no politeness surplus. If you touch the prompts,
   preserve all four of those pillars.
7. **Consent/ethics:** users clone only their own voice; consent checkbox
   before recording; delete clones at session end (ElevenLabs DELETE voice).
8. **No mimicry stages (user's explicit decision, 2026-06):** full mimicry
   from message one — escalation happens naturally as transcript data grows.
   Don't reintroduce levels, word thresholds, or pace sliders. The explicit
   user model lives in the AI-maintained document instead, regenerated from
   the full transcript after every turn (cheap thanks to caching).

## Next steps (in order)

### Phase 2 — voice loop (stock voice)
- Mic capture: `getUserMedia` + MediaRecorder (accumulate chunks for Phase 3).
- STT: Web Speech API (`SpeechRecognition`, `interimResults`) → final
  transcript becomes the chat message.
- TTS: new API route proxying ElevenLabs streaming (Flash v2.5, stock voice);
  sentence-chunk the Claude stream into TTS as it arrives; play via Web Audio.
- Env vars: add `ELEVENLABS_API_KEY` to `.env.example`.
- Latency budget: end of user speech → first AI audio < 1.5 s. Everything
  streams; nothing batches.

### Phase 3 — the voice morph
- Server accumulates user audio per session; at ~60 s of clean speech, POST to
  ElevenLabs IVC → `voice_id`.
- Stepped voice morph driven by clone readiness (the persona side no longer
  has levels): stock voice → clone with high `stability`/low `style` (user
  timbre, neutral delivery) → fully expressive clone once enough audio has
  accumulated. PLAN.md §3b has the full scheme.

### Phase 4 — polish
- Deepgram STT, barge-in (stop TTS when the user speaks), session persistence,
  clone cleanup on session end.

## How to run / verify

```sh
cp .env.example .env.local   # needs ANTHROPIC_API_KEY (none in CI/cloud env)
npm install
npm run build                # must pass — this is the regression gate
npm run dev                  # http://localhost:3000
```

There are no tests yet; `npm run build` (type-check + lint) is the only gate.
The cloud environment has **no** `ANTHROPIC_API_KEY`, so live chat can't be
tested there — verify route plumbing with curl (bad body → 400, missing key →
500 with a helpful message).

## Known gotchas / open items

- Mirror quality is data-bound: the instruction is "full mimicry" from turn
  one, but the fingerprint is only as good as the words collected. Early
  replies are intentionally "plausibly neutral" where data is missing.
- The user-model document lags the conversation by one turn (it's regenerated
  in the background after each reply). Fine by design; the chat prompt says
  the live transcript wins over the document.
- Profile updates are fire-and-forget on the client; a failed update just
  means the next turn reuses the previous document.
- Conversation state is client-side only (full history POSTed each turn);
  nothing survives a reload. Fine for now, by design.
- `next-env.d.ts` is gitignored and regenerated by builds; don't commit it.
- Replies are prompt-constrained to be TTS-friendly (no markdown, short)
  while data is thin — but the user's own observed style overrides everything,
  by design. When wiring TTS, don't "fix" that.

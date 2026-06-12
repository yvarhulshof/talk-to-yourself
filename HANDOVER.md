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

**Branch:** all work lives on `claude/pensive-pascal-5etp7w` (repo default
branch has no commits; this branch is the only history). Develop here unless
the user says otherwise.

**Phase 1 + tuning is complete and verified** (builds clean, smoke-tested):

- Next.js 15 App Router app, TypeScript, no UI framework — hand-rolled CSS in
  `app/globals.css` (dark, serif, terracotta accent).
- Text chat with token-streamed Claude replies.
- Personality morph driven by the user's cumulative word count, in 4 levels
  (generic AI → echo style → model person → indistinguishable mirror).
- Morph-pace slider in the header: sets the word count for the final level
  (30–2000, default 700); intermediate levels at fixed ratios 1/7 and 3/7 of
  it. Sent as `morphWords` with every request; level computed client-side too
  so the meter reacts instantly.

**Not yet built:** Phases 2–4 (voice). See "Next steps" below.

## Key files

| File | What it does |
|---|---|
| `lib/persona.ts` | The heart. Mimicry levels, word counting, threshold math (`clampMorphWords`, `levelThresholds`, `mimicryLevel`), and the system prompts: `STABLE_CORE` (cached) + per-level `LEVEL_INSTRUCTIONS`. |
| `app/api/chat/route.ts` | POST `{messages, morphWords}` → streams plain-text Claude reply. Returns `X-Mimicry-Level` and `X-User-Words` headers. Lazy Anthropic client with explicit missing-key 500. |
| `app/page.tsx` | Client chat UI: streaming bubbles, morph meter, pace slider. |
| `PLAN.md` | Vendor comparison, morph mechanics, costs, build phases. |

## Decisions already made (don't relitigate without the user)

1. **No real fine-tuning anywhere.** Voice = instant voice cloning (IVC);
   persona = in-context modeling via system prompt. Rationale in PLAN.md §1.
2. **Model:** `claude-opus-4-8`, streaming, `max_tokens: 1024` (chat replies
   are deliberately short).
3. **Prompt-cache discipline:** `STABLE_CORE` must stay byte-identical across
   requests; it carries the `cache_control` breakpoint. The level instruction
   is a *separate* system block appended after it — never merge them, never
   put anything volatile (timestamps, word counts) into the system blocks.
4. **TTS vendor (Phase 2/3):** ElevenLabs Flash v2.5, WebSocket streaming;
   Starter plan ($5/mo) gates instant cloning. Cartesia is the fallback if
   earlier/iterative cloning matters more than clone quality.
5. **STT:** browser Web Speech API for v1 (free, Chrome), Deepgram Nova-3
   streaming ($0.0077/min) for production. Always record raw audio with
   MediaRecorder in parallel — the clone needs real audio, not transcripts.
6. **Indistinguishability bar (user's explicit requirement):** at the final
   level, an outside observer who knows the user must not be able to tell
   which side is real. The level-3 prompt enforces writing fingerprint,
   opinions/humor, matched knowledge boundaries, and no politeness surplus.
   If you touch the prompts, preserve all four of those pillars.
7. **Consent/ethics:** users clone only their own voice; consent checkbox
   before recording; delete clones at session end (ElevenLabs DELETE voice).

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
- Stepped morph synced to mimicry levels: stock voice → clone with high
  `stability`/low `style` (user timbre, neutral delivery) → fully expressive
  clone at level 3. PLAN.md §3b has the full scheme.
- The morph-pace slider should govern voice stages too, not just the prompt.

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

- Word-count thresholds are heuristics; the user already lowered friction once
  (slider). Expect more tuning requests.
- Mirror quality is data-bound: a low slider value reaches the level-3
  *instruction* quickly, but the fingerprint is only as good as the words
  collected. The UI doesn't communicate this yet — possible improvement.
- Conversation state is client-side only (full history POSTed each turn);
  nothing survives a reload. Fine for now, by design.
- `next-env.d.ts` is gitignored and regenerated by builds; don't commit it.
- Replies are prompt-constrained to be TTS-friendly (no markdown, short) at
  low levels — but at level 3 the user's own style overrides everything, by
  design. When wiring TTS, don't "fix" that.

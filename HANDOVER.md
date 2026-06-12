# Handover — Talk to Yourself

Context doc for the next Claude Code instance picking up this project. Read
[PLAN.md](./PLAN.md) first (full technical plan + cost analysis), then this.

## What this project is

A web app where the user talks to an AI that morphs into *them* — in
personality (full mimicry from message one, backed by an AI-maintained
user-model document) and in voice (instant voice cloning at ~60s of speech).
The end state: talking to it feels like talking to yourself.

## Current state

**Branch:** work continued on `claude/brave-galileo-7pnfze` (branched from
`claude/pensive-pascal-5etp7w`; repo default branch has no commits). Develop
here unless the user says otherwise.

**All four build phases are implemented** (builds clean, route plumbing
smoke-tested with curl; live audio not testable in the cloud env):

- Next.js 15 App Router app, TypeScript, no UI framework — hand-rolled CSS in
  `app/globals.css` (dark, serif, terracotta accent). One dependency beyond
  Next/React: `react-markdown`.
- **Persona (Phase 1):** no mimicry stages — full mimicry from the first
  message. After every completed turn the client fires `/api/profile`, which
  merges the prior user-model document with the current transcript. The
  document is injected into the chat system prompt as the volatile block,
  persists in localStorage, and is rendered (markdown) in the right-hand
  panel with "save .md" / "forget me".
- **Voice loop (Phase 2):** mic toggle (with one-time self-cloning consent
  confirm) → Web Speech API recognition (continuous, interim results; final
  utterances auto-send after a 1.2s pause) → Claude reply sentence-chunked as
  it streams into `/api/tts` (ElevenLabs Flash v2.5) → sequential playback.
- **Voice morph (Phase 3):** each utterance is recorded separately with
  MediaRecorder (clean speech segments); at ≥60s accumulated (client-side
  counter), blobs POST to `/api/voice` → ElevenLabs IVC → `voiceId`. TTS then
  uses the clone with `morphVoiceSettings(seconds)`: stability 0.9→0.5 and
  style 0.05→0.4 ramping continuously over the next 60s of collected speech.
- **Polish (Phase 4):** barge-in (recognition `speechstart` → `TtsPlayer.stop()`
  aborts fetches + playback), session persistence (messages, user-model doc,
  voiceId + seconds in localStorage; "new chat" clears just the transcript),
  clone deletion ("forget me" → DELETE `/api/voice?id=`), and a Deepgram
  push-to-talk fallback (`/api/stt`, hold-to-talk button) for browsers
  without SpeechRecognition.

## Key files

| File | What it does |
|---|---|
| `lib/persona.ts` | The heart. `CHAT_CORE` (cached, full-mimicry instruction) + user-model doc as volatile block; `PROFILE_CORE` (cached analyst prompt, merge semantics); `withTranscriptCacheBreakpoint` for incremental transcript caching. |
| `app/api/chat/route.ts` | POST `{messages, profile?}` → streams plain-text Claude reply. |
| `app/api/profile/route.ts` | POST `{messages, profile?}` → `{profile}`: merges prior document + transcript (background, non-streaming). |
| `app/api/tts/route.ts` | POST `{text, voiceId?, settings?}` → audio/mpeg. ElevenLabs Flash v2.5 proxy; called once per sentence. |
| `app/api/voice/route.ts` | POST multipart `files[]` → `{voiceId}` (ElevenLabs IVC); DELETE `?id=` removes the clone. |
| `app/api/stt/route.ts` | POST raw audio → `{transcript}` (Deepgram nova-3 pre-recorded; push-to-talk fallback only). |
| `app/voice.ts` | Client classes: `SentenceChunker`, `TtsPlayer` (ordered playback + barge-in `stop()`), `SpeechCapture` (recognition + per-utterance recording), `PushToTalkRecorder`, `morphVoiceSettings`. |
| `app/page.tsx` | Orchestration: chat UI, profile refresh, voice mode state machine, clone trigger, persistence. State mirrored into refs for the long-lived capture/player callbacks. |
| `PLAN.md` | Vendor comparison, morph mechanics, costs, build phases. |

## Decisions already made (don't relitigate without the user)

1. **No real fine-tuning anywhere.** Voice = instant voice cloning (IVC);
   persona = in-context modeling via system prompt. Rationale in PLAN.md §1.
2. **Model:** `claude-sonnet-4-6` for both calls (user switched from Opus
   2026-06-12 explicitly for cost — don't switch back without asking).
   Streaming `max_tokens: 1024` for chat; non-streaming `max_tokens: 2048`
   for the user-model document.
3. **Prompt-cache discipline:** `CHAT_CORE` and `PROFILE_CORE` must stay
   byte-identical across requests; each carries a `cache_control` breakpoint.
   The user-model document is volatile, so it lives in a *separate* system
   block appended after the cached core — never merge them. The transcript
   also gets a breakpoint on its last message (`withTranscriptCacheBreakpoint`)
   so it caches incrementally.
4. **TTS vendor:** ElevenLabs Flash v2.5 (per-sentence HTTP streaming, not
   WebSocket — simpler, latency fine at sentence granularity); Starter plan
   ($5/mo) gates instant cloning. Cartesia is the fallback if
   earlier/iterative cloning matters more than clone quality.
5. **STT:** browser Web Speech API primary (free, Chrome); Deepgram Nova-3
   *pre-recorded* as the push-to-talk fallback (Next.js route handlers can't
   proxy WebSockets, so no streaming Deepgram). Raw audio is always recorded
   with MediaRecorder in parallel — the clone needs real audio.
6. **Indistinguishability bar (user's explicit requirement):** an outside
   observer who knows the user must not be able to tell which side is real.
   The chat prompt enforces writing fingerprint, opinions/humor, matched
   knowledge boundaries, and no politeness surplus. If you touch the prompts,
   preserve all four of those pillars.
7. **Consent/ethics:** users clone only their own voice; a consent confirm
   gates the first voice-mode activation; "forget me" deletes the clone from
   ElevenLabs. (Clone deletion moved from "session end" to "forget me"
   because sessions now persist by design.)
8. **No mimicry stages (user's explicit decision, 2026-06):** full mimicry
   from message one — escalation happens naturally as transcript data grows.
   Don't reintroduce levels, word thresholds, or pace sliders. The voice morph
   is likewise a continuous ramp (`morphVoiceSettings`), not stages.

## Possible next steps (none committed)

- Real visual verification of voice mode (needs a browser + real API keys —
  the cloud env can't run audio or reach elevenlabs/deepgram/cdn hosts).
- Latency tuning: PLAN's budget is <1.5s end-of-speech → first audio; the
  1.2s utterance-debounce eats most of that. Consider endpointing smarter.
- Re-cloning at higher quality as more audio accumulates (PLAN §3b option 3).
- Server-side sessions/db if the app should work across devices.

## How to run / verify

```sh
cp .env.example .env.local   # ANTHROPIC_API_KEY required; ELEVENLABS_API_KEY for voice; DEEPGRAM_API_KEY optional
npm install
npm run build                # must pass — this is the regression gate
npm run dev                  # http://localhost:3000
```

There are no tests yet; `npm run build` (type-check + lint) is the only gate.
The cloud environment has **no API keys** and blocks egress to
api.elevenlabs.io / api.deepgram.com, so live behavior can't be tested there —
verify route plumbing with curl (bad body → 400, missing key → 500, upstream
failure → 502 with a helpful message).

## Known gotchas / open items

- Mirror quality is data-bound: the instruction is "full mimicry" from turn
  one, but the fingerprint is only as good as the words collected. Early
  replies are intentionally "plausibly neutral" where data is missing.
- The user-model document lags the conversation by one turn (regenerated in
  the background after each reply). Fine by design; the chat prompt says the
  live transcript wins over the document.
- Profile updates are fire-and-forget; a failed update means the next turn
  reuses the previous document.
- Voice-clone audio blobs live only in memory — a reload before the 60s
  threshold restarts audio accumulation (the seconds counter is only
  persisted once a clone exists, deliberately, so the counter and the blobs
  can't disagree).
- Echo: `getUserMedia` is opened with `echoCancellation: true` so the mic
  doesn't transcribe the AI's own TTS. If users report the AI "hearing
  itself", that's the knob (or pause recognition while `speaking`).
- Web Speech API recognition silently stops after silence; `SpeechCapture`
  restarts it in `onend`. Don't remove that loop.
- `next-env.d.ts` is gitignored and regenerated by builds; don't commit it.
- Replies are prompt-constrained to be TTS-friendly (no markdown, short)
  while data is thin — but the user's own observed style overrides
  everything, by design. Don't "fix" that.

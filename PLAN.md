# Talk to Yourself — Technical Plan

A web app where you talk to an AI that starts as a generic assistant and gradually
morphs into *you* — in voice and in personality — as the conversation provides more
data about you.

---

## 1. The two "fine-tuning" ideas, and what's actually feasible

Neither the voice nor the personality side should use literal fine-tuning. Both have
much cheaper, faster, and technically superior alternatives:

| Idea as stated | Feasible approach | Why |
|---|---|---|
| "Fine-tune the TTS on the user's voice" | **Instant voice cloning (IVC)** — zero-shot cloning from a short audio sample | Real fine-tuning of a TTS model takes hours of audio + training time and is only offered as "professional cloning" (slow, sometimes requiring identity verification). IVC produces a usable clone from **3 seconds (Cartesia) to ~1 minute (ElevenLabs)** of audio, created via a single API call in seconds — perfect for mid-conversation switching. |
| "Fine-tune the LLM on what the user says" | **In-context persona modeling** — exactly the system-prompt approach described in the idea | LLM fine-tuning needs thousands of examples and a training job; it cannot happen live during one conversation. A frontier model given the running transcript plus an instruction to model and imitate the user does this far better, updates every turn, and costs fractions of a cent. No fine-tuning API exists for Claude anyway. |

So the user-facing behavior is achievable, and the architecture is "three streaming
APIs glued together," not a training pipeline.

## 2. Architecture

```
Browser                          Server (Node/Next.js API routes)
───────                          ────────────────────────────────
mic (MediaRecorder /         →   STT: Deepgram streaming WebSocket
 getUserMedia)                       (or free browser Web Speech API in v1)
                                          │ transcript (user turn)
                                          ▼
                                 LLM: Claude (claude-sonnet-4-6)
                                     system prompt = persona-morph prompt
                                     + full transcript (prompt-cached)
                                          │ reply text (streamed)
                                          ▼
audio playback (Web Audio)   ←   TTS: ElevenLabs (or Cartesia)
                                     voice_id = stock voice → user's clone

                                 Side channel (async, non-blocking):
                                 - accumulate raw user audio chunks
                                 - word counter on user transcript
                                 - when threshold hit → POST audio to
                                   ElevenLabs IVC endpoint → new voice_id
```

**Stack:** Next.js (App Router) single deployable app. API keys live server-side
only; the browser talks to our API routes, never to vendors directly. State for a
session: transcript array, the user-model document, accumulated user-audio
buffer, current `voice_id`. No database needed for v1 (in-memory / session
storage); add persistence later if conversations should survive reloads.

## 3. The morph mechanics

### 3a. Personality morph (LLM)

**No staged escalation.** (Earlier versions of this plan had 4 word-count-driven
mimicry levels; the user removed them — mimicry deepens naturally as the
transcript grows, so the staging added logic without adding behavior.) The chat
prompt instructs full mimicry from the first message: mirror the user as
accurately as the conversation so far allows, staying plausibly neutral where
data is missing.

Two Claude calls per turn:

1. **Chat call** — system prompt = stable mimicry core + the current
   **user-model document**, messages = full transcript, reply streamed.
2. **User-model call** (background, after each completed turn) — regenerates a
   document capturing everything inferable about the person: facts/background,
   personality and psychology, values and opinions, interests, likes/dislikes,
   humor, knowledge/vocabulary boundaries, and the writing-style fingerprint
   with verbatim examples. The document feeds the next chat call. With prompt
   caching the transcript re-read is ~0.1× price, so per-turn regeneration is
   affordable.

Implementation details:
- The volatile user-model document is appended **after** the stable system-prompt
  core so prompt caching keeps working (cache breakpoint on the stable core;
  transcript is the messages array and caches incrementally per turn).
- Model: `claude-sonnet-4-6` (chosen for cost — ≈40% cheaper than Opus, still
  strong at persona inference; the user explicitly downgraded from Opus).
- Streaming responses, sentence-chunked into the TTS as they arrive, to keep
  voice latency low.

### 3b. Voice morph (TTS)

Gradual *acoustic* morphing between two voices is not something the commercial APIs
support natively — there is no "70% you" knob. The feasible options, in order of
recommendation:

1. **Stepped switch (recommended, works on both vendors):**
   - Phase A: stock voice.
   - Phase B (enough audio collected): create the instant clone, but keep
     "assistant-like" delivery — on ElevenLabs, set high `stability` / low `style`
     so it sounds like the user's timbre with neutral prosody.
   - Phase C: relax the voice settings toward natural/expressive — now it both
     sounds and talks like the user.
   This gives a perceptual 3-step morph without any unsupported audio DSP.
2. **All-at-once switch:** simplest fallback — swap `voice_id` once the clone is
   ready, ideally at a dramatically appropriate moment ("…you sound different" is
   actually a feature here).
3. **Re-cloning at increasing quality:** Cartesia clones from 3–10 s, so you can
   create a rough clone very early and **re-clone with more audio** every minute or
   two — each clone is noticeably better, which itself reads as gradual morphing.

Threshold to trigger cloning: ~60 seconds of accumulated clean user audio
(ElevenLabs guidance: 1–2 minutes; Cartesia: usable from 3–10 s). The word counter
and audio-duration counter run together; clone creation happens in the background
and swaps in on the next turn.

### 3c. Vendor choice for TTS + cloning

| | **ElevenLabs** (recommended) | **Cartesia Sonic** (alternative) |
|---|---|---|
| Instant clone input | ~1 min audio | 3–10 s audio |
| Clone quality | Best-in-class | Good, improving with more audio |
| TTS latency | Flash v2.5 ~75 ms, WebSocket streaming | ~90 ms, built for realtime |
| TTS price | ~$0.05/1k chars (Flash) | ~$0.03/min |
| Cloning plan gate | Starter, $5/mo | Pro, $5/mo |
| Voice settings for the "stepped morph" | Yes (stability/style/similarity) | Limited |

Recommendation: **ElevenLabs Flash v2.5** — best clone fidelity (the "wow" moment
of the app) plus the voice-settings knobs that make the stepped morph possible.
Cartesia is the swap-in if earlier morphing (3 s clones, iterative re-cloning)
matters more than peak quality.

### 3d. STT

- **v1 (free, fastest to build):** browser Web Speech API (`SpeechRecognition`).
  $0, streaming, but Chrome-only and no raw-audio guarantees — we still record raw
  audio with MediaRecorder in parallel for cloning.
- **v2 (production):** Deepgram Nova-3 streaming — $0.0077/min, ~200–400 ms finals,
  works in every browser since audio goes through our server.

## 4. Costs

### Per-conversation marginal cost (10-minute conversation, ~20 turns, ~5 min of AI speech)

| Component | Assumption | Cost |
|---|---|---|
| LLM — Claude Sonnet 4.6 ($3/MTok in, $15/MTok out) | ~60k cumulative input tokens (mostly cache reads at ~0.1×), ~3k output | **$0.06–0.15** |
| LLM — if Opus 4.8 instead ($5/$25) | same shape | $0.10–0.25 |
| TTS — ElevenLabs Flash ($0.05/1k chars) | ~5 min speech ≈ 3,800 chars | **~$0.19** |
| TTS — if Cartesia (~$0.03/min) | 5 min | ~$0.15 |
| STT — Deepgram streaming ($0.0077/min) | 10 min | **~$0.08** |
| STT — if Web Speech API | — | $0.00 |
| Voice clone creation | 1 IVC call | $0 (included in plan) |
| **Total per 10-min session** | | **≈ $0.25–0.50** |

TTS dominates. The LLM is nearly free at this scale thanks to prompt caching
(the transcript is a perfect incremental cache).

### Fixed monthly

| | |
|---|---|
| ElevenLabs Starter (IVC + 30k credits ≈ ~30 min speech) | $5/mo |
| Anthropic API | pay-as-you-go, no minimum |
| Deepgram | pay-as-you-go ($200 free credit at signup) |
| **Floor for a working demo** | **$5/mo + pennies per conversation** |

### Cheapest possible v1 (~$5/mo total)

Web Speech API for STT ($0) + ElevenLabs Starter ($5) + Claude pay-as-you-go
(< $0.25/conversation). Good enough to validate the whole experience.

## 5. Build phases

1. **Phase 1 — Text skeleton.** Next.js app, chat UI, Claude with the full-mimicry
   persona prompt plus the per-turn user-model document. Proves the personality
   morph with zero audio complexity.
2. **Phase 2 — Voice loop.** Mic capture, Web Speech API STT, ElevenLabs streaming
   TTS on a stock voice. Proves the latency budget (target < 1.5 s end of user
   speech → first AI audio).
3. **Phase 3 — The morph.** Background audio accumulation, IVC creation at the
   threshold, voice_id swap + voice-settings ramp as the clone matures.
4. **Phase 4 — Polish.** Deepgram STT, interruption handling (stop TTS when user
   speaks), session persistence, a visual "morph meter" so the user can watch the
   AI become them.

## 6. Risks & notes

- **Consent/ethics:** users clone only their *own* voice; add an explicit consent
  checkbox before recording, and delete clones (ElevenLabs DELETE voice endpoint)
  when the session ends. Vendors' ToS require the speaker's consent — for this app
  that's inherently satisfied, but state it in the UI.
- **Clone quality depends on mic quality:** prompt the user to use headphones/quiet
  room; accumulate only speech segments (skip silence) for the clone sample.
- **Latency stacking:** STT finalization + LLM first token + TTS first byte must
  stay under ~1.5 s; everything must stream (this rules out batch Whisper).
- **Anthropic safety:** impersonation prompts of *the user themself, at the user's
  request* are fine, but keep the system prompt explicit that this is a consensual
  self-mirroring experience.

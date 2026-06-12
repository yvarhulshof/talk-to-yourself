# Talk to Yourself

A web app where you talk to an AI that starts as a generic assistant and
gradually morphs into *you* — first in personality, later in voice — as the
conversation provides more data about you.

See [PLAN.md](./PLAN.md) for the full technical plan and cost analysis.

## Status

- ✅ **Phase 1 — text skeleton**: chat UI, streaming Claude responses, mimicry
  level escalating with your word count (watch the morph meter).
- ⬜ Phase 2 — voice loop (mic → STT → TTS on a stock voice)
- ⬜ Phase 3 — the voice morph (instant voice cloning of the user)
- ⬜ Phase 4 — polish (Deepgram STT, interruptions, persistence)

## Run it

```sh
cp .env.example .env.local   # add your ANTHROPIC_API_KEY
npm install
npm run dev                  # http://localhost:3000
```

## How the personality morph works

The server counts how many words you've said across the conversation and maps
that to a mimicry level (`lib/persona.ts`):

| Level | Trigger (default) | Behavior |
|---|---|---|
| 0 | start | generic, curious assistant |
| 1 | 100 words | mirrors your surface writing style (length, casing, punctuation, slang) |
| 2 | 300 words | builds a model of you; half assistant, half you |
| 3 | 700 words | indistinguishable — full writing fingerprint, opinions, humor, and knowledge boundaries |

The pace is tunable with the slider in the header: it sets the word count for
the final level (30–2000, default 700) and the intermediate levels scale
proportionally. The value is sent with each request, so you can speed up or
slow down the morph mid-conversation.

Each chat turn sends the whole transcript to Claude (`claude-opus-4-8`) with a
stable cached system prompt plus the current level's instruction. Replies are
written for speech (short, no markdown) so Phase 2 can pipe them straight into
TTS.

# Talk to Yourself

A web app where you talk to an AI that starts as a generic assistant and
gradually morphs into *you* — first in personality, later in voice — as the
conversation provides more data about you.

See [PLAN.md](./PLAN.md) for the full technical plan and cost analysis.

## Status

- ✅ **Phase 1 — text skeleton**: chat UI, streaming Claude responses, full
  mimicry from the first message, backed by an AI-maintained model of you.
- ⬜ Phase 2 — voice loop (mic → STT → TTS on a stock voice)
- ⬜ Phase 3 — the voice morph (instant voice cloning of the user)
- ⬜ Phase 4 — polish (Deepgram STT, interruptions, persistence)

## Run it

```sh
cp .env.example .env.local   # add your ANTHROPIC_API_KEY
npm install
npm run dev                  # http://localhost:3000
```

## How the personality mirror works

There are no stages: from your first message the AI is instructed to mirror
you as accurately as the transcript allows — writing fingerprint, opinions,
humor, knowledge boundaries. Fidelity grows naturally as you say more, because
there's simply more of you to model.

Two Claude calls per turn (`claude-opus-4-8`, transcript prompt-cached
incrementally):

1. **Chat** (`/api/chat`): whole transcript + a stable cached system prompt +
   the current *user model* document, streamed back as the reply.
2. **User model** (`/api/profile`, fired in the background after each reply):
   regenerates a document describing everything the AI can infer about you —
   facts, personality and psychology, values, interests, likes/dislikes,
   humor, knowledge boundaries, writing-style fingerprint with verbatim
   examples. That document feeds the next chat turn. You can peek at it via
   "its model of you" in the header.

Replies are written for speech (short, no markdown) until your own style takes
over, so Phase 2 can pipe them straight into TTS.

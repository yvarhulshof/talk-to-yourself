# Talk to Yourself

A web app where you talk to an AI that starts as a generic assistant and
morphs into *you* — in personality and in voice — as the conversation provides
more data about you.

See [PLAN.md](./PLAN.md) for the full technical plan and cost analysis.

## Status

- ✅ **Phase 1 — text skeleton**: chat UI, streaming Claude responses, full
  mimicry from the first message, backed by an AI-maintained model of you.
- ✅ **Phase 2 — voice loop**: mic capture, Web Speech API STT, sentence-chunked
  ElevenLabs TTS streamed as the reply arrives.
- ✅ **Phase 3 — the voice morph**: your speech accumulates per utterance; at
  ~60s an instant clone of your voice is created and the AI starts speaking in
  it — neutral at first, ramping to fully expressive as more audio comes in.
- ✅ **Phase 4 — polish**: barge-in (talking interrupts the AI), session
  persistence (conversation + model + clone survive reloads), clone deletion
  via "forget me", and a Deepgram push-to-talk fallback for non-Chrome
  browsers.

## Run it

```sh
cp .env.example .env.local   # fill in the keys (see below)
npm install
npm run dev                  # http://localhost:3000
```

| Env var | Needed for |
|---|---|
| `ANTHROPIC_API_KEY` | chat + the user-model document (required) |
| `ELEVENLABS_API_KEY` | TTS + instant voice cloning (required for voice; Starter plan gates cloning) |
| `ELEVENLABS_STOCK_VOICE_ID` | optional — stock voice before your clone exists (default: Rachel) |
| `DEEPGRAM_API_KEY` | optional — push-to-talk STT fallback for browsers without the Web Speech API |

Text chat works with just the Anthropic key. Voice mode wants Chrome (free
Web Speech API STT); elsewhere it falls back to hold-to-talk via Deepgram.

## How the personality mirror works

There are no stages: from your first message the AI is instructed to mirror
you as accurately as the transcript allows — writing fingerprint, opinions,
humor, knowledge boundaries. Fidelity grows naturally as you say more, because
there's simply more of you to model.

Two Claude calls per turn (`claude-sonnet-4-6`, transcript prompt-cached
incrementally):

1. **Chat** (`/api/chat`): whole transcript + a stable cached system prompt +
   the current *user model* document, streamed back as the reply.
2. **User model** (`/api/profile`, fired in the background after each reply):
   updates a document describing everything the AI can infer about you —
   facts, personality and psychology, values, interests, likes/dislikes,
   humor, knowledge boundaries, writing-style fingerprint with verbatim
   examples — by merging the prior document with the current transcript.
   That document feeds the next chat turn.

The document is the app's **memory**: it's saved in your browser
(localStorage) and survives across conversations, so a fresh chat starts
already knowing you. It's rendered in the right-hand panel, where you can
download it as markdown ("save .md") or erase it ("forget me" — which also
deletes your voice clone from ElevenLabs).

## How the voice morph works

Turn on voice mode (mic button; you'll be asked to consent to cloning your
own voice). While you talk:

- The Web Speech API transcribes you live; finalized utterances are sent to
  the chat automatically after a short pause.
- In parallel, each utterance is recorded with MediaRecorder — clean speech
  segments, no silence.
- The Claude reply is split into sentences as it streams and piped through
  ElevenLabs Flash v2.5 (`/api/tts`), played back in order. Speaking while it
  talks stops the audio (barge-in).
- At ~60 seconds of accumulated speech, the recordings are POSTed to
  ElevenLabs instant voice cloning (`/api/voice`) and the reply voice swaps
  from the stock voice to *yours* — with high stability/low style at first
  (your timbre, neutral delivery), relaxing continuously toward fully
  expressive as more of your audio accumulates. By then the persona prompt has
  data too: it sounds like you and talks like you.

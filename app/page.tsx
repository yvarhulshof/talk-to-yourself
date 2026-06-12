"use client";

import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import {
  CLONE_THRESHOLD_SECONDS,
  PushToTalkRecorder,
  SentenceChunker,
  SpeechCapture,
  TtsPlayer,
  morphVoiceSettings,
  speechRecognitionSupported,
} from "./voice";

type ChatMessage = { role: "user" | "assistant"; content: string };

// localStorage keys — the app's cross-conversation memory.
const PROFILE_KEY = "talk-to-yourself:user-model";
const MESSAGES_KEY = "talk-to-yourself:messages";
const VOICE_KEY = "talk-to-yourself:voice"; // { voiceId, seconds }
const CONSENT_KEY = "talk-to-yourself:voice-consent";

const CONSENT_TEXT =
  "Voice mode records your microphone so the AI can (1) transcribe what you say and " +
  "(2) after ~60 seconds of speech, create an instant clone of YOUR OWN voice, which it " +
  "then speaks in. The clone is deleted when you press “forget me”. " +
  "Only clone your own voice. OK?";

export default function Home() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [profile, setProfile] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Voice state
  const [voiceMode, setVoiceMode] = useState(false);
  const [sttSupported, setSttSupported] = useState(true);
  const [speaking, setSpeaking] = useState(false);
  const [interim, setInterim] = useState("");
  const [pendingText, setPendingText] = useState("");
  const [voiceId, setVoiceId] = useState<string | null>(null);
  const [voiceSeconds, setVoiceSeconds] = useState(0);
  const [cloning, setCloning] = useState(false);
  const [holding, setHolding] = useState(false);

  const bottomRef = useRef<HTMLDivElement>(null);
  const profileTurn = useRef(0);

  // Mirrors for use inside long-lived callbacks (capture/player handlers).
  const messagesRef = useRef<ChatMessage[]>([]);
  const profileRef = useRef<string | null>(null);
  const busyRef = useRef(false);
  const voiceModeRef = useRef(false);
  const voiceIdRef = useRef<string | null>(null);
  const voiceSecondsRef = useRef(0);
  const cloningRef = useRef(false);
  const pendingRef = useRef("");
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const captureRef = useRef<SpeechCapture | null>(null);
  const playerRef = useRef<TtsPlayer | null>(null);
  const pttRef = useRef<PushToTalkRecorder | null>(null);
  const utteranceBlobsRef = useRef<Blob[]>([]);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);
  useEffect(() => {
    profileRef.current = profile;
  }, [profile]);

  // Restore persisted state on mount.
  useEffect(() => {
    setSttSupported(speechRecognitionSupported());
    const savedProfile = localStorage.getItem(PROFILE_KEY);
    if (savedProfile) setProfile(savedProfile);
    try {
      const savedMessages = JSON.parse(localStorage.getItem(MESSAGES_KEY) ?? "[]");
      if (Array.isArray(savedMessages) && savedMessages.length) {
        setMessages(savedMessages);
      }
    } catch {
      /* corrupt — start fresh */
    }
    try {
      const voice = JSON.parse(localStorage.getItem(VOICE_KEY) ?? "null");
      if (voice?.voiceId) {
        setVoiceId(voice.voiceId);
        voiceIdRef.current = voice.voiceId;
        const seconds = Number(voice.seconds) || 0;
        setVoiceSeconds(seconds);
        voiceSecondsRef.current = seconds;
      }
    } catch {
      /* ignore */
    }
    return () => {
      captureRef.current?.stop();
      playerRef.current?.stop();
    };
  }, []);

  // Persist the conversation (skip mid-stream churn).
  useEffect(() => {
    if (!busy) localStorage.setItem(MESSAGES_KEY, JSON.stringify(messages));
  }, [messages, busy]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  function getPlayer(): TtsPlayer {
    if (!playerRef.current) playerRef.current = new TtsPlayer(setSpeaking);
    return playerRef.current;
  }

  function persistVoice() {
    localStorage.setItem(
      VOICE_KEY,
      JSON.stringify({ voiceId: voiceIdRef.current, seconds: voiceSecondsRef.current }),
    );
  }

  // ---------- user-model document ----------

  function refreshProfile(history: ChatMessage[], prior: string | null) {
    const turn = ++profileTurn.current;
    fetch("/api/profile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: history, profile: prior }),
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.profile && profileTurn.current === turn) {
          setProfile(data.profile);
          localStorage.setItem(PROFILE_KEY, data.profile);
        }
      })
      .catch(() => {});
  }

  function downloadProfile() {
    if (!profile) return;
    const blob = new Blob([profile], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "model-of-you.md";
    a.click();
    URL.revokeObjectURL(url);
  }

  async function forgetEverything() {
    if (!profile && !voiceId) return;
    const ok = window.confirm(
      "Delete its model of you AND your voice clone? This erases what it has learned across all conversations.",
    );
    if (!ok) return;
    localStorage.removeItem(PROFILE_KEY);
    setProfile(null);
    if (voiceIdRef.current) {
      fetch(`/api/voice?id=${voiceIdRef.current}`, { method: "DELETE" }).catch(() => {});
    }
    voiceIdRef.current = null;
    voiceSecondsRef.current = 0;
    utteranceBlobsRef.current = [];
    setVoiceId(null);
    setVoiceSeconds(0);
    localStorage.removeItem(VOICE_KEY);
  }

  function newChat() {
    playerRef.current?.stop();
    pendingRef.current = "";
    setPendingText("");
    setMessages([]);
    localStorage.removeItem(MESSAGES_KEY);
  }

  // ---------- voice clone (Phase 3) ----------

  function handleUtterance(blob: Blob, seconds: number) {
    utteranceBlobsRef.current.push(blob);
    voiceSecondsRef.current += seconds;
    setVoiceSeconds(voiceSecondsRef.current);
    if (voiceIdRef.current) persistVoice();
    void maybeClone();
  }

  async function maybeClone() {
    if (
      voiceIdRef.current ||
      cloningRef.current ||
      voiceSecondsRef.current < CLONE_THRESHOLD_SECONDS
    ) {
      return;
    }
    cloningRef.current = true;
    setCloning(true);
    try {
      const form = new FormData();
      utteranceBlobsRef.current
        .slice(-25)
        .forEach((b, i) => form.append("files", b, `utterance-${i}.webm`));
      const res = await fetch("/api/voice", { method: "POST", body: form });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.voiceId) {
        throw new Error(data?.error ?? `clone failed (${res.status})`);
      }
      voiceIdRef.current = data.voiceId;
      setVoiceId(data.voiceId);
      persistVoice();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Voice clone failed.");
      // Allow a retry on the next utterance.
    } finally {
      cloningRef.current = false;
      setCloning(false);
    }
  }

  // ---------- sending ----------

  async function sendText(text: string) {
    if (!text || busyRef.current) return;

    setError(null);
    setBusy(true);
    busyRef.current = true;
    playerRef.current?.stop(); // a new turn supersedes whatever was playing

    const history: ChatMessage[] = [
      ...messagesRef.current,
      { role: "user", content: text },
    ];
    setMessages([...history, { role: "assistant", content: "" }]);

    const speak = voiceModeRef.current;
    const chunker = speak ? new SentenceChunker() : null;
    const speakPiece = (piece: string) => {
      getPlayer().enqueue(
        piece,
        voiceIdRef.current,
        voiceIdRef.current ? morphVoiceSettings(voiceSecondsRef.current) : null,
      );
    };

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: history, profile: profileRef.current }),
      });
      if (!res.ok || !res.body) {
        throw new Error(`Request failed (${res.status})`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let assistant = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const delta = decoder.decode(value, { stream: true });
        assistant += delta;
        setMessages([...history, { role: "assistant", content: assistant }]);
        if (chunker) chunker.push(delta).forEach(speakPiece);
      }
      if (chunker) {
        const rest = chunker.flush();
        if (rest) speakPiece(rest);
      }

      refreshProfile(
        [...history, { role: "assistant", content: assistant }],
        profileRef.current,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setMessages(history);
    } finally {
      setBusy(false);
      busyRef.current = false;
      // A voice utterance may have arrived while we were replying.
      if (pendingRef.current) scheduleFlush(300);
    }
  }

  function send(e?: React.FormEvent) {
    e?.preventDefault();
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    void sendText(text);
  }

  // ---------- voice input ----------

  function scheduleFlush(delay = 1200) {
    if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
    flushTimerRef.current = setTimeout(() => {
      if (!pendingRef.current || busyRef.current) return;
      const text = pendingRef.current.trim();
      pendingRef.current = "";
      setPendingText("");
      void sendText(text);
    }, delay);
  }

  function queueVoiceText(text: string) {
    pendingRef.current = `${pendingRef.current} ${text}`.trim();
    setPendingText(pendingRef.current);
    scheduleFlush();
  }

  async function toggleVoice() {
    if (voiceMode) {
      voiceModeRef.current = false;
      setVoiceMode(false);
      captureRef.current?.stop();
      captureRef.current = null;
      playerRef.current?.stop();
      setInterim("");
      pendingRef.current = "";
      setPendingText("");
      return;
    }

    if (!localStorage.getItem(CONSENT_KEY)) {
      if (!window.confirm(CONSENT_TEXT)) return;
      localStorage.setItem(CONSENT_KEY, "1");
    }

    setError(null);
    if (speechRecognitionSupported()) {
      const capture = new SpeechCapture({
        onFinal: queueVoiceText,
        onInterim: setInterim,
        onSpeechStart: () => playerRef.current?.stop(), // barge-in
        onUtterance: handleUtterance,
        onError: setError,
      });
      try {
        await capture.start();
      } catch {
        setError("Microphone access denied — voice mode needs the mic.");
        return;
      }
      captureRef.current = capture;
    }
    // Without SpeechRecognition, voice mode = hold-to-talk + spoken replies.
    voiceModeRef.current = true;
    setVoiceMode(true);
  }

  async function pttDown() {
    if (holding) return;
    setHolding(true);
    playerRef.current?.stop(); // barge-in
    const rec = new PushToTalkRecorder();
    try {
      await rec.start();
      pttRef.current = rec;
    } catch {
      setHolding(false);
      setError("Microphone access denied — voice mode needs the mic.");
    }
  }

  async function pttUp() {
    if (!pttRef.current) {
      setHolding(false);
      return;
    }
    const rec = pttRef.current;
    pttRef.current = null;
    setHolding(false);
    const result = await rec.stop();
    if (!result) return;
    handleUtterance(result.blob, result.seconds);
    try {
      const res = await fetch("/api/stt", {
        method: "POST",
        headers: { "Content-Type": result.blob.type || "audio/webm" },
        body: result.blob,
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? `STT failed (${res.status})`);
      if (data?.transcript) {
        queueVoiceText(data.transcript);
        scheduleFlush(200);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Transcription failed.");
    }
  }

  // ---------- render ----------

  const liveText = [pendingText, interim].filter(Boolean).join(" ");
  const cloneLabel = voiceId
    ? "speaking in your voice"
    : cloning
      ? "cloning your voice…"
      : `your voice: ${Math.min(CLONE_THRESHOLD_SECONDS, Math.round(voiceSeconds))}s / ${CLONE_THRESHOLD_SECONDS}s collected`;

  return (
    <main className="shell">
      <header className="top">
        <h1>Talk to Yourself</h1>
        <button type="button" className="ghost" onClick={newChat} disabled={busy || !messages.length}>
          new chat
        </button>
      </header>

      <div className="columns">
        <section className="chat">
          <div className="messages">
            {messages.length === 0 && (
              <p className="empty-hint">
                {profile
                  ? "It remembers you. Start talking — it picks up where its model of you left off."
                  : "Start talking. From your first words it starts modeling you — the more you say, the more it becomes you."}
              </p>
            )}
            {messages.map((m, i) => (
              <div
                key={i}
                className={`bubble ${m.role}${
                  busy && i === messages.length - 1 && m.role === "assistant"
                    ? " pending"
                    : ""
                }`}
              >
                {m.content}
              </div>
            ))}
            <div ref={bottomRef} />
          </div>

          {error && <div className="error">{error}</div>}

          {voiceMode && (
            <div className="voice-status">
              <span className={`voice-dot${speaking ? " speaking" : ""}`} />
              <span className="voice-live">
                {liveText ||
                  (speaking
                    ? "speaking — talk to interrupt"
                    : sttSupported
                      ? "listening…"
                      : "hold the button to talk")}
              </span>
              <span className="voice-clone">{cloneLabel}</span>
            </div>
          )}

          <form className="composer" onSubmit={send}>
            <button
              type="button"
              className={`mic${voiceMode ? " on" : ""}`}
              onClick={toggleVoice}
              title={voiceMode ? "Turn voice off" : "Turn voice on"}
            >
              {voiceMode ? "voice on" : "voice"}
            </button>
            {voiceMode && !sttSupported && (
              <button
                type="button"
                className={`ptt${holding ? " holding" : ""}`}
                onMouseDown={pttDown}
                onMouseUp={pttUp}
                onMouseLeave={() => holding && pttUp()}
                onTouchStart={(e) => {
                  e.preventDefault();
                  pttDown();
                }}
                onTouchEnd={(e) => {
                  e.preventDefault();
                  pttUp();
                }}
              >
                {holding ? "release to send" : "hold to talk"}
              </button>
            )}
            <textarea
              rows={2}
              value={input}
              placeholder="Say something…"
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
            />
            <button type="submit" disabled={busy || !input.trim()}>
              Send
            </button>
          </form>
        </section>

        <aside className="model">
          <div className="model-head">
            <span className="model-title">its model of you</span>
            <div className="model-actions">
              <button type="button" onClick={downloadProfile} disabled={!profile}>
                save .md
              </button>
              <button
                type="button"
                onClick={forgetEverything}
                disabled={!profile && !voiceId}
              >
                forget me
              </button>
            </div>
          </div>
          <div className="model-body">
            {profile ? (
              <ReactMarkdown>{profile}</ReactMarkdown>
            ) : (
              <p className="model-empty">
                Nothing yet — it writes its model of you after your first
                exchange, and remembers it across conversations.
              </p>
            )}
          </div>
        </aside>
      </div>
    </main>
  );
}

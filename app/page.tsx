"use client";

import { useEffect, useRef, useState } from "react";
import {
  DEFAULT_MORPH_WORDS,
  MAX_MORPH_WORDS,
  MIMICRY_LEVELS,
  MIN_MORPH_WORDS,
  levelThresholds,
  mimicryLevel,
} from "@/lib/persona";

type ChatMessage = { role: "user" | "assistant"; content: string };

export default function Home() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [words, setWords] = useState(0);
  const [morphWords, setMorphWords] = useState(DEFAULT_MORPH_WORDS);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function send(e?: React.FormEvent) {
    e?.preventDefault();
    const text = input.trim();
    if (!text || busy) return;

    setError(null);
    setInput("");
    setBusy(true);

    const history: ChatMessage[] = [...messages, { role: "user", content: text }];
    // Optimistic user bubble + empty assistant bubble that fills as we stream.
    setMessages([...history, { role: "assistant", content: "" }]);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: history, morphWords }),
      });
      if (!res.ok || !res.body) {
        throw new Error(`Request failed (${res.status})`);
      }

      setWords(Number(res.headers.get("X-User-Words") ?? 0));

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let assistant = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        assistant += decoder.decode(value, { stream: true });
        setMessages([...history, { role: "assistant", content: assistant }]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      // Drop the empty assistant bubble, keep the user's message.
      setMessages(history);
    } finally {
      setBusy(false);
    }
  }

  // Computed client-side so the meter reacts immediately to slider changes.
  const level = mimicryLevel(words, morphWords);
  const levelLabel = MIMICRY_LEVELS.find((l) => l.level === level)?.label ?? "";
  const progress = Math.min(100, Math.round((words / morphWords) * 100));
  const [, t1, t2, t3] = levelThresholds(morphWords);

  return (
    <main className="shell">
      <header className="top">
        <h1>Talk to Yourself</h1>
        <div className="morph-meter">
          <span>morph</span>
          <div className="morph-track">
            <div className="morph-fill" style={{ width: `${progress}%` }} />
          </div>
          <span className="morph-label">{levelLabel}</span>
        </div>
        <div className="morph-tuner">
          <input
            type="range"
            min={MIN_MORPH_WORDS}
            max={MAX_MORPH_WORDS}
            step={10}
            value={morphWords}
            onChange={(e) => setMorphWords(Number(e.target.value))}
            aria-label="Words needed to reach full mirror"
          />
          <span>
            morph pace: levels at {t1} / {t2} / {t3} of your words ({words} so
            far)
          </span>
        </div>
      </header>

      <div className="messages">
        {messages.length === 0 && (
          <p className="empty-hint">
            Start talking. It begins as a stranger — the more you say, the more
            it becomes you.
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

      <form className="composer" onSubmit={send}>
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
    </main>
  );
}

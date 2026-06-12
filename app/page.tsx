"use client";

import { useEffect, useRef, useState } from "react";

type ChatMessage = { role: "user" | "assistant"; content: string };

export default function Home() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [profile, setProfile] = useState<string | null>(null);
  const [showProfile, setShowProfile] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const profileTurn = useRef(0);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Fire-and-forget: regenerate the user-model document from the full
  // transcript. If it fails or a newer turn finishes first, the next chat
  // request simply reuses the previous document.
  function refreshProfile(history: ChatMessage[]) {
    const turn = ++profileTurn.current;
    fetch("/api/profile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: history }),
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.profile && profileTurn.current === turn) {
          setProfile(data.profile);
        }
      })
      .catch(() => {});
  }

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
        body: JSON.stringify({ messages: history, profile }),
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
        assistant += decoder.decode(value, { stream: true });
        setMessages([...history, { role: "assistant", content: assistant }]);
      }

      refreshProfile([...history, { role: "assistant", content: assistant }]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      // Drop the empty assistant bubble, keep the user's message.
      setMessages(history);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="shell">
      <header className="top">
        <div className="top-row">
          <h1>Talk to Yourself</h1>
          <button
            type="button"
            className="profile-toggle"
            onClick={() => setShowProfile((v) => !v)}
          >
            {showProfile ? "hide its model of you" : "its model of you"}
          </button>
        </div>
        {showProfile && (
          <div className="profile-panel">
            {profile ??
              "Nothing yet — it writes its model of you after your first exchange."}
          </div>
        )}
      </header>

      <div className="messages">
        {messages.length === 0 && (
          <p className="empty-hint">
            Start talking. From your first words it starts modeling you — the
            more you say, the more it becomes you.
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

"use client";

import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";

type ChatMessage = { role: "user" | "assistant"; content: string };

// The user-model document persists across conversations: this is the app's
// long-term memory of the person.
const PROFILE_STORAGE_KEY = "talk-to-yourself:user-model";

export default function Home() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [profile, setProfile] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const profileTurn = useRef(0);

  useEffect(() => {
    const saved = localStorage.getItem(PROFILE_STORAGE_KEY);
    if (saved) setProfile(saved);
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Fire-and-forget: merge the current transcript into the user-model
  // document. If it fails or a newer turn finishes first, the next chat
  // request simply reuses the previous document.
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
          localStorage.setItem(PROFILE_STORAGE_KEY, data.profile);
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

  function forgetProfile() {
    if (!profile) return;
    if (!window.confirm("Delete its model of you? This erases what it has learned across all conversations.")) {
      return;
    }
    localStorage.removeItem(PROFILE_STORAGE_KEY);
    setProfile(null);
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

      refreshProfile([...history, { role: "assistant", content: assistant }], profile);
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
        <h1>Talk to Yourself</h1>
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
        </section>

        <aside className="model">
          <div className="model-head">
            <span className="model-title">its model of you</span>
            <div className="model-actions">
              <button type="button" onClick={downloadProfile} disabled={!profile}>
                save .md
              </button>
              <button type="button" onClick={forgetProfile} disabled={!profile}>
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

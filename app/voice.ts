"use client";

/**
 * Client-side voice machinery for Phases 2-4:
 * - SentenceChunker: splits the streaming Claude reply into TTS-sized pieces.
 * - TtsPlayer: fetches /api/tts per sentence and plays the clips in order;
 *   stop() is the barge-in (aborts fetches, kills playback, clears the queue).
 * - SpeechCapture: Web Speech API recognition + a MediaRecorder that records
 *   each utterance separately (clean speech segments for voice cloning).
 * - PushToTalkRecorder: fallback for browsers without SpeechRecognition;
 *   records while held, transcribed server-side via /api/stt (Deepgram).
 * - morphVoiceSettings: the stepped voice morph — right after cloning the
 *   clone speaks with the user's timbre but neutral delivery, then relaxes
 *   toward fully expressive as more of their audio accumulates.
 */

// ---------- Voice morph ----------

// ~60s of clean speech is ElevenLabs' guidance for a good instant clone.
export const CLONE_THRESHOLD_SECONDS = 60;

export type VoiceSettings = {
  stability: number;
  similarity_boost: number;
  style: number;
  use_speaker_boost: boolean;
};

// Ramp from neutral delivery at clone time to fully expressive after another
// CLONE_THRESHOLD_SECONDS of accumulated speech. No stages — a continuous
// morph, matching the no-stages persona design.
export function morphVoiceSettings(totalSeconds: number): VoiceSettings {
  const t = Math.min(
    1,
    Math.max(0, (totalSeconds - CLONE_THRESHOLD_SECONDS) / CLONE_THRESHOLD_SECONDS),
  );
  return {
    stability: 0.9 - 0.4 * t, // 0.9 -> 0.5
    similarity_boost: 0.85,
    style: 0.05 + 0.35 * t, // 0.05 -> 0.4
    use_speaker_boost: true,
  };
}

// ---------- Sentence chunking ----------

const SENTENCE_BOUNDARY = /[.!?\n]+["')\]]*\s+/;

export class SentenceChunker {
  private buf = "";

  push(delta: string): string[] {
    this.buf += delta;
    const out: string[] = [];
    for (;;) {
      const m = this.buf.match(SENTENCE_BOUNDARY);
      if (!m || m.index === undefined) break;
      const end = m.index + m[0].length;
      const sentence = this.buf.slice(0, end).trim();
      this.buf = this.buf.slice(end);
      if (sentence) out.push(sentence);
    }
    return out;
  }

  flush(): string | null {
    const rest = this.buf.trim();
    this.buf = "";
    return rest || null;
  }
}

// ---------- TTS playback queue ----------

export class TtsPlayer {
  private queue: Promise<Blob | null>[] = [];
  private controllers = new Set<AbortController>();
  private audio: HTMLAudioElement | null = null;
  private draining = false;
  private generation = 0;

  constructor(private onSpeaking: (speaking: boolean) => void) {}

  enqueue(text: string, voiceId: string | null, settings: VoiceSettings | null) {
    const ctrl = new AbortController();
    this.controllers.add(ctrl);
    const clip = fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, voiceId, settings }),
      signal: ctrl.signal,
    })
      .then((res) => (res.ok ? res.blob() : null))
      .catch(() => null)
      .finally(() => this.controllers.delete(ctrl));
    this.queue.push(clip);
    void this.drain(this.generation);
  }

  // Barge-in: kill current audio, abort pending fetches, drop the queue.
  stop() {
    this.generation++;
    for (const ctrl of this.controllers) ctrl.abort();
    this.controllers.clear();
    this.queue.length = 0;
    if (this.audio) {
      this.audio.pause();
      this.audio.src = "";
      this.audio = null;
    }
  }

  private async drain(generation: number) {
    if (this.draining) return;
    this.draining = true;
    this.onSpeaking(true);
    try {
      while (this.queue.length && this.generation === generation) {
        const blob = await this.queue.shift()!;
        if (!blob || this.generation !== generation) continue;
        await this.play(blob);
      }
    } finally {
      this.draining = false;
      this.onSpeaking(false);
    }
  }

  private play(blob: Blob): Promise<void> {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      this.audio = audio;
      const done = () => {
        URL.revokeObjectURL(url);
        if (this.audio === audio) this.audio = null;
        resolve();
      };
      audio.onended = done;
      audio.onerror = done;
      audio.play().catch(done);
    });
  }
}

// ---------- Speech recognition + utterance recording ----------

type SpeechRecognitionResultLike = {
  isFinal: boolean;
  0: { transcript: string };
};

type SpeechRecognitionEventLike = {
  resultIndex: number;
  results: { length: number; [index: number]: SpeechRecognitionResultLike };
};

type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onspeechstart: (() => void) | null;
  onspeechend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
};

declare global {
  interface Window {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  }
}

export function speechRecognitionSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    Boolean(window.SpeechRecognition || window.webkitSpeechRecognition)
  );
}

export type SpeechCaptureEvents = {
  onFinal: (text: string) => void;
  onInterim: (text: string) => void;
  onSpeechStart: () => void;
  onUtterance: (blob: Blob, seconds: number) => void;
  onError: (message: string) => void;
};

export class SpeechCapture {
  private recognition: SpeechRecognitionLike | null = null;
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private utteranceStart = 0;
  private stopped = true;

  constructor(private events: SpeechCaptureEvents) {}

  async start() {
    this.stopped = false;
    // Echo cancellation matters: the mic must not pick the TTS back up.
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
    });

    const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Ctor) throw new Error("SpeechRecognition unsupported");
    const rec = new Ctor();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = navigator.language || "en-US";
    rec.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const result = e.results[i];
        const text = result[0].transcript;
        if (result.isFinal) {
          const finalText = text.trim();
          if (finalText) this.events.onFinal(finalText);
        } else {
          interim += text;
        }
      }
      this.events.onInterim(interim.trim());
    };
    rec.onspeechstart = () => {
      this.events.onSpeechStart();
      this.beginRecording();
    };
    rec.onspeechend = () => this.endRecording();
    rec.onerror = (e) => {
      if (e.error !== "no-speech" && e.error !== "aborted") {
        this.events.onError(`speech recognition: ${e.error}`);
      }
    };
    // Chrome stops recognition after silence; restart while voice mode is on.
    rec.onend = () => {
      this.endRecording();
      if (!this.stopped) {
        try {
          rec.start();
        } catch {
          /* already started */
        }
      }
    };
    rec.start();
    this.recognition = rec;
  }

  private beginRecording() {
    if (!this.stream || this.recorder) return;
    this.chunks = [];
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(this.stream);
    } catch {
      return;
    }
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data);
    };
    recorder.onstop = () => {
      const seconds = (Date.now() - this.utteranceStart) / 1000;
      // Skip blips; they make poor clone material.
      if (this.chunks.length && seconds >= 1) {
        this.events.onUtterance(
          new Blob(this.chunks, { type: recorder.mimeType || "audio/webm" }),
          seconds,
        );
      }
      this.chunks = [];
    };
    this.utteranceStart = Date.now();
    recorder.start();
    this.recorder = recorder;
  }

  private endRecording() {
    if (this.recorder && this.recorder.state !== "inactive") {
      this.recorder.stop();
    }
    this.recorder = null;
  }

  stop() {
    this.stopped = true;
    try {
      this.recognition?.stop();
    } catch {
      /* not started */
    }
    this.recognition = null;
    this.endRecording();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }
}

// ---------- Push-to-talk fallback (no SpeechRecognition) ----------

export class PushToTalkRecorder {
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private startedAt = 0;

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
    });
    this.chunks = [];
    this.recorder = new MediaRecorder(this.stream);
    this.recorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data);
    };
    this.startedAt = Date.now();
    this.recorder.start();
  }

  stop(): Promise<{ blob: Blob; seconds: number } | null> {
    return new Promise((resolve) => {
      const recorder = this.recorder;
      const stream = this.stream;
      this.recorder = null;
      this.stream = null;
      if (!recorder || recorder.state === "inactive") {
        stream?.getTracks().forEach((t) => t.stop());
        resolve(null);
        return;
      }
      recorder.onstop = () => {
        stream?.getTracks().forEach((t) => t.stop());
        const seconds = (Date.now() - this.startedAt) / 1000;
        if (!this.chunks.length || seconds < 0.5) {
          resolve(null);
          return;
        }
        resolve({
          blob: new Blob(this.chunks, { type: recorder.mimeType || "audio/webm" }),
          seconds,
        });
      };
      recorder.stop();
    });
  }
}

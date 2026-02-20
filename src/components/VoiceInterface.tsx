"use client";

import { useConversation } from "@elevenlabs/react";
import { useCallback, useEffect, useRef, useState } from "react";

type Message = {
  role: "user" | "assistant" | "event";
  text: string;
};

type Voice = { id: string; name: string; desc: string };

const VOICES: Voice[] = [
  { id: "EXAVITQu4vr4xnSDxMaL", name: "Sarah", desc: "Mature, confident" },
  { id: "cgSgspJ2msm6clMCkdW9", name: "Jessica", desc: "Playful, warm" },
  { id: "Xb7hH8MSUJpSbSDYk0k2", name: "Alice", desc: "Clear, British" },
  { id: "XrExE9yKIg1WjnnlVkGX", name: "Matilda", desc: "Professional" },
  { id: "pFZP5JQG7iQjIQuC4Bku", name: "Lily", desc: "Velvety, British" },
  { id: "hpp4J3VqNfWAUOO0d1Us", name: "Bella", desc: "Bright, warm" },
];

const SESSION_PASSWORD = "athena2026";

export default function VoiceInterface() {
  const [authenticated, setAuthenticated] = useState(false);
  const [pin, setPin] = useState("");
  const [pinError, setPinError] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [thinking, setThinking] = useState(false);
  const [showVoices, setShowVoices] = useState(false);
  const [selectedVoice, setSelectedVoice] = useState(VOICES[0]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const thinkingSoundRef = useRef<HTMLAudioElement | null>(null);

  // Preload thinking sound
  useEffect(() => {
    thinkingSoundRef.current = new Audio("/sounds/thinking.wav");
    thinkingSoundRef.current.volume = 0.3;
    thinkingSoundRef.current.loop = true;
  }, []);

  const playThinkingSound = useCallback(() => {
    thinkingSoundRef.current?.play().catch(() => {});
  }, []);

  const stopThinkingSound = useCallback(() => {
    if (thinkingSoundRef.current) {
      thinkingSoundRef.current.pause();
      thinkingSoundRef.current.currentTime = 0;
    }
  }, []);

  const conversation = useConversation({
    onConnect: () => {
      setMessages([]);
    },
    onDisconnect: () => {
      stopThinkingSound();
      setThinking(false);
    },
    onMessage: (msg) => {
      if (msg.source === "user") {
        setThinking(true);
        playThinkingSound();
        setMessages((prev) => [
          ...prev,
          { role: "user", text: msg.message },
        ]);
      } else if (msg.source === "ai") {
        setThinking(false);
        stopThinkingSound();
        setMessages((prev) => [
          ...prev,
          { role: "assistant", text: msg.message },
        ]);
      }
    },
    onError: (error) => {
      setThinking(false);
      stopThinkingSound();
      console.error("Conversation error:", error);
      setMessages((prev) => [
        ...prev,
        { role: "event", text: `Error: ${typeof error === "string" ? error : "Connection failed"}` },
      ]);
    },
  });

  // Auto-scroll
  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages]);

  const handlePinSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (pin === SESSION_PASSWORD) {
      setAuthenticated(true);
      setPinError(false);
    } else {
      setPinError(true);
      setPin("");
    }
  };

  const startConversation = async () => {
    try {
      await navigator.mediaDevices.getUserMedia({ audio: true });

      const agentId = process.env.NEXT_PUBLIC_ELEVENLABS_AGENT_ID;
      if (!agentId) {
        setMessages([{ role: "event", text: "Missing agent ID configuration" }]);
        return;
      }
      await conversation.startSession({
        agentId,
        connectionType: "webrtc",
        overrides: {
          tts: { voiceId: selectedVoice.id },
        },
      });
    } catch (err) {
      console.error("Failed to start:", err);
      setMessages([
        { role: "event", text: "Failed to connect. Check mic permissions." },
      ]);
    }
  };

  const endConversation = async () => {
    stopThinkingSound();
    setThinking(false);
    await conversation.endSession();
  };

  const isConnected = conversation.status === "connected";
  const isSpeaking = conversation.isSpeaking;

  // Password gate
  if (!authenticated) {
    return (
      <div className="flex flex-col h-dvh max-w-xl mx-auto items-center justify-center px-8">
        <div className="w-16 h-16 rounded-full bg-accent/10 flex items-center justify-center mb-6">
          <LockIcon />
        </div>
        <h1 className="text-xl font-semibold tracking-tight mb-2">Athena</h1>
        <p className="text-text-dim text-sm mb-8 text-center">Enter your access code to continue</p>
        <form onSubmit={handlePinSubmit} className="w-full max-w-xs flex flex-col gap-3">
          <input
            type="password"
            value={pin}
            onChange={(e) => { setPin(e.target.value); setPinError(false); }}
            placeholder="Access code"
            autoFocus
            className={`w-full px-4 py-3 rounded-xl bg-surface border text-center text-lg tracking-widest outline-none transition-colors ${
              pinError ? "border-red-500 shake" : "border-border focus:border-accent"
            }`}
          />
          <button
            type="submit"
            className="w-full py-3 rounded-xl bg-accent text-white font-medium transition-all hover:opacity-90 active:scale-[0.98] cursor-pointer"
          >
            Enter
          </button>
          {pinError && (
            <p className="text-red-500 text-xs text-center animate-fade-in">
              Incorrect code. Try again.
            </p>
          )}
        </form>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-dvh max-w-xl mx-auto">
      {/* Header */}
      <header className="flex items-center justify-between px-5 py-4 border-b border-border">
        <h1 className="text-lg font-semibold tracking-tight">Athena</h1>
        <div className="flex items-center gap-3">
          {/* Voice picker */}
          {!isConnected && (
            <button
              onClick={() => setShowVoices(!showVoices)}
              className="flex items-center gap-1.5 text-sm text-text-dim hover:text-white transition-colors cursor-pointer"
              title="Change voice"
            >
              <VoiceIcon />
              <span className="hidden sm:inline">{selectedVoice.name}</span>
            </button>
          )}
          <div className="flex items-center gap-2 text-sm text-text-dim">
            <div
              className={`w-2 h-2 rounded-full transition-colors ${
                isConnected ? "bg-success" : "bg-text-dim"
              }`}
            />
            {isConnected ? "Live" : "Offline"}
          </div>
        </div>
      </header>

      {/* Voice selector dropdown */}
      {showVoices && !isConnected && (
        <div className="border-b border-border bg-surface/80 backdrop-blur px-5 py-3 animate-fade-in">
          <p className="text-xs text-text-dim mb-2">Choose Athena's voice</p>
          <div className="grid grid-cols-2 gap-2">
            {VOICES.map((voice) => (
              <button
                key={voice.id}
                onClick={() => { setSelectedVoice(voice); setShowVoices(false); }}
                className={`px-3 py-2 rounded-lg text-left text-sm transition-all cursor-pointer ${
                  selectedVoice.id === voice.id
                    ? "bg-accent/20 border border-accent/50 text-white"
                    : "bg-bg border border-border text-text-dim hover:border-accent/30"
                }`}
              >
                <div className="font-medium">{voice.name}</div>
                <div className="text-xs opacity-60">{voice.desc}</div>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Messages */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-5 py-5 flex flex-col gap-4"
      >
        {messages.length === 0 && !isConnected && (
          <div className="flex-1 flex items-center justify-center text-text-dim text-center px-8">
            <p>Tap the button below to connect with Athena.</p>
          </div>
        )}

        {messages.map((msg, i) => (
          <div
            key={i}
            className={`animate-fade-in max-w-[85%] px-4 py-3 rounded-2xl text-[15px] leading-relaxed ${
              msg.role === "user"
                ? "self-end bg-accent text-white rounded-br-sm"
                : msg.role === "assistant"
                ? "self-start bg-surface border border-border rounded-bl-sm"
                : "self-center text-text-dim text-xs bg-transparent px-2 py-1"
            }`}
          >
            {msg.text}
          </div>
        ))}

        {/* Thinking indicator */}
        {thinking && (
          <div className="self-start animate-fade-in flex items-center gap-2 text-text-dim text-sm px-2">
            <div className="flex gap-1">
              <span className="w-1.5 h-1.5 bg-accent rounded-full animate-bounce [animation-delay:0ms]" />
              <span className="w-1.5 h-1.5 bg-accent rounded-full animate-bounce [animation-delay:150ms]" />
              <span className="w-1.5 h-1.5 bg-accent rounded-full animate-bounce [animation-delay:300ms]" />
            </div>
            Athena is thinking...
          </div>
        )}
      </div>

      {/* Controls */}
      <div className="px-5 py-6 border-t border-border bg-surface flex flex-col items-center gap-3">
        {!isConnected ? (
          <button
            onClick={startConversation}
            className="w-20 h-20 rounded-full bg-accent text-white flex items-center justify-center transition-all hover:scale-105 active:scale-95 cursor-pointer"
          >
            <MicIcon />
          </button>
        ) : (
          <div className="flex flex-col items-center gap-3">
            {/* Pulsing orb */}
            <div className="relative w-20 h-20 flex items-center justify-center">
              {/* Pulse ring */}
              <div
                className={`absolute inset-0 rounded-full ${
                  isSpeaking
                    ? "bg-accent/20 animate-pulse-ring"
                    : thinking
                    ? "bg-accent/10 animate-pulse"
                    : "bg-listening/20 animate-pulse-ring"
                }`}
              />
              <button
                onClick={endConversation}
                className={`relative w-16 h-16 rounded-full text-white flex items-center justify-center transition-all cursor-pointer z-10 ${
                  isSpeaking
                    ? "bg-accent"
                    : thinking
                    ? "bg-text-dim"
                    : "bg-listening"
                }`}
              >
                {isSpeaking ? <SpeakerIcon /> : thinking ? <BrainIcon /> : <MicIcon />}
              </button>
            </div>
            <span className="text-xs text-text-dim">
              {isSpeaking ? "Athena is speaking" : thinking ? "Thinking..." : "Listening..."}
            </span>
          </div>
        )}

        {!isConnected && (
          <span className="text-xs text-text-dim">Tap to connect</span>
        )}
      </div>
    </div>
  );
}

function LockIcon() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-accent">
      <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}

function VoiceIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 10v3" />
      <path d="M6 6v11" />
      <path d="M10 3v18" />
      <path d="M14 8v7" />
      <path d="M18 5v13" />
      <path d="M22 10v3" />
    </svg>
  );
}

function MicIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <line x1="12" y1="19" x2="12" y2="22" />
    </svg>
  );
}

function SpeakerIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
      <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
      <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
    </svg>
  );
}

function BrainIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v4" />
      <path d="M12 18v4" />
      <path d="m4.93 4.93 2.83 2.83" />
      <path d="m16.24 16.24 2.83 2.83" />
      <path d="M2 12h4" />
      <path d="M18 12h4" />
      <path d="m4.93 19.07 2.83-2.83" />
      <path d="m16.24 7.76 2.83-2.83" />
    </svg>
  );
}

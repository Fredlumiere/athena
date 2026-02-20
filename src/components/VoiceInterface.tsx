"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useElevenLabsProvider, VOICES } from "./providers/ElevenLabsProvider";
import type { VoiceMessage, VoiceProviderStatus } from "./providers/types";
import { useOpenAIProvider } from "./providers/OpenAIProvider";
import TTSToggle, { type TTSProvider } from "./TTSToggle";
import ProviderBadge from "./ProviderBadge";

// ─── Types ───────────────────────────────────────────────────────────────────

interface SessionInfo {
  id: string;
  project: string;
  cwd: string;
  lastMessage: string;
  timestamp: number;
}

type AppPhase = "auth" | "sessions" | "voice";

// Auth is now server-side via /api/auth

// ─── Main Component ──────────────────────────────────────────────────────────

export default function VoiceInterface() {
  // Auth
  const [phase, setPhase] = useState<AppPhase>("auth");
  const [pin, setPin] = useState("");
  const [pinError, setPinError] = useState(false);

  // Sessions
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [sessionsError, setSessionsError] = useState("");

  // Voice state
  const [messages, setMessages] = useState<VoiceMessage[]>([]);
  const [thinking, setThinking] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [providerStatus, setProviderStatus] = useState<VoiceProviderStatus>("disconnected");
  const [showVoices, setShowVoices] = useState(false);
  const [selectedVoice, setSelectedVoice] = useState(VOICES[0]);
  const [debug, setDebug] = useState("");

  // TTS Provider
  const [ttsProvider, setTtsProvider] = useState<TTSProvider>(() => {
    if (typeof window !== "undefined") {
      return (localStorage.getItem("athena-tts-provider") as TTSProvider) || "elevenlabs";
    }
    return "elevenlabs";
  });
  const [elevenlabsAvailable, setElevenlabsAvailable] = useState(true);
  const [openaiAvailable, setOpenaiAvailable] = useState(false);
  const [bridgeUrl] = useState("http://localhost:8013");
  const [bridgeToken, setBridgeToken] = useState("");

  const scrollRef = useRef<HTMLDivElement>(null);
  const thinkingSoundRef = useRef<HTMLAudioElement | null>(null);

  // ─── Load TTS config ────────────────────────────────────────────────────

  useEffect(() => {
    fetch("/api/tts-config")
      .then((r) => r.json())
      .then((data) => {
        setElevenlabsAvailable(data.providers?.elevenlabs?.available ?? false);
        setOpenaiAvailable(data.providers?.openai?.available ?? false);
        if (data.bridgeToken) setBridgeToken(data.bridgeToken);

        // If saved provider isn't available, fall back
        const saved = localStorage.getItem("athena-tts-provider") as TTSProvider | null;
        if (saved === "openai" && !data.providers?.openai?.available) {
          setTtsProvider("elevenlabs");
        } else if (saved === "elevenlabs" && !data.providers?.elevenlabs?.available) {
          if (data.providers?.openai?.available) setTtsProvider("openai");
        }
      })
      .catch(() => {
        // Keep defaults
      });
  }, []);

  // ─── Thinking sound ─────────────────────────────────────────────────────

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

  // ─── Provider callbacks ─────────────────────────────────────────────────

  const onStatusChange = useCallback((status: VoiceProviderStatus) => {
    setProviderStatus(status);
    if (status === "disconnected") {
      setThinking(false);
      setIsSpeaking(false);
      stopThinkingSound();
    }
  }, [stopThinkingSound]);

  const onMessage = useCallback((msg: VoiceMessage) => {
    if (msg.role === "user") {
      setThinking(true);
    } else if (msg.role === "assistant") {
      setThinking(false);
    }
    setMessages((prev) => {
      const next = [...prev, msg];
      return next.length > 200 ? next.slice(-200) : next;
    });
  }, []);

  const onSpeakingChange = useCallback((speaking: boolean) => {
    setIsSpeaking(speaking);
  }, []);

  const onThinkingChange = useCallback(
    (t: boolean) => {
      setThinking(t);
      if (t) playThinkingSound();
      else stopThinkingSound();
    },
    [playThinkingSound, stopThinkingSound]
  );

  const onError = useCallback((error: string) => {
    setThinking(false);
    setIsSpeaking(false);
    setMessages((prev) => [...prev, { role: "event", text: `Error: ${error}` }]);
  }, []);

  const callbacks = { onStatusChange, onMessage, onSpeakingChange, onThinkingChange, onError };

  // ─── Providers ──────────────────────────────────────────────────────────

  const elevenlabs = useElevenLabsProvider(callbacks, selectedVoice.id);
  const openaiProvider = useOpenAIProvider(callbacks, bridgeUrl, bridgeToken);

  const activeProvider = ttsProvider === "elevenlabs" ? elevenlabs : openaiProvider;
  const isConnected = providerStatus === "connected";

  // ─── Effects ────────────────────────────────────────────────────────────

  // Cleanup on unmount — disconnect active provider and stop sounds
  const activeProviderRef = useRef(activeProvider);
  activeProviderRef.current = activeProvider;
  useEffect(() => {
    return () => {
      activeProviderRef.current.disconnect();
      thinkingSoundRef.current?.pause();
    };
  }, []);

  useEffect(() => {
    if (thinking) playThinkingSound();
    else stopThinkingSound();
  }, [thinking, playThinkingSound, stopThinkingSound]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  // ─── Handlers ───────────────────────────────────────────────────────────

  const handlePinSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin }),
      });
      if (res.ok) {
        setPinError(false);
        setPhase("sessions");
        loadSessions();
      } else {
        setPinError(true);
        setPin("");
      }
    } catch {
      setPinError(true);
      setPin("");
    }
  };

  const loadSessions = async () => {
    setSessionsLoading(true);
    setSessionsError("");
    try {
      const res = await fetch("/api/bridge/sessions");
      if (!res.ok) throw new Error("Failed to load sessions");
      const data = await res.json();
      setSessions(data.sessions || []);
    } catch {
      setSessionsError("Could not load sessions. Is the bridge running?");
    } finally {
      setSessionsLoading(false);
    }
  };

  const selectSession = async (session: SessionInfo) => {
    try {
      await fetch("/api/bridge/select", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: session.id, cwd: session.cwd }),
      });
      setPhase("voice");
    } catch {
      setSessionsError("Failed to select session");
    }
  };

  const skipSessionPicker = () => {
    setPhase("voice");
  };

  const handleProviderChange = (p: TTSProvider) => {
    if (isConnected) return; // Don't switch while connected
    setTtsProvider(p);
    localStorage.setItem("athena-tts-provider", p);
  };

  const startConversation = async () => {
    setDebug(`Connecting via ${ttsProvider}...`);
    setMessages([{ role: "event", text: "Connecting..." }]);
    try {
      await activeProvider.connect();
      setDebug("Connected!");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setDebug(`ERROR: ${msg}`);
    }
  };

  const endConversation = async () => {
    stopThinkingSound();
    setThinking(false);
    await activeProvider.disconnect();
  };

  // ─── Colors ────────────────────────────────────────────────────────────
  // Stable accent for chrome; provider color only for badge/toggle/orb
  const providerColor = ttsProvider === "elevenlabs" ? "#8b5cf6" : "#10a37f";
  const providerClass =
    ttsProvider === "elevenlabs" ? "bg-[#8b5cf6]" : "bg-[#10a37f]";
  const providerGlowClass =
    ttsProvider === "elevenlabs" ? "bg-[#8b5cf6]/20" : "bg-[#10a37f]/20";
  const providerDimClass =
    ttsProvider === "elevenlabs" ? "bg-[#8b5cf6]/10" : "bg-[#10a37f]/10";
  const isConnecting = providerStatus === "connecting";

  // ─── Auth Screen ────────────────────────────────────────────────────────

  if (phase === "auth") {
    return (
      <div className="flex flex-col h-dvh max-w-xl mx-auto items-center justify-center px-8">
        <div className="w-16 h-16 rounded-full bg-accent/10 flex items-center justify-center mb-6">
          <LockIcon />
        </div>
        <h1 className="text-xl font-semibold tracking-tight mb-2">Athena</h1>
        <p className="text-text-dim text-sm mb-8 text-center">
          Enter your access code to continue
        </p>
        <form onSubmit={handlePinSubmit} className="w-full max-w-xs flex flex-col gap-3">
          <input
            type="password"
            value={pin}
            onChange={(e) => {
              setPin(e.target.value);
              setPinError(false);
            }}
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

  // ─── Session Picker ─────────────────────────────────────────────────────

  if (phase === "sessions") {
    // Group sessions by project, sorted by most recent first
    const sorted = [...sessions].sort((a, b) => b.timestamp - a.timestamp);
    const grouped = sorted.reduce(
      (acc, s) => {
        const key = s.project || "unknown";
        if (!acc[key]) acc[key] = [];
        acc[key].push(s);
        return acc;
      },
      {} as Record<string, SessionInfo[]>
    );

    return (
      <div className="flex flex-col h-dvh max-w-xl mx-auto">
        <header className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div className="flex items-center gap-2">
            <button
              onClick={() => setPhase("auth")}
              aria-label="Back to login"
              className="text-text-dim hover:text-white transition-colors cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
            >
              <BackIcon />
            </button>
            <h1 className="text-lg font-semibold tracking-tight">Sessions</h1>
          </div>
          <button
            onClick={skipSessionPicker}
            className="text-sm text-accent hover:text-white transition-colors cursor-pointer"
          >
            Start fresh
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-5">
          <p className="text-sm text-text-dim mb-4">
            Select a Claude Code session to resume, or skip to start fresh.
          </p>

          {sessionsLoading && (
            <div className="flex items-center justify-center py-12 text-text-dim text-sm">
              <div className="flex gap-1 mr-2">
                <span className="w-1.5 h-1.5 bg-accent rounded-full animate-bounce [animation-delay:0ms]" />
                <span className="w-1.5 h-1.5 bg-accent rounded-full animate-bounce [animation-delay:150ms]" />
                <span className="w-1.5 h-1.5 bg-accent rounded-full animate-bounce [animation-delay:300ms]" />
              </div>
              Loading sessions...
            </div>
          )}

          {sessionsError && (
            <div className="text-center py-8">
              <p className="text-red-400 text-sm mb-3">{sessionsError}</p>
              <button
                onClick={loadSessions}
                className="text-sm text-accent hover:underline cursor-pointer"
              >
                Retry
              </button>
            </div>
          )}

          {!sessionsLoading && !sessionsError && sessions.length === 0 && (
            <div className="text-center py-12 text-text-dim text-sm">
              <p>No sessions found.</p>
              <button
                onClick={skipSessionPicker}
                className="mt-3 text-accent hover:underline cursor-pointer"
              >
                Start fresh
              </button>
            </div>
          )}

          {Object.entries(grouped).map(([project, projectSessions]) => (
            <div key={project} className="mb-6">
              <h2 className="text-xs font-medium text-text-dim uppercase tracking-wider mb-2">
                {project}
              </h2>
              <div className="flex flex-col gap-2">
                {projectSessions.map((session) => (
                  <button
                    key={session.id}
                    onClick={() => selectSession(session)}
                    className="text-left px-4 py-3 rounded-xl bg-surface border border-border hover:border-accent/40 transition-all cursor-pointer group"
                  >
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs font-mono text-text-dim group-hover:text-accent transition-colors">
                        {session.id.slice(0, 8)}...
                      </span>
                      <span className="text-[10px] text-text-dim">
                        {formatTimestamp(session.timestamp)}
                      </span>
                    </div>
                    <p className="text-sm text-text truncate">{session.lastMessage}</p>
                    {session.cwd !== "unknown" && (
                      <p className="text-[10px] text-text-dim mt-1 font-mono truncate">
                        {session.cwd}
                      </p>
                    )}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // ─── Voice Interface ────────────────────────────────────────────────────

  return (
    <div className="flex flex-col h-dvh max-w-xl mx-auto">
      {/* Header */}
      <header className="flex items-center justify-between px-5 py-4 border-b border-border">
        <div className="flex items-center gap-2">
          {!isConnected && (
            <button
              onClick={() => { setPhase("sessions"); loadSessions(); }}
              aria-label="Back to sessions"
              className="text-text-dim hover:text-white transition-colors cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
            >
              <BackIcon />
            </button>
          )}
          <h1 className="text-lg font-semibold tracking-tight">Athena</h1>
          {isConnected && <ProviderBadge provider={ttsProvider} />}
        </div>
        <div className="flex items-center gap-2 text-sm text-text-dim">
          <div
            className={`w-2 h-2 rounded-full transition-colors ${
              isConnected ? "bg-success" : "bg-text-dim"
            }`}
          />
          {isConnected ? "Live" : "Offline"}
        </div>
      </header>

      {/* TTS Toggle + Voice selector */}
      {!isConnected && (
        <div className="border-b border-border bg-surface/50 px-5 py-3 flex items-center justify-between">
          <TTSToggle
            provider={ttsProvider}
            onChange={handleProviderChange}
            disabled={isConnected}
            elevenlabsAvailable={elevenlabsAvailable}
            openaiAvailable={openaiAvailable}
          />
          {ttsProvider === "elevenlabs" && (
            <button
              onClick={() => setShowVoices(!showVoices)}
              className="text-xs text-text-dim hover:text-white transition-colors cursor-pointer"
            >
              Voice: {selectedVoice.name}
            </button>
          )}
        </div>
      )}

      {/* Voice selector dropdown (ElevenLabs) */}
      {showVoices && !isConnected && ttsProvider === "elevenlabs" && (
        <div className="border-b border-border bg-surface/80 backdrop-blur px-5 py-3 animate-fade-in">
          <p className="text-xs text-text-dim mb-2">Choose Athena&apos;s voice</p>
          <div className="grid grid-cols-2 gap-2">
            {VOICES.map((voice) => (
              <button
                key={voice.id}
                onClick={() => {
                  setSelectedVoice(voice);
                  setShowVoices(false);
                }}
                className={`px-3 py-2 rounded-lg text-left text-sm transition-all cursor-pointer ${
                  selectedVoice.id === voice.id
                    ? "bg-[#8b5cf6]/20 border border-[#8b5cf6]/50 text-white"
                    : "bg-bg border border-border text-text-dim hover:border-[#8b5cf6]/30"
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
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-5 py-5 flex flex-col gap-4" role="log" aria-label="Conversation messages" aria-live="polite">
        {messages.length === 0 && !isConnected && (
          <div className="flex-1 flex items-center justify-center text-text-dim text-center px-8">
            <p>Tap the button below to connect with Athena.</p>
          </div>
        )}

        {messages.map((msg, i) => (
          <div
            key={i}
            role={msg.role === "event" ? "status" : undefined}
            className={`animate-fade-in max-w-[85%] px-4 py-3 rounded-2xl text-[15px] leading-relaxed ${
              msg.role === "user"
                ? "self-end text-white rounded-br-sm bg-accent"
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
          <div className="self-start animate-fade-in flex items-center gap-2 text-text-dim text-sm px-2" role="status" aria-label="Athena is thinking">
            <div className="flex gap-1" aria-hidden="true">
              <span
                className="w-1.5 h-1.5 rounded-full animate-bounce [animation-delay:0ms]"
                style={{ backgroundColor: providerColor }}
              />
              <span
                className="w-1.5 h-1.5 rounded-full animate-bounce [animation-delay:150ms]"
                style={{ backgroundColor: providerColor }}
              />
              <span
                className="w-1.5 h-1.5 rounded-full animate-bounce [animation-delay:300ms]"
                style={{ backgroundColor: providerColor }}
              />
            </div>
            Athena is thinking...
          </div>
        )}
      </div>

      {/* Controls */}
      <div className="px-5 py-6 pb-[calc(1.5rem+env(safe-area-inset-bottom,0px))] border-t border-border bg-surface flex flex-col items-center gap-3">
        {!isConnected ? (
          <button
            onClick={startConversation}
            disabled={isConnecting}
            aria-label={isConnecting ? "Connecting..." : "Start conversation"}
            className={`w-20 h-20 rounded-full text-white flex items-center justify-center transition-all cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white ${
              isConnecting ? "opacity-60 animate-pulse cursor-wait" : "hover:scale-105 active:scale-95"
            }`}
            style={{ backgroundColor: providerColor }}
          >
            {isConnecting ? <LoadingSpinner /> : <MicIcon />}
          </button>
        ) : (
          <div className="flex flex-col items-center gap-3">
            {/* Pulsing orb */}
            <div className="relative w-20 h-20 flex items-center justify-center">
              <div
                aria-hidden="true"
                className={`absolute inset-0 rounded-full ${
                  isSpeaking
                    ? `${providerGlowClass} animate-pulse-ring`
                    : thinking
                    ? `${providerDimClass} animate-pulse`
                    : "bg-listening/20 animate-pulse-ring"
                }`}
              />
              <button
                onClick={endConversation}
                aria-label={isSpeaking ? "Athena is speaking. Tap to disconnect." : thinking ? "Athena is thinking. Tap to disconnect." : "Listening. Tap to disconnect."}
                className={`relative w-16 h-16 rounded-full text-white flex items-center justify-center transition-all cursor-pointer z-10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white ${
                  isSpeaking
                    ? providerClass
                    : thinking
                    ? "bg-text-dim"
                    : "bg-listening"
                }`}
              >
                {isSpeaking ? <SpeakerIcon /> : thinking ? <BrainIcon /> : <MicIcon />}
              </button>
            </div>
            <span className="text-xs text-text-dim" aria-live="polite">
              {isSpeaking ? "Athena is speaking" : thinking ? "Thinking..." : "Listening..."}
            </span>
          </div>
        )}

        {!isConnected && !isConnecting && <span className="text-xs text-text-dim">Tap to connect</span>}
        {isConnecting && <span className="text-xs text-text-dim">Connecting...</span>}
      </div>
    </div>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  return d.toLocaleDateString();
}

// ─── Icons ───────────────────────────────────────────────────────────────────

function BackIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M19 12H5" />
      <path d="m12 19-7-7 7-7" />
    </svg>
  );
}

function LoadingSpinner() {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      className="animate-spin"
    >
      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg
      width="28"
      height="28"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="text-accent"
    >
      <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}

function MicIcon() {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <line x1="12" y1="19" x2="12" y2="22" />
    </svg>
  );
}

function SpeakerIcon() {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
      <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
      <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
    </svg>
  );
}

function BrainIcon() {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
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

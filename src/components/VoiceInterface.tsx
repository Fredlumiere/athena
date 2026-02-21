"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useElevenLabsProvider, VOICES } from "./providers/ElevenLabsProvider";
import type { VoiceMessage, VoiceProviderStatus } from "./providers/types";
import { useOpenAIProvider } from "./providers/OpenAIProvider";
import TTSToggle, { type TTSProvider } from "./TTSToggle";
import STTToggle from "./STTToggle";
import type { STTModel } from "./providers/OpenAIProvider";
import ProviderBadge from "./ProviderBadge";
import { useDebugLog, DebugPanel, runPreflight, type DebugLogger } from "./DebugPanel";

// ─── Types ───────────────────────────────────────────────────────────────────

interface SessionInfo {
  id: string;
  project: string;
  cwd: string;
  lastMessage: string;
  timestamp: number;
  active?: boolean;
}

type AppPhase = "auth" | "sessions" | "voice";

// Auth is now server-side via /api/auth

// ─── Main Component ──────────────────────────────────────────────────────────

export default function VoiceInterface() {
  // Auth
  const [phase, setPhase] = useState<AppPhase>("auth");
  const [pin, setPin] = useState("");
  const [authError, setAuthError] = useState("");

  // Sessions
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [sessionsError, setSessionsError] = useState("");
  const [activeSession, setActiveSession] = useState<SessionInfo | null>(null);

  // Voice state
  const [messages, setMessages] = useState<VoiceMessage[]>([]);
  const [thinking, setThinking] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [interimText, setInterimText] = useState("");
  const [userSpeaking, setUserSpeaking] = useState(false);
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
  const [sttModel, setSttModel] = useState<STTModel>(() => {
    if (typeof window !== "undefined") {
      return (localStorage.getItem("athena-stt-model") as STTModel) || "whisper-1";
    }
    return "whisper-1";
  });
  const [elevenlabsAvailable, setElevenlabsAvailable] = useState(true);
  const [openaiAvailable, setOpenaiAvailable] = useState(false);
  const [bridgeUrl, setBridgeUrl] = useState("http://localhost:8013");
  const [bridgeToken, setBridgeToken] = useState("");
  const [showDebug, setShowDebug] = useState(() => {
    if (typeof window !== "undefined") {
      return localStorage.getItem("athena-show-debug") !== "false";
    }
    return true;
  });

  const scrollRef = useRef<HTMLDivElement>(null);

  // ─── Debug logger ─────────────────────────────────────────────────────
  const debugLog = useDebugLog();

  // ─── Check auth on mount ──────────────────────────────────────────────

  useEffect(() => {
    // Try remember-me token first
    const savedToken = localStorage.getItem("athena-session-token");
    if (savedToken) {
      fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: savedToken }),
      })
        .then((r) => r.json())
        .then((data) => {
          if (data.ok) {
            setPhase("sessions");
            loadSessions();
          }
        })
        .catch(() => {}); // token invalid or server down — show auth screen
      return;
    }

    // Check if auth is skipped (no PIN configured)
    fetch("/api/auth/mode")
      .then((r) => r.json())
      .then((data) => {
        if (data.skipAuth) {
          setPhase("sessions");
          loadSessions();
        }
      })
      .catch(() => {});
  }, []);

  // ─── Load TTS config ────────────────────────────────────────────────────

  useEffect(() => {
    debugLog.log("Loading TTS config...");
    fetch("/api/tts-config")
      .then((r) => r.json())
      .then((data) => {
        const el = data.providers?.elevenlabs?.available ?? false;
        const oai = data.providers?.openai?.available ?? false;
        setElevenlabsAvailable(el);
        setOpenaiAvailable(oai);
        if (data.bridgeToken) setBridgeToken(data.bridgeToken);

        debugLog.log(`Providers: ElevenLabs=${el}, OpenAI=${oai}`);

        // Use current origin for bridge URL when accessed remotely (e.g. via ngrok)
        // The bridge serves both HTTP and WebSocket on the same port
        const isRemote = typeof window !== "undefined"
          && window.location.hostname !== "localhost"
          && window.location.hostname !== "127.0.0.1";
        const url = isRemote ? window.location.origin : (data.bridgeUrl || "http://localhost:8013");
        setBridgeUrl(url);
        debugLog.log(`Bridge URL: ${url} (remote=${isRemote})`);

        // If saved provider isn't available, fall back
        const saved = localStorage.getItem("athena-tts-provider") as TTSProvider | null;
        if (saved === "openai" && !oai) {
          setTtsProvider("elevenlabs");
          debugLog.warn("OpenAI saved but unavailable, falling back to ElevenLabs");
        } else if (saved === "elevenlabs" && !el) {
          if (oai) setTtsProvider("openai");
          debugLog.warn("ElevenLabs saved but unavailable, falling back to OpenAI");
        }
      })
      .catch((err) => {
        debugLog.error(`TTS config failed: ${err}`);
      });
  }, []);

  // ─── In-app browser detection (iOS WKWebView blocks getUserMedia) ───────
  const [inAppWarning, setInAppWarning] = useState(false);
  useEffect(() => {
    const ua = navigator.userAgent || "";
    const isIOS = /iPhone|iPad|iPod/.test(ua);
    const hasSafari = /Safari\//.test(ua);
    if (isIOS && !hasSafari) {
      setInAppWarning(true);
      debugLog.warn("In-app browser detected — mic access may be blocked. Open in Safari.");
    }
  }, []);

  // ─── Auto-run preflight checks on mount ─────────────────────────────────
  const preflightRan = useRef(false);
  useEffect(() => {
    if (preflightRan.current) return;
    preflightRan.current = true;
    const timer = setTimeout(() => {
      runPreflight(debugLog, bridgeUrl);
    }, 1500);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── Thinking sound ─────────────────────────────────────────────────────

  const playThinkingSound = useCallback(() => {
    // Generate a soft, single-tone chime using Web Audio API
    try {
      const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
      const oscillator = audioContext.createOscillator();
      const gainNode = audioContext.createGain();

      oscillator.connect(gainNode);
      gainNode.connect(audioContext.destination);

      // Soft sine wave at 800Hz (pleasant mid-high tone)
      oscillator.type = 'sine';
      oscillator.frequency.value = 800;

      // Very quiet with smooth fade out
      gainNode.gain.setValueAtTime(0.08, audioContext.currentTime);
      gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.3);

      // Play for 300ms
      oscillator.start(audioContext.currentTime);
      oscillator.stop(audioContext.currentTime + 0.3);

      // Clean up
      setTimeout(() => audioContext.close(), 400);
    } catch (err) {
      // Silently fail if Web Audio not supported
    }
  }, []);

  const stopThinkingSound = useCallback(() => {
    // No-op now since we play a single tone, not a loop
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
    if (msg.role === "interim") {
      // Live speech-to-text — update display, don't add to messages
      setInterimText(msg.text);
      setUserSpeaking(true);
      return;
    }
    if (msg.role === "activity") {
      // Route activity to debug panel, not chat
      debugLog.log(msg.text);
      return;
    }
    if (msg.role === "user") {
      setInterimText(""); // Clear interim when final transcript arrives
      setUserSpeaking(false);
      setThinking(true);
    } else if (msg.role === "assistant") {
      setThinking(false);
      setUserSpeaking(false);
    }
    setMessages((prev) => {
      const next = [...prev, msg];
      return next.length > 200 ? next.slice(-200) : next;
    });
  }, [debugLog]);

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

  const callbacks = { onStatusChange, onMessage, onSpeakingChange, onThinkingChange, onError, debug: debugLog };

  // ─── Providers ──────────────────────────────────────────────────────────

  const elevenlabs = useElevenLabsProvider(callbacks, selectedVoice.id);
  const openaiProvider = useOpenAIProvider(callbacks, bridgeUrl, bridgeToken, sttModel);

  const activeProvider = ttsProvider === "elevenlabs" ? elevenlabs : openaiProvider;
  const isConnected = providerStatus === "connected";

  // ─── Effects ────────────────────────────────────────────────────────────

  // Cleanup on unmount — disconnect active provider and stop sounds
  const activeProviderRef = useRef(activeProvider);
  activeProviderRef.current = activeProvider;
  useEffect(() => {
    return () => {
      activeProviderRef.current.disconnect();
    };
  }, []);

  useEffect(() => {
    // Play single soft tone when thinking starts (doesn't loop)
    if (thinking) playThinkingSound();
  }, [thinking, playThinkingSound]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  // ─── Handlers ───────────────────────────────────────────────────────────

  const loadSessions = async () => {
    setSessionsLoading(true);
    setSessionsError("");
    try {
      // Call bridge directly (not via Next.js proxy — avoids circular proxy loop)
      const res = await fetch(`${bridgeUrl}/v1/sessions`);
      if (!res.ok) throw new Error("Failed to load sessions");
      const data = await res.json();
      const all: SessionInfo[] = data.sessions || [];
      // Show only sessions with a running Claude Code process
      const active = all.filter((s: SessionInfo) => s.active);
      setSessions(active);
    } catch {
      setSessionsError("Could not load sessions. Is the bridge running?");
    } finally {
      setSessionsLoading(false);
    }
  };

  const selectSession = async (session: SessionInfo) => {
    try {
      // Call bridge directly (not via Next.js proxy — avoids circular proxy loop)
      const res = await fetch(`${bridgeUrl}/v1/session/select`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: session.id, cwd: session.cwd }),
      });
      if (!res.ok) throw new Error(`Select failed: ${res.status}`);
      setActiveSession(session);
      setPhase("voice");
    } catch (err) {
      setSessionsError(`Failed to select session: ${err instanceof Error ? err.message : "unknown"}`);
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

  const handleSTTModelChange = (m: STTModel) => {
    if (isConnected) return;
    setSttModel(m);
    localStorage.setItem("athena-stt-model", m);
  };

  const startConversation = async () => {
    debugLog.log(`Connecting via ${ttsProvider}...`);
    setMessages([{ role: "event", text: "Connecting..." }]);
    try {
      await activeProvider.connect();
      debugLog.success("Connected!");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      debugLog.error(`Connect failed: ${msg}`);
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

  // ─── Auth Screen ──────────────────────────────────────────────────────

  const handleAuth = async () => {
    setAuthError("");
    try {
      const res = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin }),
      });
      const data = await res.json();
      if (data.ok && data.token) {
        localStorage.setItem("athena-session-token", data.token);
        setPhase("sessions");
        loadSessions();
      } else {
        setAuthError("Wrong password");
        setPin("");
      }
    } catch {
      setAuthError("Can't reach server");
    }
  };

  if (phase === "auth") {
    return (
      <div className="flex flex-col h-dvh max-w-xl mx-auto items-center justify-center px-8">
        <h1 className="text-2xl font-semibold tracking-tight mb-8">Nova</h1>
        <input
          type="password"
          inputMode="numeric"
          value={pin}
          onChange={(e) => setPin(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleAuth()}
          placeholder="Password"
          autoFocus
          className="w-full max-w-[240px] text-center text-lg tracking-widest px-4 py-3 rounded-xl bg-surface border border-border focus:border-accent outline-none transition-colors"
        />
        {authError && <p className="text-red-400 text-sm mt-3">{authError}</p>}
        <button
          onClick={handleAuth}
          disabled={!pin}
          className="mt-4 px-6 py-2 rounded-xl bg-accent text-white text-sm font-medium disabled:opacity-40 cursor-pointer transition-opacity"
        >
          Enter
        </button>
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
            <h1 className="text-lg font-semibold tracking-tight">Nova</h1>
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
            Active Claude Code sessions
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
              <p>No active Claude Code sessions found.</p>
              <p className="mt-1 text-xs">Start Claude Code in a terminal to see it here.</p>
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
                {projectSessions.map((session) => {
                  const folderName = session.cwd !== "unknown" ? session.cwd.split("/").pop() : null;
                  return (
                    <button
                      key={session.id}
                      onClick={() => selectSession(session)}
                      className="text-left px-4 py-3 rounded-xl bg-surface border border-border hover:border-accent/40 transition-all cursor-pointer group"
                    >
                      <div className="flex items-center justify-between mb-1">
                        <div className="flex items-center gap-2">
                          {folderName && (
                            <span className="text-sm font-medium text-text group-hover:text-accent transition-colors">
                              {folderName}
                            </span>
                          )}
                          <span className="text-[10px] font-mono text-text-dim">
                            {session.id.slice(0, 8)}
                          </span>
                        </div>
                        <span className="text-[10px] text-text-dim">
                          {formatTimestamp(session.timestamp)}
                        </span>
                      </div>
                      <p className="text-sm text-text-dim truncate">{session.lastMessage}</p>
                      {session.cwd !== "unknown" && (
                        <p className="text-[10px] text-text-dim/60 mt-1 font-mono truncate">
                          {session.cwd}
                        </p>
                      )}
                    </button>
                  );
                })}
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
          <h1 className="text-lg font-semibold tracking-tight">Nova</h1>
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

      {/* Project path — tap to switch */}
      {activeSession && activeSession.cwd !== "unknown" ? (
        <button
          onClick={async () => {
            if (isConnected) await endConversation();
            setPhase("sessions");
            loadSessions();
          }}
          className="w-full px-5 py-1.5 border-b border-border/50 bg-surface/30 flex items-center gap-2 cursor-pointer hover:bg-surface/50 transition-colors text-left"
        >
          <span className="text-[10px] text-text-dim font-mono truncate">{activeSession.cwd}</span>
          <span className="text-[10px] text-text-dim/50 shrink-0">switch</span>
        </button>
      ) : (
        <button
          onClick={async () => {
            if (isConnected) await endConversation();
            setPhase("sessions");
            loadSessions();
          }}
          className="w-full px-5 py-1.5 border-b border-border/50 bg-surface/30 flex items-center gap-2 cursor-pointer hover:bg-surface/50 transition-colors text-left"
        >
          <span className="text-[10px] text-text-dim">No project selected</span>
          <span className="text-[10px] text-text-dim/50 shrink-0">switch</span>
        </button>
      )}

      {/* TTS Toggle + Voice selector + STT model */}
      {!isConnected && (
        <div className="border-b border-border bg-surface/50 px-5 py-3 flex flex-col gap-2">
          <div className="flex items-center justify-between">
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
          {ttsProvider === "openai" && (
            <STTToggle
              model={sttModel}
              onChange={handleSTTModelChange}
              disabled={isConnected}
            />
          )}
          <div className="flex items-center justify-between">
            <span className="text-xs text-text-dim">Activity log</span>
            <button
              onClick={() => {
                const next = !showDebug;
                setShowDebug(next);
                localStorage.setItem("athena-show-debug", String(next));
              }}
              className={`text-xs px-2 py-0.5 rounded transition-colors cursor-pointer ${
                showDebug ? "bg-accent/20 text-accent" : "bg-surface text-text-dim"
              }`}
            >
              {showDebug ? "On" : "Off"}
            </button>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-xs text-text-dim">Bridge server</span>
            <button
              onClick={async () => {
                try {
                  await fetch(`${bridgeUrl}/v1/restart`, { method: "POST" });
                  setMessages([{ role: "event", text: "Restarting bridge..." }]);
                } catch {
                  setMessages((prev) => [...prev, { role: "event", text: "Restart failed — bridge unreachable" }]);
                }
              }}
              className="text-xs px-2 py-0.5 rounded bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-colors cursor-pointer"
            >
              Restart
            </button>
          </div>
        </div>
      )}

      {/* Voice selector dropdown (ElevenLabs) */}
      {showVoices && !isConnected && ttsProvider === "elevenlabs" && (
        <div className="border-b border-border bg-surface/80 backdrop-blur px-5 py-3 animate-fade-in">
          <p className="text-xs text-text-dim mb-2">Choose Nova&apos;s voice</p>
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

      {/* In-app browser warning */}
      {inAppWarning && (
        <div className="bg-yellow-900/30 border-b border-yellow-600/40 px-5 py-3 text-sm text-yellow-200">
          <p className="font-medium">Open in Safari</p>
          <p className="text-xs text-yellow-300/80 mt-0.5">
            Microphone requires Safari. Tap the share icon, then &quot;Open in Safari.&quot;
          </p>
        </div>
      )}

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-5 py-5 flex flex-col gap-4" role="log" aria-label="Conversation messages" aria-live="polite">
        {messages.length === 0 && !isConnected && (
          <div className="flex-1 flex items-center justify-center text-text-dim text-center px-8">
            <p>Tap the button below to connect with Nova.</p>
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

        {/* Live interim transcript */}
        {interimText && (
          <div className="self-end animate-fade-in max-w-[85%] px-4 py-3 rounded-2xl rounded-br-sm text-[15px] leading-relaxed bg-accent/40 text-white/70 italic">
            {interimText}
          </div>
        )}

        {/* Thinking indicator */}
        {thinking && (
          <div className="self-start animate-fade-in flex items-center gap-2 text-text-dim text-sm px-2" role="status" aria-label="Nova is thinking">
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
            Nova is thinking...
          </div>
        )}
      </div>

      {/* Controls */}
      <div className="px-5 py-6 pb-[calc(3rem+env(safe-area-inset-bottom,0px))] border-t border-border bg-surface flex flex-col items-center gap-3">
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
                    : userSpeaking
                    ? "bg-orange-500/30 animate-pulse-ring"
                    : "bg-listening/20 animate-pulse-ring"
                }`}
              />
              <button
                onClick={endConversation}
                aria-label={isSpeaking ? "Nova is speaking. Tap to disconnect." : thinking ? "Nova is thinking. Tap to disconnect." : "Listening. Tap to disconnect."}
                className={`relative w-16 h-16 rounded-full text-white flex items-center justify-center transition-all cursor-pointer z-10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white ${
                  isSpeaking
                    ? providerClass
                    : thinking
                    ? "bg-text-dim"
                    : userSpeaking
                    ? "bg-orange-500"
                    : "bg-listening"
                }`}
              >
                {isSpeaking ? <SpeakerIcon /> : thinking ? <BrainIcon /> : <MicIcon />}
              </button>
            </div>
            <span className="text-xs text-text-dim" aria-live="polite">
              {isSpeaking ? "Nova is speaking" : thinking ? "Thinking..." : userSpeaking ? "Hearing you..." : "Listening..."}
            </span>
          </div>
        )}

        {!isConnected && !isConnecting && <span className="text-xs text-text-dim">Tap to connect</span>}
        {isConnecting && <span className="text-xs text-text-dim">Connecting...</span>}
      </div>

      {/* Debug Panel */}
      {showDebug && (
        <DebugPanel
          entries={debugLog.entries}
          onRunPreflight={() => runPreflight(debugLog, bridgeUrl)}
        />
      )}
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

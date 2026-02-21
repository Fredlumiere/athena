"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export interface DebugEntry {
  time: number;
  level: "info" | "warn" | "error" | "success";
  msg: string;
}

export interface DebugLogger {
  log: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
  success: (msg: string) => void;
  entries: DebugEntry[];
}

export function useDebugLog(): DebugLogger {
  const [entries, setEntries] = useState<DebugEntry[]>([]);

  const add = useCallback((level: DebugEntry["level"], msg: string) => {
    setEntries((prev) => {
      const next = [...prev, { time: Date.now(), level, msg }];
      return next.length > 500 ? next.slice(-500) : next;
    });
  }, []);

  return {
    log: useCallback((msg: string) => add("info", msg), [add]),
    warn: useCallback((msg: string) => add("warn", msg), [add]),
    error: useCallback((msg: string) => add("error", msg), [add]),
    success: useCallback((msg: string) => add("success", msg), [add]),
    entries,
  };
}

// ─── Pre-flight checks ─────────────────────────────────────────────────────

export async function runPreflight(logger: DebugLogger, origin: string) {
  logger.log(`Platform: ${navigator.userAgent}`);
  logger.log(`Screen: ${screen.width}x${screen.height} @${devicePixelRatio}x`);
  logger.log(`Origin: ${origin}`);
  logger.log(`Secure context: ${window.isSecureContext}`);

  // Audio support
  const hasAudioCtx = typeof AudioContext !== "undefined" || typeof (window as unknown as Record<string, unknown>).webkitAudioContext !== "undefined";
  logger[hasAudioCtx ? "success" : "error"](`AudioContext: ${hasAudioCtx ? "available" : "MISSING"}`);

  const hasWorklet = hasAudioCtx && "audioWorklet" in AudioContext.prototype;
  logger[hasWorklet ? "success" : "warn"](`AudioWorklet: ${hasWorklet ? "available" : "missing (will use ScriptProcessor)"}`);

  const hasGetUserMedia = !!(navigator.mediaDevices?.getUserMedia);
  logger[hasGetUserMedia ? "success" : "error"](`getUserMedia: ${hasGetUserMedia ? "available" : "MISSING"}`);

  // Check critical assets
  const assets = [
    { name: "Page", url: "/" },
    { name: "Auth mode", url: "/api/auth/mode" },
    { name: "TTS config", url: "/api/tts-config" },
    { name: "VAD worklet", url: "/vad.worklet.bundle.min.js" },
    { name: "Silero model", url: "/silero_vad_legacy.onnx" },
    { name: "ONNX WASM", url: "/ort-wasm-simd-threaded.wasm" },
  ];

  for (const asset of assets) {
    try {
      const res = await fetch(asset.url, { method: "HEAD" });
      const ct = res.headers.get("content-type") || "";
      const size = res.headers.get("content-length");
      if (res.ok) {
        logger.success(`${asset.name}: ${res.status} (${size ? formatBytes(parseInt(size)) : ct.split(";")[0]})`);
      } else {
        logger.error(`${asset.name}: ${res.status} ${res.statusText}`);
      }
    } catch (err) {
      logger.error(`${asset.name}: FAILED — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // WebSocket check
  try {
    const wsBase = origin.replace(/^http/, "ws") + "/ws/voice";
    logger.log(`WebSocket: connecting to ${wsBase}...`);
    const ws = new WebSocket(wsBase);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { ws.close(); reject(new Error("timeout")); }, 5000);
      ws.onopen = () => { clearTimeout(timer); ws.close(); resolve(); };
      ws.onerror = () => { clearTimeout(timer); reject(new Error("connection failed")); };
    });
    logger.success("WebSocket: connected OK");
  } catch (err) {
    logger.error(`WebSocket: ${err instanceof Error ? err.message : String(err)}`);
  }

  logger.log("Preflight complete.");
}

// ─── Debug Panel Component ──────────────────────────────────────────────────

export function DebugPanel({ entries, onRunPreflight }: { entries: DebugEntry[]; onRunPreflight: () => void }) {
  const [open, setOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [entries, open]);

  const errorCount = entries.filter((e) => e.level === "error").length;
  const warnCount = entries.filter((e) => e.level === "warn").length;

  return (
    <div className="fixed bottom-0 left-0 right-0 z-50 font-mono text-[11px]">
      {/* Toggle bar */}
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-3 py-1.5 bg-[#1a1a2e] border-t border-[#333] text-[#888] cursor-pointer hover:text-white transition-colors"
      >
        <span className="flex items-center gap-2">
          <span className="text-[10px]">{open ? "▼" : "▲"}</span>
          <span>DEBUG</span>
          <span className="text-[#666]">({entries.length})</span>
          {errorCount > 0 && <span className="text-red-400">{errorCount} err</span>}
          {warnCount > 0 && <span className="text-yellow-400">{warnCount} warn</span>}
        </span>
        <span className="flex items-center gap-2">
          <button
            onClick={(e) => { e.stopPropagation(); onRunPreflight(); }}
            className="text-[10px] px-2 py-0.5 bg-[#333] rounded hover:bg-[#444] transition-colors cursor-pointer"
          >
            Run checks
          </button>
        </span>
      </button>

      {/* Log panel */}
      {open && (
        <div
          ref={scrollRef}
          className="h-[40vh] overflow-y-auto bg-[#0d0d1a] border-t border-[#222] px-2 py-1"
        >
          {entries.map((entry, i) => (
            <div key={i} className="flex gap-2 py-0.5 leading-tight">
              <span className="text-[#555] shrink-0">{formatTime(entry.time)}</span>
              <span className={levelColor(entry.level)}>{levelIcon(entry.level)}</span>
              <span className={`${entry.level === "error" ? "text-red-300" : entry.level === "warn" ? "text-yellow-300" : entry.level === "success" ? "text-green-300" : "text-[#aaa]"} break-all`}>
                {entry.msg}
              </span>
            </div>
          ))}
          {entries.length === 0 && (
            <div className="text-[#555] py-4 text-center">No logs yet. Tap &quot;Run checks&quot; or connect.</div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatTime(ts: number): string {
  const d = new Date(ts);
  return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}:${d.getSeconds().toString().padStart(2, "0")}.${d.getMilliseconds().toString().padStart(3, "0")}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / 1048576).toFixed(1)}MB`;
}

function levelIcon(level: DebugEntry["level"]): string {
  switch (level) {
    case "error": return "✗";
    case "warn": return "⚠";
    case "success": return "✓";
    default: return "·";
  }
}

function levelColor(level: DebugEntry["level"]): string {
  switch (level) {
    case "error": return "text-red-400";
    case "warn": return "text-yellow-400";
    case "success": return "text-green-400";
    default: return "text-[#555]";
  }
}

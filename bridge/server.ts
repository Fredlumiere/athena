import { config } from "dotenv";
config({ path: ".env.local" });

// Allow running inside a Claude Code session
delete process.env.CLAUDECODE;

process.on("unhandledRejection", (err) => {
  console.error("[bridge] Unhandled rejection:", err);
});

import express from "express";
import { createServer } from "http";
import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { WebSocketServer, WebSocket } from "ws";
import OpenAI from "openai";
import fs from "fs";
import path from "path";
import os from "os";

const app = express();
app.use(express.json());

// CORS — restricted to frontend origin
const ALLOWED_ORIGIN = process.env.CORS_ORIGIN || "http://localhost:3000";
app.use((_req, res, next) => {
  res.header("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  // Enable SharedArrayBuffer for ONNX Runtime WASM (needed by VAD on iOS Safari)
  // credentialless allows cross-origin resources (ElevenLabs WebRTC) without breaking
  res.header("Cross-Origin-Opener-Policy", "same-origin");
  res.header("Cross-Origin-Embedder-Policy", "credentialless");
  if (_req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});

// Auth token — required for all /v1 and WS endpoints
const BRIDGE_AUTH_TOKEN = process.env.BRIDGE_AUTH_TOKEN || process.env.BRIDGE_API_KEY || "";

function checkAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (!BRIDGE_AUTH_TOKEN) { next(); return; }
  const auth = req.headers.authorization;
  if (!auth || auth !== `Bearer ${BRIDGE_AUTH_TOKEN}`) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  next();
}
app.use("/v1", checkAuth);

// Session tracking: map conversation to Agent SDK session
const sessions = new Map<string, string>(); // conversationId -> sessionId
let selectedCwd: string | null = null; // cwd from the most recently selected session

// Per-connection state is now managed inside each WS connection handler
// and via the sessions Map for HTTP. No more global activeSessionId.

// ─── Runtime Shape Checks ────────────────────────────────────────────────────

function getSessionId(message: SDKMessage): string | null {
  if ("session_id" in message && typeof (message as Record<string, unknown>).session_id === "string") {
    return (message as Record<string, unknown>).session_id as string;
  }
  return null;
}

interface ContentBlock {
  type: string;
  text?: string;
}

function getAssistantContent(message: SDKMessage): ContentBlock[] | null {
  if (message.type !== "assistant") return null;
  const msg = message as Record<string, unknown>;
  const inner = msg.message as Record<string, unknown> | undefined;
  if (!inner || !Array.isArray(inner.content)) return null;
  return inner.content as ContentBlock[];
}

function getResultText(message: SDKMessage): string | null {
  if (message.type !== "result") return null;
  const msg = message as Record<string, unknown>;
  if (msg.subtype === "success" && typeof msg.result === "string") {
    return msg.result;
  }
  return null;
}

function getStreamDeltaText(message: SDKMessage): string | null {
  if (message.type !== "stream_event") return null;
  const msg = message as Record<string, unknown>;
  const event = msg.event as Record<string, unknown> | undefined;
  if (!event || event.type !== "content_block_delta") return null;
  const delta = event.delta as Record<string, unknown> | undefined;
  if (!delta || delta.type !== "text_delta" || typeof delta.text !== "string") return null;
  return delta.text;
}

const SYSTEM_PROMPT = `You are Athena, an elite AI executive assistant. You speak in a warm, confident, concise voice. You have full access to the codebase and development tools.

Key behaviors:
- Keep responses SHORT and conversational (1-3 sentences for voice)
- When asked to do something, do it and confirm briefly
- When explaining, be direct and skip filler words
- Use tools proactively: read files, edit code, run commands
- If a task is complex, give a brief status then do the work
- Never say "I'll help you with that" or similar filler. Just do it.

You are the founder's right hand. He calls you Athena. Be sharp, capable, and concise.`;

// ─── Conversation Logging Helpers ─────────────────────────────────────────────

function logConversationTurn(userMessage: string, assistantMessage: string, context?: { sessionId?: string; cwd?: string; provider?: string }) {
  const timestamp = new Date().toISOString().split('T')[1].split('.')[0]; // HH:MM:SS
  const border = "─".repeat(80);

  console.log(`\n${border}`);
  console.log(`🗣️  CONVERSATION TURN [${timestamp}]`);
  if (context) {
    const meta = [];
    if (context.provider) meta.push(`provider: ${context.provider}`);
    if (context.sessionId) meta.push(`session: ${context.sessionId.slice(0, 8)}...`);
    if (context.cwd) meta.push(`cwd: ${context.cwd.split('/').slice(-2).join('/')}`);
    if (meta.length > 0) {
      console.log(`📋 ${meta.join(' | ')}`);
    }
  }
  console.log(`${border}`);
  console.log(`👤 USER:\n${userMessage}`);
  console.log(`${border}`);
  console.log(`🤖 ATHENA:\n${assistantMessage}`);
  console.log(`${border}\n`);
}

// ─── Session Scanner ─────────────────────────────────────────────────────────

interface SessionInfo {
  id: string;
  project: string;
  cwd: string;
  lastMessage: string;
  timestamp: number;
  active?: boolean;
}

// ─── Active Session Detection ─────────────────────────────────────────────────
// A session is "active" if its JSONL file was written to very recently.
// This is more reliable than matching process cwds, because the `claude`
// process cwd may differ from the project directory stored in the session.
const ACTIVE_THRESHOLD_MS = 2 * 60 * 1000; // 2 minutes

// Cache for session scanning
let sessionCache: { sessions: SessionInfo[]; timestamp: number } | null = null;
const SESSION_CACHE_TTL = 10_000; // 10 seconds

function readFileTail(filePath: string, bytes: number = 8192): string {
  const fd = fs.openSync(filePath, "r");
  try {
    const stat = fs.fstatSync(fd);
    const readSize = Math.min(bytes, stat.size);
    const buffer = Buffer.alloc(readSize);
    fs.readSync(fd, buffer, 0, readSize, stat.size - readSize);
    return buffer.toString("utf-8");
  } finally {
    fs.closeSync(fd);
  }
}

function readFileHead(filePath: string, bytes: number = 2048): string {
  const fd = fs.openSync(filePath, "r");
  try {
    const stat = fs.fstatSync(fd);
    const readSize = Math.min(bytes, stat.size);
    const buffer = Buffer.alloc(readSize);
    fs.readSync(fd, buffer, 0, readSize, 0);
    return buffer.toString("utf-8");
  } finally {
    fs.closeSync(fd);
  }
}

// Set of valid session IDs (populated by scan, used for validation)
const knownSessionIds = new Set<string>();
const knownSessionCwds = new Map<string, string>(); // sessionId -> cwd

function scanSessions(): SessionInfo[] {
  // Return cache if fresh
  if (sessionCache && Date.now() - sessionCache.timestamp < SESSION_CACHE_TTL) {
    return sessionCache.sessions;
  }

  const claudeDir = path.join(os.homedir(), ".claude", "projects");
  const results: SessionInfo[] = [];
  knownSessionIds.clear();
  knownSessionCwds.clear();

  if (!fs.existsSync(claudeDir)) return results;

  const MAX_DEPTH = 5;

  function walkDir(dir: string, depth: number) {
    if (depth > MAX_DEPTH) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      // Skip symlinks to prevent traversal
      if (entry.isSymbolicLink()) continue;

      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walkDir(fullPath, depth + 1);
      } else if (entry.name.endsWith(".jsonl")) {
        try {
          const stat = fs.statSync(fullPath);
          const sessionId = entry.name.replace(".jsonl", "");

          // Read only tail of file (last ~8KB) for recent messages
          const tailContent = readFileTail(fullPath);
          const tailLines = tailContent.split("\n").filter(Boolean);

          let lastMessage = "";
          let cwd = "";
          const projectPath = path.relative(claudeDir, dir);

          // Parse tail lines to find useful info
          for (let i = tailLines.length - 1; i >= 0; i--) {
            try {
              const parsed = JSON.parse(tailLines[i]);
              if (!lastMessage && parsed.type === "human" && typeof parsed.message === "string") {
                lastMessage = parsed.message.slice(0, 120);
              }
              if (!cwd && parsed.cwd) {
                cwd = parsed.cwd;
              }
              if (lastMessage && cwd) break;
            } catch {
              // skip malformed lines (first line of tail may be partial)
            }
          }

          // If no cwd in tail, check head
          if (!cwd) {
            const headContent = readFileHead(fullPath);
            const headLines = headContent.split("\n").filter(Boolean);
            for (const line of headLines) {
              try {
                const parsed = JSON.parse(line);
                if (parsed.cwd) { cwd = parsed.cwd; break; }
              } catch { /* skip */ }
            }
          }

          knownSessionIds.add(sessionId);
          if (cwd) knownSessionCwds.set(sessionId, cwd);

          results.push({
            id: sessionId,
            project: projectPath,
            cwd: cwd || "unknown",
            lastMessage: lastMessage || "(no messages)",
            timestamp: stat.mtimeMs,
          });
        } catch {
          // skip unreadable files
        }
      }
    }
  }

  walkDir(claudeDir, 0);

  // Tag active sessions by recent file modification time
  const now = Date.now();
  for (const session of results) {
    session.active = (now - session.timestamp) < ACTIVE_THRESHOLD_MS;
  }

  // Sort by most recent first
  results.sort((a, b) => b.timestamp - a.timestamp);

  sessionCache = { sessions: results, timestamp: Date.now() };
  return results;
}

// ─── Routes ──────────────────────────────────────────────────────────────────

app.get("/v1/sessions", (_req, res) => {
  const allSessions = scanSessions();
  // Return top 50 to avoid overwhelming the UI
  res.json({ sessions: allSessions.slice(0, 50) });
});

app.post("/v1/session/select", (req, res) => {
  const { sessionId, cwd } = req.body;
  if (!sessionId || typeof sessionId !== "string") {
    res.status(400).json({ error: "sessionId required" });
    return;
  }

  // Validate sessionId format (UUID) and existence
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidPattern.test(sessionId)) {
    res.status(400).json({ error: "invalid sessionId format" });
    return;
  }

  // Ensure scan has run at least once
  if (knownSessionIds.size === 0) scanSessions();

  if (knownSessionIds.size > 0 && !knownSessionIds.has(sessionId)) {
    res.status(404).json({ error: "session not found" });
    return;
  }

  // Validate cwd: must match the known cwd for this session, or use the known one
  const validCwd = knownSessionCwds.get(sessionId) || process.env.ATHENA_CWD || process.cwd();
  const resolvedCwd = (cwd && knownSessionCwds.get(sessionId) === cwd) ? cwd : validCwd;

  // Check if this session is active (in use by a running Claude process).
  // If so, don't store it as the resume target — we can't resume a session
  // owned by another process. Instead, just store the cwd so the voice
  // session starts fresh in the same project directory.
  const scanned = scanSessions();
  const isActive = scanned.find(s => s.id === sessionId)?.active ?? false;

  if (!isActive) {
    sessions.set("default", sessionId);
  } else {
    sessions.delete("default");
  }
  // Store cwd for per-connection lookup and as the default voice cwd
  knownSessionCwds.set(sessionId, resolvedCwd);
  selectedCwd = resolvedCwd;

  console.log(`[bridge] Session selected: ${sessionId} (cwd: ${resolvedCwd}, active: ${isActive})`);
  res.json({ ok: true, sessionId, cwd: resolvedCwd });
});

// ─── OpenAI Voice Pipeline (WebSocket) ───────────────────────────────────────

const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

function setupWebSocket(server: ReturnType<typeof createServer>) {
  const wss = new WebSocketServer({
    server,
    path: "/ws/voice",
    verifyClient: (info, cb) => {
      if (!BRIDGE_AUTH_TOKEN) { cb(true); return; }
      // Check token in query param: ws://host/ws/voice?token=xxx
      const url = new URL(info.req.url || "", `http://${info.req.headers.host}`);
      const token = url.searchParams.get("token");
      if (token === BRIDGE_AUTH_TOKEN) {
        cb(true);
      } else {
        cb(false, 401, "Unauthorized");
      }
    },
  });

  wss.on("connection", (ws: WebSocket, req) => {
    console.log("[ws/voice] Client connected");

    // Per-connection session state
    const url = new URL(req.url || "", `http://${req.headers.host}`);
    let connSessionId = url.searchParams.get("sessionId") || sessions.get("default") || null;
    let connSessionCwd = connSessionId
      ? (knownSessionCwds.get(connSessionId) || selectedCwd || null)
      : (selectedCwd || null);

    let audioChunks: Buffer[] = [];
    let isProcessing = false;
    let shouldInterrupt = false;
    let connSttModel = process.env.OPENAI_WHISPER_MODEL || "whisper-1";

    ws.on("message", async (data: Buffer | string, isBinary: boolean) => {
      let msg: { type: string; data?: string; text?: string };

      if (isBinary) {
        // Pure binary frame = audio chunk (e.g. WAV from VAD)
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
        msg = { type: "audio", data: buf.toString("base64") };
      } else {
        // Text frame — parse as JSON command
        const str = Buffer.isBuffer(data) ? data.toString("utf-8") : String(data);
        try {
          msg = JSON.parse(str);
          console.log(`[ws/voice] Received: type=${msg.type}${msg.text ? ` text="${msg.text.slice(0, 80)}"` : ""}`);
        } catch {
          return;
        }
      }

      // Per-connection STT model config
      if (msg.type === "config") {
        const m = (msg as Record<string, unknown>).sttModel;
        if (m === "whisper-1" || m === "gpt-4o-mini-transcribe") {
          connSttModel = m;
          console.log(`[ws/voice] STT model set to: ${connSttModel}`);
        }
        return;
      }

      // Text-based input (from browser SpeechRecognition) — skip Whisper
      if (msg.type === "text" && msg.text) {
        if (isProcessing) return;
        isProcessing = true;
        shouldInterrupt = false;

        try {
          await processTextTurn(ws, msg.text);
        } catch (err) {
          console.error("[ws/voice] Error:", err);
          sendJson(ws, { type: "error", message: "Processing failed" });
        }

        isProcessing = false;
        return;
      }

      if (msg.type === "audio" && msg.data) {
        audioChunks.push(Buffer.from(msg.data, "base64"));
      } else if (msg.type === "recording_end" || msg.type === "audio_end") {
        if (isProcessing) return; // Ignore if already processing
        isProcessing = true;
        shouldInterrupt = false;

        const audioBuffer = Buffer.concat(audioChunks);
        audioChunks = [];

        try {
          await processVoiceTurn(ws, audioBuffer);
        } catch (err) {
          console.error("[ws/voice] Error:", err);
          sendJson(ws, { type: "error", message: "Processing failed" });
        }

        isProcessing = false;
      } else if (msg.type === "interrupt") {
        shouldInterrupt = true;
      }
    });

    ws.on("close", (code, reason) => {
      console.log(`[ws/voice] Client disconnected: code=${code} reason=${reason?.toString() || "none"}`);
    });

    async function processTextTurn(ws: WebSocket, transcript: string) {
      sendJson(ws, { type: "transcript", text: transcript });

      // Go straight to Claude (skip Whisper STT)
      const cwd = connSessionCwd || process.env.ATHENA_CWD || process.cwd();
      const resumeId = connSessionId || sessions.get("default");

      let fullText = "";
      try {
        const result = query({
          prompt: transcript,
          options: {
            systemPrompt: SYSTEM_PROMPT,
            cwd,
            model: process.env.ATHENA_MODEL || "claude-sonnet-4-5-20250929",
            permissionMode: "bypassPermissions",
            allowDangerouslySkipPermissions: true,
            ...(resumeId ? { resume: resumeId } : {}),
            maxTurns: 25,
            tools: { type: "preset", preset: "claude_code" },
            settingSources: ["project", "user"],
          },
        });

        for await (const message of result) {
          if (shouldInterrupt) break;

          const sid = getSessionId(message);
          if (sid) {
            connSessionId = sid;
            sessions.set("default", connSessionId);
          }

          const content = getAssistantContent(message);
          if (content) {
            const hasToolUse = content.some((block) => block.type === "tool_use");
            if (!hasToolUse) {
              const text = content
                .filter((block) => block.type === "text")
                .map((block) => block.text || "")
                .join("");
              if (text) fullText = text;
            }
          }

          const resultText = getResultText(message);
          if (!fullText && resultText) {
            fullText = resultText;
          }
        }
      } catch (err) {
        console.error("[ws/voice] Claude error:", err);
        fullText = "Sorry, I hit an error. Try again.";
      }

      if (!fullText) fullText = "I completed the task.";
      if (shouldInterrupt) return;

      // Log the conversation turn
      logConversationTurn(transcript, fullText, {
        provider: "WebSocket (text)",
        sessionId: connSessionId || undefined,
        cwd,
      });

      sendJson(ws, { type: "response_text", text: fullText });

      // TTS
      if (!openai) return;
      const sentences = splitSentences(fullText);
      const ttsModel = process.env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts";
      const ttsVoice = (process.env.OPENAI_TTS_VOICE || "coral") as "coral" | "alloy" | "echo" | "fable" | "onyx" | "nova" | "shimmer";

      for (const sentence of sentences) {
        if (shouldInterrupt) break;
        if (!sentence.trim()) continue;

        try {
          const ttsResponse = await openai.audio.speech.create({
            model: ttsModel,
            voice: ttsVoice,
            input: sentence,
            response_format: "pcm",
          });

          const arrayBuf = await ttsResponse.arrayBuffer();
          const pcmBuffer = Buffer.from(arrayBuf);

          const CHUNK_SIZE = 4096;
          for (let i = 0; i < pcmBuffer.length; i += CHUNK_SIZE) {
            if (shouldInterrupt) break;
            const chunk = pcmBuffer.subarray(i, Math.min(i + CHUNK_SIZE, pcmBuffer.length));
            sendJson(ws, {
              type: "audio_chunk",
              data: chunk.toString("base64"),
              sampleRate: 24000,
              channels: 1,
              bitDepth: 16,
            });
          }
        } catch (err) {
          console.error("[ws/voice] TTS error for sentence:", err);
        }
      }

      sendJson(ws, { type: "tts_end" });
    }

    async function processVoiceTurn(ws: WebSocket, audioBuffer: Buffer) {
      if (!openai) {
        sendJson(ws, { type: "error", message: "OpenAI not configured" });
        return;
      }

      // 1. Whisper STT (uses per-connection model from client config, or env default)
      const whisperModel = connSttModel;
      let transcript: string;
      try {
        // VAD sends WAV, legacy client may send webm — Whisper accepts both
        const isWav = audioBuffer.length > 4 && audioBuffer.toString("ascii", 0, 4) === "RIFF";
        const audioFile = new File(
          [new Uint8Array(audioBuffer)],
          isWav ? "audio.wav" : "audio.webm",
          { type: isWav ? "audio/wav" : "audio/webm" }
        );
        const sttResult = await openai.audio.transcriptions.create({
          model: whisperModel,
          file: audioFile,
        });
        transcript = sttResult.text;
      } catch (err) {
        console.error("[ws/voice] Whisper error:", err);
        sendJson(ws, { type: "error", message: "Speech recognition failed" });
        return;
      }

      if (!transcript.trim()) {
        sendJson(ws, { type: "transcript", text: "" });
        return;
      }

      sendJson(ws, { type: "transcript", text: transcript });

      // 2. Claude SDK query
      const cwd = connSessionCwd || process.env.ATHENA_CWD || process.cwd();
      const resumeId = connSessionId || sessions.get("default");

      let fullText = "";
      try {
        const result = query({
          prompt: transcript,
          options: {
            systemPrompt: SYSTEM_PROMPT,
            cwd,
            model: process.env.ATHENA_MODEL || "claude-sonnet-4-5-20250929",
            permissionMode: "bypassPermissions",
            allowDangerouslySkipPermissions: true,
            ...(resumeId ? { resume: resumeId } : {}),
            maxTurns: 25,
            tools: { type: "preset", preset: "claude_code" },
            settingSources: ["project", "user"],
          },
        });

        for await (const message of result) {
          if (shouldInterrupt) break;

          const sid = getSessionId(message);
          if (sid) {
            connSessionId = sid;
            sessions.set("default", connSessionId);
          }

          const content = getAssistantContent(message);
          if (content) {
            const hasToolUse = content.some((block) => block.type === "tool_use");
            if (!hasToolUse) {
              const text = content
                .filter((block) => block.type === "text")
                .map((block) => block.text || "")
                .join("");
              if (text) fullText = text;
            }
          }

          const resultText = getResultText(message);
          if (!fullText && resultText) {
            fullText = resultText;
          }
        }
      } catch (err) {
        console.error("[ws/voice] Claude error:", err);
        fullText = "Sorry, I hit an error. Try again.";
      }

      if (!fullText) fullText = "I completed the task.";
      if (shouldInterrupt) return;

      // Log the conversation turn
      logConversationTurn(transcript, fullText, {
        provider: `WebSocket (${connSttModel})`,
        sessionId: connSessionId || undefined,
        cwd,
      });

      sendJson(ws, { type: "response_text", text: fullText });

      // 3. OpenAI TTS — stream sentence by sentence
      const sentences = splitSentences(fullText);
      const ttsModel = process.env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts";
      const ttsVoice = (process.env.OPENAI_TTS_VOICE || "coral") as "coral" | "alloy" | "echo" | "fable" | "onyx" | "nova" | "shimmer";

      for (const sentence of sentences) {
        if (shouldInterrupt) break;
        if (!sentence.trim()) continue;

        try {
          const ttsResponse = await openai.audio.speech.create({
            model: ttsModel,
            voice: ttsVoice,
            input: sentence,
            response_format: "pcm",
          });

          const arrayBuf = await ttsResponse.arrayBuffer();
          const pcmBuffer = Buffer.from(arrayBuf);

          // Send in ~4KB chunks for smooth streaming
          const CHUNK_SIZE = 4096;
          for (let i = 0; i < pcmBuffer.length; i += CHUNK_SIZE) {
            if (shouldInterrupt) break;
            const chunk = pcmBuffer.subarray(i, Math.min(i + CHUNK_SIZE, pcmBuffer.length));
            sendJson(ws, {
              type: "audio_chunk",
              data: chunk.toString("base64"),
              sampleRate: 24000,
              channels: 1,
              bitDepth: 16,
            });
          }
        } catch (err) {
          console.error("[ws/voice] TTS error for sentence:", err);
        }
      }

      sendJson(ws, { type: "tts_end" });
    }
  });

  return wss;
}

function sendJson(ws: WebSocket, obj: Record<string, unknown>) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

function splitSentences(text: string): string[] {
  // Split on sentence boundaries while keeping the delimiters
  const parts = text.match(/[^.!?]+[.!?]+[\s]*/g);
  if (!parts) return [text];
  // If there's remaining text after the last match, add it
  const joined = parts.join("");
  if (joined.length < text.length) {
    parts.push(text.slice(joined.length));
  }
  return parts;
}

// ─── ElevenLabs Chat Completions (existing) ──────────────────────────────────

app.post("/v1/chat/completions", async (req, res) => {
  const { messages, stream } = req.body;

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    res.status(400).json({ error: "messages array required" });
    return;
  }

  // Extract the latest user message
  const lastUserMsg = [...messages].reverse().find((m: { role: string }) => m.role === "user");
  if (!lastUserMsg) {
    res.status(400).json({ error: "no user message found" });
    return;
  }

  const userText =
    typeof lastUserMsg.content === "string"
      ? lastUserMsg.content
      : Array.isArray(lastUserMsg.content)
        ? lastUserMsg.content
            .filter((c: { type: string }) => c.type === "text")
            .map((c: { text: string }) => c.text)
            .join(" ")
        : "";

  // Derive a conversation ID from the messages to track sessions
  const convId = req.body.user_id || "default";
  const existingSessionId = sessions.get(convId);

  if (stream) {
    // SSE streaming response
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    const responseId = `chatcmpl-${Date.now()}`;
    let chunkIndex = 0;
    let sessionId: string | null = null;
    let finalText = "";
    let lastAssistantText = "";

    try {
      const result = query({
        prompt: userText,
        options: {
          systemPrompt: SYSTEM_PROMPT,
          cwd: (existingSessionId ? knownSessionCwds.get(existingSessionId) : null) || process.env.ATHENA_CWD || process.cwd(),
          model: process.env.ATHENA_MODEL || "claude-sonnet-4-5-20250929",
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          ...(existingSessionId ? { resume: existingSessionId } : {}),
          includePartialMessages: true,
          maxTurns: 25,
          tools: { type: "preset", preset: "claude_code" },
          settingSources: ["project", "user"],
        },
      });

      for await (const message of result) {
        // Capture session ID for continuation
        const sid = getSessionId(message);
        if (sid && !sessionId) {
          sessionId = sid;
          sessions.set(convId, sessionId);
        }

        const deltaText = getStreamDeltaText(message);
        if (deltaText) {
          lastAssistantText += deltaText;
        }

        const content = getAssistantContent(message);
        if (content) {
          // Complete assistant message: check if it's text-only (final response)
          const hasToolUse = content.some((block) => block.type === "tool_use");

          if (!hasToolUse) {
            // This is likely the final text response, stream it
            const text = content
              .filter((block) => block.type === "text")
              .map((block) => block.text || "")
              .join("");

            if (text) {
              finalText = text;
              // Stream the text in chunks for natural TTS pacing
              const words = text.split(/(\s+)/);
              for (const word of words) {
                if (!word) continue;
                const chunk = {
                  id: responseId,
                  object: "chat.completion.chunk",
                  created: Math.floor(Date.now() / 1000),
                  model: "athena",
                  choices: [
                    {
                      index: 0,
                      delta: { content: word, ...(chunkIndex === 0 ? { role: "assistant" } : {}) },
                      finish_reason: null,
                    },
                  ],
                };
                res.write(`data: ${JSON.stringify(chunk)}\n\n`);
                chunkIndex++;
              }
            }
          } else {
            // Tool use message: send a buffer word so ElevenLabs knows we're working
            if (chunkIndex === 0) {
              const bufferChunk = {
                id: responseId,
                object: "chat.completion.chunk",
                created: Math.floor(Date.now() / 1000),
                model: "athena",
                choices: [
                  {
                    index: 0,
                    delta: { content: "... ", role: "assistant" },
                    finish_reason: null,
                  },
                ],
              };
              res.write(`data: ${JSON.stringify(bufferChunk)}\n\n`);
              chunkIndex++;
            }
          }
        }

        const resultText = getResultText(message);
        if (message.type === "result") {
          // If we haven't streamed anything yet, use the result text
          if (chunkIndex === 0 && resultText) {
            const words = resultText.split(/(\s+)/);
            for (const word of words) {
              if (!word) continue;
              const chunk = {
                id: responseId,
                object: "chat.completion.chunk",
                created: Math.floor(Date.now() / 1000),
                model: "athena",
                choices: [
                  {
                    index: 0,
                    delta: { content: word, ...(chunkIndex === 0 ? { role: "assistant" } : {}) },
                    finish_reason: null,
                  },
                ],
              };
              res.write(`data: ${JSON.stringify(chunk)}\n\n`);
              chunkIndex++;
            }
          }

          // Send finish
          const finishChunk = {
            id: responseId,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: "athena",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          };
          res.write(`data: ${JSON.stringify(finishChunk)}\n\n`);
          res.write("data: [DONE]\n\n");
        }
      }

      // Log the conversation after completion
      const responseText = finalText || lastAssistantText || "I completed the task.";
      logConversationTurn(userText, responseText, {
        provider: "ElevenLabs (streaming)",
        sessionId: sessionId || existingSessionId || undefined,
        cwd: (existingSessionId ? knownSessionCwds.get(existingSessionId) : null) || process.env.ATHENA_CWD || process.cwd(),
      });
    } catch (err) {
      console.error("[bridge] Error:", err);
      const errorMsg = "Sorry, I hit an error. Try again.";

      // Send error as text if we haven't finished
      const errChunk = {
        id: responseId,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: "athena",
        choices: [
          {
            index: 0,
            delta: {
              content: errorMsg,
              ...(chunkIndex === 0 ? { role: "assistant" } : {}),
            },
            finish_reason: null,
          },
        ],
      };
      res.write(`data: ${JSON.stringify(errChunk)}\n\n`);
      res.write(
        `data: ${JSON.stringify({
          id: responseId,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: "athena",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        })}\n\n`
      );
      res.write("data: [DONE]\n\n");

      // Log the error conversation
      logConversationTurn(userText, errorMsg, {
        provider: "ElevenLabs (streaming)",
        sessionId: sessionId || existingSessionId || undefined,
        cwd: (existingSessionId ? knownSessionCwds.get(existingSessionId) : null) || process.env.ATHENA_CWD || process.cwd(),
      });
    }

    res.end();
  } else {
    // Non-streaming response
    try {
      const cwd = (existingSessionId ? knownSessionCwds.get(existingSessionId) : null) || process.env.ATHENA_CWD || process.cwd();
      const result = query({
        prompt: userText,
        options: {
          systemPrompt: SYSTEM_PROMPT,
          cwd,
          model: process.env.ATHENA_MODEL || "claude-sonnet-4-5-20250929",
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          ...(existingSessionId ? { resume: existingSessionId } : {}),
          maxTurns: 25,
          tools: { type: "preset", preset: "claude_code" },
          settingSources: ["project", "user"],
          stderr: (data: string) => process.stderr.write("[claude] " + data),
        },
      });

      let responseText = "";
      let capturedSessionId = existingSessionId;
      for await (const message of result) {
        const sid = getSessionId(message);
        if (sid) {
          capturedSessionId = sid;
          sessions.set(convId, sid);
        }
        const resultText = getResultText(message);
        if (resultText) {
          responseText = resultText;
        }
      }

      const finalResponse = responseText || "I completed the task.";

      // Log the conversation
      logConversationTurn(userText, finalResponse, {
        provider: "ElevenLabs (non-streaming)",
        sessionId: capturedSessionId || undefined,
        cwd,
      });

      const response = {
        id: `chatcmpl-${Date.now()}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: "athena",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: finalResponse },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      };
      res.status(200).json(response);
    } catch (err) {
      console.error("[bridge] Error:", err instanceof Error ? err.message : err);
      console.error("[bridge] Stack:", err instanceof Error ? err.stack : "n/a");

      const errorMsg = "Sorry, I hit an error. Try again.";
      logConversationTurn(userText, errorMsg, {
        provider: "ElevenLabs (non-streaming)",
        cwd: (existingSessionId ? knownSessionCwds.get(existingSessionId) : null) || process.env.ATHENA_CWD || process.cwd(),
      });

      res.status(500).json({ error: "Agent query failed", details: err instanceof Error ? err.message : String(err) });
    }
  }
});

// Health check — no sensitive data
app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

// Test route
app.post("/test", (_req, res) => {
  console.log("[bridge] Test route hit");
  res.json({ ok: true });
});

// ─── Launcher mode auth ─────────────────────────────────────────────────────
// When ATHENA_TOKEN is set (via npm run athena), skip PIN — the ngrok URL is the secret
const ATHENA_TOKEN = process.env.ATHENA_TOKEN || "";

app.get("/api/auth/mode", (_req, res) => {
  res.json({ skipAuth: !!ATHENA_TOKEN });
});

// ─── Reverse proxy to Next.js for non-bridge routes ─────────────────────────

import { createProxyMiddleware } from "http-proxy-middleware";

const NEXTJS_URL = process.env.NEXTJS_URL || "http://localhost:3001";
app.use(
  "/",
  createProxyMiddleware({
    target: NEXTJS_URL,
    changeOrigin: true,
    ws: false, // We handle WS ourselves via /ws/voice
  })
);

// ─── Start Server with WebSocket ─────────────────────────────────────────────

const PORT = parseInt(process.env.BRIDGE_PORT || "8013", 10);
const server = createServer(app);
const wss = setupWebSocket(server);

const BIND_HOST = process.env.BRIDGE_HOST || "0.0.0.0";
server.listen(PORT, BIND_HOST, () => {
  console.log(`[bridge] Athena LLM bridge running on http://localhost:${PORT}`);
  console.log(`[bridge] Proxying to Next.js at ${NEXTJS_URL}`);
  console.log(`[bridge] Endpoints:`);
  console.log(`  POST http://localhost:${PORT}/v1/chat/completions`);
  console.log(`  GET  http://localhost:${PORT}/v1/sessions`);
  console.log(`  POST http://localhost:${PORT}/v1/session/select`);
  console.log(`  WS   ws://localhost:${PORT}/ws/voice`);
  console.log(`[bridge] CWD: ${process.env.ATHENA_CWD || process.cwd()}`);
  console.log(`[bridge] OpenAI TTS: ${openai ? "enabled" : "disabled (no OPENAI_API_KEY)"}`);
});

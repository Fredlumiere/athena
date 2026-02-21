#!/usr/bin/env npx tsx
import { config as loadEnv } from "dotenv";
import { spawn, ChildProcess } from "child_process";
import { randomUUID } from "crypto";
import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";
import qrcode from "qrcode-terminal";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env.local so we have ELEVENLABS_API_KEY etc.
loadEnv({ path: path.resolve(__dirname, "..", ".env.local") });

// ─── Config ─────────────────────────────────────────────────────────────────

const NEXT_PORT = 3001;
const BRIDGE_PORT = 8013;
const NGROK_API = "http://127.0.0.1:4040/api/tunnels";
const NGROK_DOMAIN = process.env.NGROK_DOMAIN || "athena-voice.ngrok.app";
const TOKEN = randomUUID();

const children: ChildProcess[] = [];

// ─── Helpers ────────────────────────────────────────────────────────────────

function log(msg: string) {
  console.log(`\x1b[36m[athena]\x1b[0m ${msg}`);
}

function logError(msg: string) {
  console.error(`\x1b[31m[athena]\x1b[0m ${msg}`);
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function cleanup() {
  log("Shutting down...");
  for (const child of children) {
    try { child.kill("SIGTERM"); } catch {}
  }
  process.exit(0);
}

process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);

// ─── Detect most recent Claude Code session ─────────────────────────────────

function detectSession(): { id: string; cwd: string } | null {
  const claudeDir = path.join(os.homedir(), ".claude", "projects");
  if (!fs.existsSync(claudeDir)) return null;

  let newest: { id: string; cwd: string; mtime: number } | null = null;

  function walk(dir: string, depth: number) {
    if (depth > 5) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }

    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else if (entry.name.endsWith(".jsonl")) {
        try {
          const stat = fs.statSync(full);
          if (!newest || stat.mtimeMs > newest.mtime) {
            const id = entry.name.replace(".jsonl", "");
            // Read head to find cwd
            let cwd = process.cwd();
            const fd = fs.openSync(full, "r");
            const buf = Buffer.alloc(2048);
            const bytesRead = fs.readSync(fd, buf, 0, 2048, 0);
            fs.closeSync(fd);
            const head = buf.toString("utf-8", 0, bytesRead);
            for (const line of head.split("\n")) {
              try {
                const parsed = JSON.parse(line);
                if (parsed.cwd) { cwd = parsed.cwd; break; }
              } catch {}
            }
            newest = { id, cwd, mtime: stat.mtimeMs };
          }
        } catch {}
      }
    }
  }

  walk(claudeDir, 0);
  return newest ? { id: newest.id, cwd: newest.cwd } : null;
}

// ─── Check if port is in use ────────────────────────────────────────────────

async function isPortInUse(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`).catch(() => null);
    return res !== null;
  } catch {
    return false;
  }
}

// ─── Poll ngrok API for public URL ──────────────────────────────────────────

async function getNgrokUrl(maxAttempts = 30): Promise<string> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await fetch(NGROK_API);
      const data = await res.json() as { tunnels: { public_url: string; proto: string }[] };
      const tunnel = data.tunnels.find((t) => t.proto === "https") || data.tunnels[0];
      if (tunnel) return tunnel.public_url;
    } catch {}
    await sleep(1000);
  }
  throw new Error("Could not get ngrok URL after 30s");
}

// ─── Update ElevenLabs agent callback URL ───────────────────────────────────

async function updateElevenLabsAgentUrl(ngrokUrl: string) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  const agentId = process.env.NEXT_PUBLIC_ELEVENLABS_AGENT_ID;
  if (!apiKey || !agentId) {
    log("Skipping ElevenLabs URL update (no API key or agent ID)");
    return;
  }

  const newUrl = `${ngrokUrl}/v1/chat/completions`;
  log(`Updating ElevenLabs agent LLM URL → ${newUrl}`);

  try {
    // Get current agent config to preserve existing settings
    const getRes = await fetch(`https://api.elevenlabs.io/v1/convai/agents/${agentId}`, {
      headers: { "xi-api-key": apiKey },
    });

    if (!getRes.ok) {
      logError(`Failed to get ElevenLabs agent config: ${getRes.status}`);
      return;
    }

    const agent = (await getRes.json()) as Record<string, unknown>;
    const convConfig = agent.conversation_config as Record<string, unknown> | undefined;
    const agentConfig = convConfig?.agent as Record<string, unknown> | undefined;
    const promptConfig = agentConfig?.prompt as Record<string, unknown> | undefined;
    const existingCustomLlm = promptConfig?.custom_llm as Record<string, unknown> | undefined;

    // Patch just the custom LLM URL
    const patchRes = await fetch(`https://api.elevenlabs.io/v1/convai/agents/${agentId}`, {
      method: "PATCH",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        conversation_config: {
          agent: {
            prompt: {
              llm: promptConfig?.llm || "custom-llm",
              custom_llm: {
                ...existingCustomLlm,
                url: newUrl,
              },
            },
          },
        },
      }),
    });

    if (patchRes.ok) {
      log("ElevenLabs agent URL updated ✓");
    } else {
      const text = await patchRes.text();
      logError(`Failed to update ElevenLabs agent: ${patchRes.status} ${text}`);
    }
  } catch (err) {
    logError(`ElevenLabs agent update failed: ${err}`);
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log();
  log("Starting Athena...");
  console.log();

  // 1. Detect session
  const session = detectSession();
  if (session) {
    log(`Detected session: ${session.id.slice(0, 8)}... (${session.cwd})`);
  } else {
    log("No existing session detected — will start fresh");
  }

  // 2. Start Next.js if not already running
  const nextRunning = await isPortInUse(NEXT_PORT);
  if (nextRunning) {
    log(`Next.js already running on port ${NEXT_PORT}`);
  } else {
    log("Starting Next.js dev server...");
    const next = spawn("npx", ["next", "dev", "--port", String(NEXT_PORT)], {
      cwd: path.resolve(__dirname, ".."),
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ATHENA_TOKEN: TOKEN },
    });
    children.push(next);
    next.stdout?.on("data", (d: Buffer) => {
      const line = d.toString().trim();
      if (line.includes("Ready") || line.includes("ready")) {
        log(`Next.js ready on port ${NEXT_PORT}`);
      }
    });
    next.stderr?.on("data", (d: Buffer) => {
      const line = d.toString().trim();
      // Suppress noisy webpack output, only show errors
      if (line.toLowerCase().includes("error")) {
        logError(`[next] ${line}`);
      }
    });
    // Wait for Next.js to be ready
    for (let i = 0; i < 30; i++) {
      await sleep(1000);
      if (await isPortInUse(NEXT_PORT)) break;
    }
  }

  // 3. Start bridge server
  const bridgeRunning = await isPortInUse(BRIDGE_PORT);
  if (bridgeRunning) {
    log(`Bridge already running on port ${BRIDGE_PORT} — restarting with token...`);
    // Can't inject token into running bridge, so we skip restarting for now
    // In practice the user should not have a bridge already running
  }

  if (!bridgeRunning) {
    log("Starting bridge server...");
    const bridge = spawn("npx", ["tsx", "bridge/server.ts"], {
      cwd: path.resolve(__dirname, ".."),
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        ATHENA_TOKEN: TOKEN,
        CORS_ORIGIN: "*",
        BRIDGE_PORT: String(BRIDGE_PORT),
        NEXTJS_URL: `http://localhost:${NEXT_PORT}`,
      },
    });
    children.push(bridge);
    bridge.stdout?.on("data", (d: Buffer) => {
      const line = d.toString().trim();
      if (line) log(`[bridge] ${line}`);
    });
    bridge.stderr?.on("data", (d: Buffer) => {
      const line = d.toString().trim();
      if (line && !line.includes("ExperimentalWarning")) {
        // Only show non-noisy stderr
        if (line.toLowerCase().includes("error")) {
          logError(`[bridge] ${line}`);
        }
      }
    });
    // Wait for bridge to be ready
    for (let i = 0; i < 15; i++) {
      await sleep(1000);
      if (await isPortInUse(BRIDGE_PORT)) break;
    }
  }

  // 4. Start ngrok (reuse existing tunnel if one is already running)
  let publicUrl: string;
  let ngrokExisted = false;

  try {
    publicUrl = await getNgrokUrl(2); // Quick check — 2 attempts (2s)
    log(`Reusing existing ngrok tunnel: ${publicUrl}`);
    ngrokExisted = true;
  } catch {
    // No existing tunnel — start a new one with static domain
    log(`Starting ngrok tunnel (${NGROK_DOMAIN})...`);
    const ngrok = spawn("ngrok", ["http", String(BRIDGE_PORT), "--url", NGROK_DOMAIN], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    children.push(ngrok);
    ngrok.stderr?.on("data", (d: Buffer) => {
      const line = d.toString().trim();
      if (line.toLowerCase().includes("error")) {
        logError(`[ngrok] ${line}`);
      }
    });

    try {
      publicUrl = await getNgrokUrl();
    } catch {
      logError("Failed to get ngrok URL. Is ngrok installed and configured?");
      cleanup();
      return;
    }
  }
  log(`Tunnel: ${publicUrl}`);

  // 6. Update ElevenLabs agent callback URL so their servers can reach the bridge
  await updateElevenLabsAgentUrl(publicUrl);

  // 7. Auto-select session via bridge API
  if (session) {
    try {
      const res = await fetch(`http://127.0.0.1:${BRIDGE_PORT}/v1/session/select`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: session.id, cwd: session.cwd }),
      });
      if (res.ok) {
        log(`Session auto-selected: ${session.id.slice(0, 8)}...`);
      }
    } catch {
      log("Could not auto-select session (will use session picker)");
    }
  }

  // 8. Build URL and show QR code
  const fullUrl = publicUrl;

  console.log();
  console.log("\x1b[1m  Scan this QR code on your phone:\x1b[0m");
  console.log();
  qrcode.generate(fullUrl, { small: true }, (code: string) => {
    // Indent the QR code
    const indented = code.split("\n").map((line: string) => `  ${line}`).join("\n");
    console.log(indented);
  });
  console.log();
  console.log(`  \x1b[2m${fullUrl}\x1b[0m`);
  console.log();
  log("Press Ctrl+C to stop all services");
  console.log();
}

main().catch((err) => {
  logError(err.message || String(err));
  cleanup();
});

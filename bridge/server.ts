// Allow running inside a Claude Code session
delete process.env.CLAUDECODE;

process.on("unhandledRejection", (err) => {
  console.error("[bridge] Unhandled rejection:", err);
});

import express from "express";
import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";

const app = express();
app.use(express.json());

// Simple bearer token auth (optional, set BRIDGE_API_KEY to enable)
const BRIDGE_API_KEY = process.env.BRIDGE_API_KEY;
if (BRIDGE_API_KEY) {
  app.use("/v1", (req, res, next) => {
    const auth = req.headers.authorization;
    if (!auth || auth !== `Bearer ${BRIDGE_API_KEY}`) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  });
}

// Session tracking: map conversation to Agent SDK session
const sessions = new Map<string, string>(); // conversationId -> sessionId

const SYSTEM_PROMPT = `You are Athena, an elite AI executive assistant. You speak in a warm, confident, concise voice. You have full access to the codebase and development tools.

Key behaviors:
- Keep responses SHORT and conversational (1-3 sentences for voice)
- When asked to do something, do it and confirm briefly
- When explaining, be direct and skip filler words
- Use tools proactively: read files, edit code, run commands
- If a task is complex, give a brief status then do the work
- Never say "I'll help you with that" or similar filler. Just do it.

You are the founder's right hand. He calls you Athena. Be sharp, capable, and concise.`;

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

  console.log(`[bridge] User: ${userText}`);

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
          cwd: process.env.ATHENA_CWD || process.cwd(),
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
        if ("session_id" in message && message.session_id && !sessionId) {
          sessionId = message.session_id;
          sessions.set(convId, sessionId);
        }

        if (message.type === "stream_event") {
          // Partial streaming: extract text deltas
          const event = message.event as {
            type: string;
            delta?: { type: string; text?: string };
          };
          if (
            event.type === "content_block_delta" &&
            event.delta?.type === "text_delta" &&
            event.delta.text
          ) {
            lastAssistantText += event.delta.text;
          }
        } else if (message.type === "assistant") {
          // Complete assistant message: check if it's text-only (final response)
          const apiMsg = (message as { message: { content: Array<{ type: string; text?: string }> } }).message;
          const hasToolUse = apiMsg.content.some(
            (block: { type: string }) => block.type === "tool_use"
          );

          if (!hasToolUse) {
            // This is likely the final text response, stream it
            const text = apiMsg.content
              .filter((block: { type: string }) => block.type === "text")
              .map((block: { text?: string }) => block.text || "")
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
        } else if (message.type === "result") {
          // If we haven't streamed anything yet, use the result text
          const resultMsg = message as { subtype: string; result?: string };
          if (chunkIndex === 0 && resultMsg.subtype === "success" && resultMsg.result) {
            const words = resultMsg.result.split(/(\s+)/);
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
    } catch (err) {
      console.error("[bridge] Error:", err);
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
              content: "Sorry, I hit an error. Try again.",
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
    }

    res.end();
  } else {
    // Non-streaming response
    try {
      console.log("[bridge] Starting agent query...");
      const result = query({
        prompt: userText,
        options: {
          systemPrompt: SYSTEM_PROMPT,
          cwd: process.env.ATHENA_CWD || process.cwd(),
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
      for await (const message of result) {
        console.log("[bridge] Message type:", message.type);
        if ("session_id" in message && message.session_id) {
          sessions.set(convId, message.session_id);
        }
        if (message.type === "result") {
          const resultMsg = message as { subtype: string; result?: string; errors?: string[] };
          console.log("[bridge] Result:", resultMsg.subtype, resultMsg.result?.slice(0, 100) || resultMsg.errors);
          if (resultMsg.subtype === "success" && resultMsg.result) {
            responseText = resultMsg.result;
          }
        }
      }

      const response = {
        id: `chatcmpl-${Date.now()}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: "athena",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: responseText || "I completed the task." },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      };
      console.log("[bridge] Sending response:", JSON.stringify(response).slice(0, 200));
      res.status(200).json(response);
    } catch (err) {
      console.error("[bridge] Error:", err instanceof Error ? err.message : err);
      console.error("[bridge] Stack:", err instanceof Error ? err.stack : "n/a");
      res.status(500).json({ error: "Agent query failed", details: err instanceof Error ? err.message : String(err) });
    }
  }
});

// Health check
app.get("/health", (_req, res) => {
  res.json({ status: "ok", sessions: sessions.size });
});

// Test route
app.post("/test", (_req, res) => {
  console.log("[bridge] Test route hit");
  res.json({ ok: true });
});

const PORT = parseInt(process.env.BRIDGE_PORT || "8013", 10);
app.listen(PORT, () => {
  console.log(`[bridge] Athena LLM bridge running on http://localhost:${PORT}`);
  console.log(`[bridge] Endpoint: POST http://localhost:${PORT}/v1/chat/completions`);
  console.log(`[bridge] CWD: ${process.env.ATHENA_CWD || process.cwd()}`);
});

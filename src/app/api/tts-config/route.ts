import { NextResponse } from "next/server";

export async function GET() {
  const elevenlabsConfigured = !!(
    process.env.ELEVENLABS_API_KEY &&
    process.env.NEXT_PUBLIC_ELEVENLABS_AGENT_ID
  );
  const openaiConfigured = !!process.env.OPENAI_API_KEY;

  return NextResponse.json({
    providers: {
      elevenlabs: { available: elevenlabsConfigured },
      openai: { available: openaiConfigured },
    },
    // Bridge URL for WebSocket connection (client needs this for OpenAI voice)
    bridgeUrl: process.env.BRIDGE_URL || "http://localhost:8013",
    // Bridge auth token for WebSocket connection (only if set)
    bridgeToken: process.env.BRIDGE_AUTH_TOKEN || process.env.BRIDGE_API_KEY || "",
  });
}

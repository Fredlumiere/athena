"use client";

import { useConversation } from "@elevenlabs/react";
import { useCallback, useRef } from "react";
import type { VoiceProviderCallbacks, VoiceProviderHandle, VoiceProviderStatus } from "./types";

export type { VoiceProviderStatus, VoiceProviderHandle, VoiceProviderCallbacks } from "./types";
export type { VoiceMessage } from "./types";

type Voice = { id: string; name: string; desc: string };

export const VOICES: Voice[] = [
  { id: "EXAVITQu4vr4xnSDxMaL", name: "Sarah", desc: "Mature, confident" },
  { id: "cgSgspJ2msm6clMCkdW9", name: "Jessica", desc: "Playful, warm" },
  { id: "Xb7hH8MSUJpSbSDYk0k2", name: "Alice", desc: "Clear, British" },
  { id: "XrExE9yKIg1WjnnlVkGX", name: "Matilda", desc: "Professional" },
  { id: "pFZP5JQG7iQjIQuC4Bku", name: "Lily", desc: "Velvety, British" },
  { id: "hpp4J3VqNfWAUOO0d1Us", name: "Bella", desc: "Bright, warm" },
];

export function useElevenLabsProvider(
  callbacks: VoiceProviderCallbacks,
  selectedVoiceId: string
): VoiceProviderHandle {
  const cbRef = useRef(callbacks);
  cbRef.current = callbacks;

  const conversation = useConversation({
    onConnect: () => {
      cbRef.current.debug.success("ElevenLabs: WebRTC connected");
      cbRef.current.onStatusChange("connected");
    },
    onDisconnect: () => {
      cbRef.current.debug.log("ElevenLabs: disconnected");
      cbRef.current.onStatusChange("disconnected");
      cbRef.current.onSpeakingChange(false);
      cbRef.current.onThinkingChange(false);
    },
    onMessage: (msg) => {
      if (msg.source === "user") {
        cbRef.current.debug.log(`ElevenLabs user: "${msg.message.slice(0, 80)}"`);
        cbRef.current.onThinkingChange(true);
        cbRef.current.onMessage({ role: "user", text: msg.message });
      } else if (msg.source === "ai") {
        cbRef.current.debug.log(`ElevenLabs AI: "${msg.message.slice(0, 80)}"`);
        cbRef.current.onThinkingChange(false);
        cbRef.current.onSpeakingChange(false);
        cbRef.current.onMessage({ role: "assistant", text: msg.message });
      }
    },
    onError: (error) => {
      const msg = typeof error === "string" ? error : JSON.stringify(error);
      cbRef.current.debug.error(`ElevenLabs error: ${msg}`);
      cbRef.current.onThinkingChange(false);
      cbRef.current.onSpeakingChange(false);
      cbRef.current.onError(typeof error === "string" ? error : "Connection failed");
    },
  });

  const connect = useCallback(async () => {
    const dbg = cbRef.current.debug;
    const agentId = process.env.NEXT_PUBLIC_ELEVENLABS_AGENT_ID;
    dbg.log(`ElevenLabs: agent ID = ${agentId ? agentId.slice(0, 8) + "..." : "MISSING"}`);
    if (!agentId) {
      cbRef.current.onError("Missing agent ID. Check NEXT_PUBLIC_ELEVENLABS_AGENT_ID.");
      return;
    }

    cbRef.current.onStatusChange("connecting");

    try {
      // Request mic permission
      dbg.log("ElevenLabs: requesting mic...");
      cbRef.current.onMessage({ role: "event", text: "Requesting microphone..." });
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const tracks = stream.getAudioTracks();
        dbg.success(`Mic ready: ${tracks.length} track, ${tracks[0]?.label || "no label"}`);
        stream.getTracks().forEach((t) => t.stop());
        cbRef.current.onMessage({ role: "event", text: "Mic granted. Connecting to ElevenLabs..." });
      } catch (micErr) {
        const name = micErr instanceof Error ? micErr.name : "";
        const msg = micErr instanceof Error ? micErr.message : String(micErr);
        dbg.error(`Mic failed: ${name} — ${msg}`);
        if (name === "NotAllowedError" || name === "PermissionDeniedError") {
          cbRef.current.onError("Mic permission denied. Check Settings → Safari → Microphone.");
        } else {
          cbRef.current.onError(`Mic error: ${msg}`);
        }
        cbRef.current.onStatusChange("disconnected");
        return;
      }

      dbg.log(`ElevenLabs: starting session (voice=${selectedVoiceId.slice(0, 8)}..., type=webrtc)`);
      await conversation.startSession({
        agentId,
        connectionType: "webrtc",
        overrides: {
          tts: { voiceId: selectedVoiceId },
        },
      });
      dbg.success("ElevenLabs: session started");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      dbg.error(`ElevenLabs connect failed: ${msg}`);
      cbRef.current.onStatusChange("disconnected");
      cbRef.current.onError(msg);
    }
  }, [conversation, selectedVoiceId]);

  const disconnect = useCallback(async () => {
    cbRef.current.debug.log("ElevenLabs: ending session...");
    await conversation.endSession();
  }, [conversation]);

  const status: VoiceProviderStatus =
    conversation.status === "connected" ? "connected" : "disconnected";

  return {
    connect,
    disconnect,
    status,
    isSpeaking: conversation.isSpeaking,
  };
}

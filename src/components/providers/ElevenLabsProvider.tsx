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
      cbRef.current.onStatusChange("connected");
    },
    onDisconnect: () => {
      cbRef.current.onStatusChange("disconnected");
      cbRef.current.onSpeakingChange(false);
      cbRef.current.onThinkingChange(false);
    },
    onMessage: (msg) => {
      if (msg.source === "user") {
        cbRef.current.onThinkingChange(true);
        cbRef.current.onMessage({ role: "user", text: msg.message });
      } else if (msg.source === "ai") {
        cbRef.current.onThinkingChange(false);
        cbRef.current.onSpeakingChange(false);
        cbRef.current.onMessage({ role: "assistant", text: msg.message });
      }
    },
    onError: (error) => {
      cbRef.current.onThinkingChange(false);
      cbRef.current.onSpeakingChange(false);
      cbRef.current.onError(typeof error === "string" ? error : "Connection failed");
    },
  });

  const connect = useCallback(async () => {
    const agentId = process.env.NEXT_PUBLIC_ELEVENLABS_AGENT_ID;
    if (!agentId) {
      cbRef.current.onError("Missing agent ID. Check NEXT_PUBLIC_ELEVENLABS_AGENT_ID.");
      return;
    }

    cbRef.current.onStatusChange("connecting");

    try {
      // Request mic permission
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());

      await conversation.startSession({
        agentId,
        connectionType: "webrtc",
        overrides: {
          tts: { voiceId: selectedVoiceId },
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      cbRef.current.onStatusChange("disconnected");
      cbRef.current.onError(msg);
    }
  }, [conversation, selectedVoiceId]);

  const disconnect = useCallback(async () => {
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

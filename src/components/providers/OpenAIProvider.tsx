"use client";

import { useCallback, useRef, useState } from "react";
import type { VoiceProviderCallbacks, VoiceProviderHandle, VoiceProviderStatus } from "./types";

export function useOpenAIProvider(
  callbacks: VoiceProviderCallbacks,
  bridgeUrl: string,
  bridgeToken: string = ""
): VoiceProviderHandle {
  const [status, setStatus] = useState<VoiceProviderStatus>("disconnected");
  const [isSpeaking, setIsSpeakingState] = useState(false);

  const cbRef = useRef(callbacks);
  cbRef.current = callbacks;

  const wsRef = useRef<WebSocket | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const vadRef = useRef<{ destroy: () => Promise<void> } | null>(null);
  const playQueueRef = useRef<ArrayBuffer[]>([]);
  const isPlayingRef = useRef(false);
  const currentSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const isConnectedRef = useRef(false);

  // ─── Audio Playback ─────────────────────────────────────────────────────

  const playNextChunk = useCallback(async () => {
    if (isPlayingRef.current || playQueueRef.current.length === 0) return;
    isPlayingRef.current = true;

    const ctx = audioContextRef.current;
    if (!ctx || ctx.state === "closed") {
      isPlayingRef.current = false;
      return;
    }

    while (playQueueRef.current.length > 0) {
      const pcmData = playQueueRef.current.shift()!;

      // Convert PCM16 to Float32
      const int16 = new Int16Array(pcmData);
      const float32 = new Float32Array(int16.length);
      for (let i = 0; i < int16.length; i++) {
        float32[i] = int16[i] / 32768;
      }

      const audioBuffer = ctx.createBuffer(1, float32.length, 24000);
      audioBuffer.getChannelData(0).set(float32);

      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(ctx.destination);
      currentSourceRef.current = source;

      await new Promise<void>((resolve) => {
        source.onended = () => {
          if (currentSourceRef.current === source) {
            currentSourceRef.current = null;
          }
          resolve();
        };
        source.start();
      });

      // Check if interrupted
      if (!isPlayingRef.current) return;
    }

    isPlayingRef.current = false;
    setIsSpeakingState(false);
    cbRef.current.onSpeakingChange(false);
  }, []);

  const stopPlayback = useCallback(() => {
    playQueueRef.current = [];
    isPlayingRef.current = false;

    // Stop currently playing audio immediately
    if (currentSourceRef.current) {
      try { currentSourceRef.current.stop(); } catch { /* already stopped */ }
      currentSourceRef.current = null;
    }

    setIsSpeakingState(false);
    cbRef.current.onSpeakingChange(false);
  }, []);

  // ─── Connect ────────────────────────────────────────────────────────────

  const connect = useCallback(async () => {
    setStatus("connecting");
    cbRef.current.onStatusChange("connecting");

    try {
      // Request mic
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      // Create AudioContext for playback — must resume on iOS Safari
      const ctx = new AudioContext({ sampleRate: 24000 });
      if (ctx.state === "suspended") await ctx.resume();
      audioContextRef.current = ctx;

      // Connect WebSocket with auth token
      const wsBase = bridgeUrl.replace(/^http/, "ws") + "/ws/voice";
      const wsUrl = bridgeToken ? `${wsBase}?token=${encodeURIComponent(bridgeToken)}` : wsBase;
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = async () => {
        setStatus("connected");
        cbRef.current.onStatusChange("connected");
        isConnectedRef.current = true;

        // Initialize VAD after WebSocket is ready
        try {
          const { MicVAD } = await import("@ricky0123/vad-web");
          const vad = await MicVAD.new({
            // Force single-threaded WASM — mobile Safari lacks SharedArrayBuffer
            ortConfig: (ort) => { ort.env.wasm.numThreads = 1; },
            getStream: async () => stream,
            positiveSpeechThreshold: 0.6,
            negativeSpeechThreshold: 0.3,
            minSpeechMs: 200,
            preSpeechPadMs: 500,
            redemptionMs: 800,
            onSpeechStart: () => {
              // Visual feedback that mic is picking up speech
              cbRef.current.onMessage({ role: "event", text: "Listening..." });
            },
            onSpeechEnd: (audio: Float32Array) => {
              if (!isConnectedRef.current) return;
              if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;

              // If Athena is speaking, this is a barge-in — interrupt her
              if (isPlayingRef.current) {
                stopPlayback();
                if (wsRef.current.readyState === WebSocket.OPEN) {
                  wsRef.current.send(JSON.stringify({ type: "interrupt" }));
                }
              }

              // Convert Float32 audio to WAV for Whisper
              const wavBuffer = float32ToWav(audio, 16000);
              const base64 = arrayBufferToBase64(wavBuffer);

              if (wsRef.current?.readyState === WebSocket.OPEN) {
                wsRef.current.send(JSON.stringify({ type: "audio", data: base64 }));
                wsRef.current.send(JSON.stringify({ type: "recording_end" }));
                cbRef.current.onThinkingChange(true);
              }
            },
          });
          vadRef.current = vad;
          vad.start();
        } catch (err) {
          console.error("[OpenAI] VAD init error:", err);
          cbRef.current.onError("Voice activity detection failed to initialize");
        }
      };

      ws.onmessage = (event) => {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(event.data as string);
        } catch {
          return;
        }

        switch (msg.type) {
          case "transcript":
            if (msg.text) {
              cbRef.current.onThinkingChange(true);
              cbRef.current.onMessage({ role: "user", text: msg.text as string });
            } else {
              // Empty transcript — reset thinking state
              cbRef.current.onThinkingChange(false);
            }
            break;

          case "response_text":
            cbRef.current.onThinkingChange(false);
            cbRef.current.onMessage({ role: "assistant", text: msg.text as string });
            break;

          case "audio_chunk": {
            setIsSpeakingState(true);
            cbRef.current.onSpeakingChange(true);

            const pcmBuffer = Uint8Array.from(atob(msg.data as string), (c) =>
              c.charCodeAt(0)
            ).buffer;
            playQueueRef.current.push(pcmBuffer);
            playNextChunk();
            break;
          }

          case "tts_end":
            // Server finished sending TTS audio
            break;

          case "error":
            cbRef.current.onThinkingChange(false);
            cbRef.current.onError(msg.message as string);
            break;
        }
      };

      ws.onclose = () => {
        if (isConnectedRef.current) {
          // Unexpected disconnect — try to reconnect
          isConnectedRef.current = false;
          cbRef.current.onMessage({ role: "event", text: "Connection lost. Reconnecting..." });
          setStatus("connecting");
          cbRef.current.onStatusChange("connecting");
          cleanup();
          // Reconnect after a short delay
          setTimeout(() => {
            if (!isConnectedRef.current && wsRef.current === null) {
              connect();
            }
          }, 2000);
        } else {
          setStatus("disconnected");
          cbRef.current.onStatusChange("disconnected");
          cleanup();
        }
      };

      ws.onerror = () => {
        cbRef.current.onError("WebSocket connection failed");
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      cbRef.current.onError(msg);
      setStatus("disconnected");
      cbRef.current.onStatusChange("disconnected");
      cleanup();
    }
  }, [bridgeUrl, bridgeToken, playNextChunk, stopPlayback]);

  // ─── Cleanup ────────────────────────────────────────────────────────────

  const cleanup = useCallback(async () => {
    if (vadRef.current) {
      await vadRef.current.destroy();
      vadRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
  }, []);

  const disconnect = useCallback(async () => {
    isConnectedRef.current = false;
    stopPlayback();

    if (wsRef.current) {
      if (wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: "interrupt" }));
      }
      wsRef.current.close();
      wsRef.current = null;
    }

    cleanup();

    if (audioContextRef.current) {
      await audioContextRef.current.close();
      audioContextRef.current = null;
    }

    setStatus("disconnected");
    cbRef.current.onStatusChange("disconnected");
    cbRef.current.onSpeakingChange(false);
    cbRef.current.onThinkingChange(false);
  }, [stopPlayback, cleanup]);

  return { connect, disconnect, status, isSpeaking };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function float32ToWav(float32: Float32Array, sampleRate: number): ArrayBuffer {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = float32.length * (bitsPerSample / 8);
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  // WAV header
  writeString(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, "WAVE");
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeString(view, 36, "data");
  view.setUint32(40, dataSize, true);

  // Convert float32 to int16
  let offset = 44;
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }

  return buffer;
}

function writeString(view: DataView, offset: number, str: string) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

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
      const dbg = cbRef.current.debug;
      dbg.log("Requesting microphone...");
      cbRef.current.onMessage({ role: "event", text: "Requesting microphone..." });
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (micErr) {
        const name = micErr instanceof Error ? micErr.name : "";
        const msg = micErr instanceof Error ? micErr.message : String(micErr);
        const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
        dbg.error(`Mic request failed: ${name} — ${msg} (iOS=${isIOS})`);
        if (name === "NotAllowedError" || name === "PermissionDeniedError") {
          cbRef.current.onError(
            isIOS
              ? "Mic blocked. Check: Settings → Safari → Microphone. Also: Settings → Privacy → Microphone → Safari."
              : "Mic permission denied. Allow microphone access and try again."
          );
        } else if (name === "NotFoundError") {
          cbRef.current.onError("No microphone found on this device.");
        } else if (name === "NotReadableError") {
          cbRef.current.onError("Microphone in use by another app. Close other apps and retry.");
        } else {
          cbRef.current.onError(`Mic error: ${msg}`);
        }
        setStatus("disconnected");
        cbRef.current.onStatusChange("disconnected");
        return;
      }
      streamRef.current = stream;
      const tracks = stream.getAudioTracks();
      const trackInfo = `${tracks.length} track, ${tracks[0]?.enabled ? "enabled" : "disabled"}, ${tracks[0]?.label || "no label"}`;
      dbg.success(`Mic ready: ${trackInfo}`);
      cbRef.current.onMessage({ role: "event", text: `Mic ready (${tracks.length} track, ${tracks[0]?.enabled ? "enabled" : "disabled"})` });

      // Create AudioContext for playback — must resume on iOS Safari
      const ctx = new AudioContext({ sampleRate: 24000 });
      dbg.log(`AudioContext created: state=${ctx.state}, sampleRate=${ctx.sampleRate}`);
      if (ctx.state === "suspended") {
        dbg.log("AudioContext suspended, resuming...");
        await ctx.resume();
      }
      audioContextRef.current = ctx;
      dbg.success(`AudioContext: ${ctx.state}, ${ctx.sampleRate}Hz`);
      cbRef.current.onMessage({ role: "event", text: `Audio: ${ctx.state}, ${ctx.sampleRate}Hz` });

      // Connect WebSocket with auth token
      const wsBase = bridgeUrl.replace(/^http/, "ws") + "/ws/voice";
      const wsUrl = bridgeToken ? `${wsBase}?token=${encodeURIComponent(bridgeToken)}` : wsBase;
      dbg.log(`WebSocket: connecting to ${wsBase}`);
      cbRef.current.onMessage({ role: "event", text: `Connecting to bridge...` });
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = async () => {
        setStatus("connected");
        cbRef.current.onStatusChange("connected");
        isConnectedRef.current = true;
        dbg.success("WebSocket connected");
        cbRef.current.onMessage({ role: "event", text: "WebSocket connected. Loading VAD..." });

        // Initialize VAD after WebSocket is ready
        try {
          dbg.log("Importing @ricky0123/vad-web...");
          const { MicVAD } = await import("@ricky0123/vad-web");
          dbg.log("MicVAD imported. Initializing with baseAssetPath=/");
          const vad = await MicVAD.new({
            // Serve VAD assets from public/ directory at root
            baseAssetPath: "/",
            onnxWASMBasePath: "/",
            // Force single-threaded WASM — mobile Safari lacks SharedArrayBuffer
            ortConfig: (ort) => {
              ort.env.wasm.numThreads = 1;
              dbg.log("ONNX: configured numThreads=1");
            },
            getStream: async () => stream,
            positiveSpeechThreshold: 0.6,
            negativeSpeechThreshold: 0.3,
            minSpeechMs: 200,
            preSpeechPadMs: 500,
            redemptionMs: 800,
            onSpeechStart: () => {
              dbg.log("Speech detected");
              cbRef.current.onMessage({ role: "event", text: "Speech detected..." });
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
          dbg.success("VAD initialized and listening");
          cbRef.current.onMessage({ role: "event", text: "VAD ready — speak now!" });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const stack = err instanceof Error ? err.stack : "";
          dbg.error(`VAD init failed: ${msg}`);
          if (stack) dbg.error(`Stack: ${stack.slice(0, 300)}`);
          console.error("[OpenAI] VAD init error:", err);
          cbRef.current.onError(`VAD failed: ${msg}`);
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

      ws.onclose = (ev) => {
        dbg.warn(`WebSocket closed: code=${ev.code} reason=${ev.reason || "none"} clean=${ev.wasClean}`);
        if (isConnectedRef.current) {
          isConnectedRef.current = false;
          cbRef.current.onMessage({ role: "event", text: "Connection lost. Reconnecting..." });
          setStatus("connecting");
          cbRef.current.onStatusChange("connecting");
          cleanup();
          setTimeout(() => {
            if (!isConnectedRef.current && wsRef.current === null) {
              dbg.log("Attempting reconnect...");
              connect();
            }
          }, 2000);
        } else {
          setStatus("disconnected");
          cbRef.current.onStatusChange("disconnected");
          cleanup();
        }
      };

      ws.onerror = (ev) => {
        dbg.error(`WebSocket error: ${ev}`);
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

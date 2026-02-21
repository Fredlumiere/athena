"use client";

import { useCallback, useRef, useState } from "react";
import type { VoiceProviderCallbacks, VoiceProviderHandle, VoiceProviderStatus } from "./types";

export type STTModel = "whisper-1" | "gpt-4o-mini-transcribe";

export function useOpenAIProvider(
  callbacks: VoiceProviderCallbacks,
  bridgeUrl: string,
  bridgeToken: string = "",
  sttModel: STTModel = "whisper-1"
): VoiceProviderHandle {
  const [status, setStatus] = useState<VoiceProviderStatus>("disconnected");
  const [isSpeaking, setIsSpeakingState] = useState(false);

  const cbRef = useRef(callbacks);
  cbRef.current = callbacks;

  const sttModelRef = useRef(sttModel);
  sttModelRef.current = sttModel;

  const wsRef = useRef<WebSocket | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const vadRef = useRef<{ start: () => void; pause: () => void; destroy: () => void } | null>(null);
  const playQueueRef = useRef<ArrayBuffer[]>([]);
  const isPlayingRef = useRef(false);
  const currentSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const isConnectedRef = useRef(false);
  const isTTSPlayingRef = useRef(false); // Track TTS state for barge-in

  // ─── Audio Playback ─────────────────────────────────────────────────────

  const playNextChunk = useCallback(async () => {
    if (isPlayingRef.current || playQueueRef.current.length === 0) return;
    isPlayingRef.current = true;
    isTTSPlayingRef.current = true;

    const ctx = audioContextRef.current;
    if (!ctx || ctx.state === "closed") {
      isPlayingRef.current = false;
      isTTSPlayingRef.current = false;
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
    isTTSPlayingRef.current = false;
    setIsSpeakingState(false);
    cbRef.current.onSpeakingChange(false);
  }, []);

  const stopPlayback = useCallback(() => {
    playQueueRef.current = [];
    isPlayingRef.current = false;
    isTTSPlayingRef.current = false;

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
      const dbg = cbRef.current.debug;

      // Check getUserMedia support
      if (!navigator.mediaDevices?.getUserMedia) {
        dbg.error("getUserMedia not supported — mic access unavailable");
        cbRef.current.onError("Microphone not supported in this browser.");
        setStatus("disconnected");
        cbRef.current.onStatusChange("disconnected");
        return;
      }

      // Create AudioContext for playback
      cbRef.current.onMessage({ role: "event", text: "Setting up audio..." });
      const ctx = new AudioContext({ sampleRate: 24000 });
      if (ctx.state === "suspended") await ctx.resume();
      audioContextRef.current = ctx;
      dbg.success(`AudioContext: ${ctx.state}, ${ctx.sampleRate}Hz`);

      // Connect WebSocket
      const wsBase = bridgeUrl.replace(/^http/, "ws") + "/ws/voice";
      const wsUrl = bridgeToken ? `${wsBase}?token=${encodeURIComponent(bridgeToken)}` : wsBase;
      dbg.log(`WebSocket: connecting to ${wsBase}`);
      cbRef.current.onMessage({ role: "event", text: "Connecting to bridge..." });
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = async () => {
        setStatus("connected");
        cbRef.current.onStatusChange("connected");
        isConnectedRef.current = true;
        dbg.success("WebSocket connected");

        // Send STT model config
        ws.send(JSON.stringify({ type: "config", sttModel: sttModelRef.current }));

        // Initialize MicVAD for voice activity detection + Whisper STT
        dbg.log("Initializing VAD (Silero + ONNX Runtime)...");
        cbRef.current.onMessage({ role: "event", text: "Loading voice detection..." });

        try {
          const vadModule = await import("@ricky0123/vad-web");
          const MicVAD = vadModule.MicVAD;
          const encodeWAV = vadModule.utils.encodeWAV;

          const vad = await MicVAD.new({
            baseAssetPath: "/",
            onnxWASMBasePath: "/",
            // iOS Safari: single-threaded WASM required
            ortConfig: (ort: Record<string, unknown>) => {
              const env = ort.env as Record<string, unknown>;
              const wasm = env.wasm as Record<string, unknown>;
              wasm.numThreads = 1;
            },
            onSpeechStart: () => {
              dbg.log("Speech detected");
              cbRef.current.onMessage({ role: "event", text: "Listening..." });
              // Barge-in: if TTS is playing, stop it
              if (isTTSPlayingRef.current) {
                dbg.log("Barge-in: stopping TTS playback");
                stopPlayback();
                if (wsRef.current?.readyState === WebSocket.OPEN) {
                  wsRef.current.send(JSON.stringify({ type: "interrupt" }));
                }
              }
            },
            onSpeechEnd: (audio: Float32Array) => {
              dbg.log(`Speech ended (${(audio.length / 16000).toFixed(1)}s)`);

              // Ignore very short audio (< 0.5s) — probably noise
              if (audio.length < 8000) {
                dbg.warn("Audio too short (<0.5s), ignoring");
                return;
              }

              // Show interim "Transcribing..." while Whisper processes
              cbRef.current.onMessage({ role: "interim", text: "Transcribing..." });

              // Encode to WAV and send to bridge for Whisper transcription
              const wavBuffer = encodeWAV(audio);
              const wavBytes = new Uint8Array(wavBuffer);

              if (wsRef.current?.readyState === WebSocket.OPEN) {
                // Send as binary frame — bridge detects WAV by RIFF header
                wsRef.current.send(wavBytes);
                // Signal end of audio
                wsRef.current.send(JSON.stringify({ type: "audio_end" }));
                cbRef.current.onThinkingChange(true);
                dbg.log(`Sent ${(wavBytes.length / 1024).toFixed(0)}KB WAV to bridge`);
              } else {
                dbg.error(`Cannot send — WS not open (state=${wsRef.current?.readyState})`);
              }
            },
            onVADMisfire: () => {
              dbg.log("VAD misfire (speech too short)");
            },
          });

          vadRef.current = vad;
          vad.start();
          dbg.success("VAD started — speak now!");
          cbRef.current.onMessage({ role: "event", text: "Ready — speak now!" });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          dbg.error(`VAD init failed: ${msg}`);
          cbRef.current.onError(`Voice detection failed: ${msg}`);
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
              // Empty transcript — Whisper couldn't understand
              cbRef.current.onThinkingChange(false);
              cbRef.current.onMessage({ role: "event", text: "Couldn't catch that. Try again." });
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
            break;

          case "error":
            cbRef.current.onThinkingChange(false);
            cbRef.current.onError(msg.message as string);
            break;
        }
      };

      ws.onclose = (ev) => {
        dbg.warn(`WebSocket closed: code=${ev.code} reason=${ev.reason || "none"}`);
        if (isConnectedRef.current) {
          isConnectedRef.current = false;
          cbRef.current.onMessage({ role: "event", text: "Connection lost. Reconnecting..." });
          setStatus("connecting");
          cbRef.current.onStatusChange("connecting");
          destroyVAD();
          setTimeout(() => {
            if (!isConnectedRef.current && wsRef.current === null) {
              dbg.log("Attempting reconnect...");
              connect();
            }
          }, 2000);
        } else {
          setStatus("disconnected");
          cbRef.current.onStatusChange("disconnected");
          destroyVAD();
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
      destroyVAD();
    }
  }, [bridgeUrl, bridgeToken, playNextChunk, stopPlayback]);

  // ─── Cleanup ────────────────────────────────────────────────────────────

  const destroyVAD = useCallback(() => {
    if (vadRef.current) {
      try { vadRef.current.destroy(); } catch { /* ignore */ }
      vadRef.current = null;
    }
  }, []);

  const disconnect = useCallback(async () => {
    isConnectedRef.current = false;
    stopPlayback();
    destroyVAD();

    if (wsRef.current) {
      if (wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: "interrupt" }));
      }
      wsRef.current.close();
      wsRef.current = null;
    }

    if (audioContextRef.current) {
      await audioContextRef.current.close();
      audioContextRef.current = null;
    }

    setStatus("disconnected");
    cbRef.current.onStatusChange("disconnected");
    cbRef.current.onSpeakingChange(false);
    cbRef.current.onThinkingChange(false);
  }, [stopPlayback, destroyVAD]);

  return { connect, disconnect, status, isSpeaking };
}

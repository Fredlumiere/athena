export type VoiceProviderStatus = "disconnected" | "connecting" | "connected";

export interface VoiceMessage {
  role: "user" | "assistant" | "event" | "interim";
  text: string;
}

export interface DebugLog {
  log: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
  success: (msg: string) => void;
}

export interface VoiceProviderCallbacks {
  onStatusChange: (status: VoiceProviderStatus) => void;
  onMessage: (msg: VoiceMessage) => void;
  onSpeakingChange: (speaking: boolean) => void;
  onThinkingChange: (thinking: boolean) => void;
  onError: (error: string) => void;
  debug: DebugLog;
}

export interface VoiceProviderHandle {
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  status: VoiceProviderStatus;
  isSpeaking: boolean;
}

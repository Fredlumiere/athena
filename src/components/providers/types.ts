export type VoiceProviderStatus = "disconnected" | "connecting" | "connected";

export interface VoiceMessage {
  role: "user" | "assistant" | "event";
  text: string;
}

export interface VoiceProviderCallbacks {
  onStatusChange: (status: VoiceProviderStatus) => void;
  onMessage: (msg: VoiceMessage) => void;
  onSpeakingChange: (speaking: boolean) => void;
  onThinkingChange: (thinking: boolean) => void;
  onError: (error: string) => void;
}

export interface VoiceProviderHandle {
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  status: VoiceProviderStatus;
  isSpeaking: boolean;
}

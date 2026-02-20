"use client";

export type TTSProvider = "elevenlabs" | "openai";

interface TTSToggleProps {
  provider: TTSProvider;
  onChange: (provider: TTSProvider) => void;
  disabled?: boolean;
  elevenlabsAvailable: boolean;
  openaiAvailable: boolean;
}

export default function TTSToggle({
  provider,
  onChange,
  disabled,
  elevenlabsAvailable,
  openaiAvailable,
}: TTSToggleProps) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[11px] text-text-dim mr-1">Provider</span>
      <div
        role="radiogroup"
        aria-label="TTS provider"
        className="flex items-center bg-surface border border-border rounded-lg p-0.5 text-xs"
      >
        <button
          role="radio"
          aria-checked={provider === "elevenlabs"}
          aria-disabled={!elevenlabsAvailable}
          onClick={() => onChange("elevenlabs")}
          disabled={disabled || !elevenlabsAvailable}
          title={!elevenlabsAvailable ? "ElevenLabs not configured (missing API key)" : "Use ElevenLabs for voice"}
          className={`px-3 py-1.5 rounded-md transition-all cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-white ${
            provider === "elevenlabs"
              ? "bg-[#8b5cf6] text-white shadow-sm"
              : "text-text-dim hover:text-white"
          } ${!elevenlabsAvailable ? "opacity-30 cursor-not-allowed" : ""}`}
        >
          ElevenLabs
        </button>
        <button
          role="radio"
          aria-checked={provider === "openai"}
          aria-disabled={!openaiAvailable}
          onClick={() => onChange("openai")}
          disabled={disabled || !openaiAvailable}
          title={!openaiAvailable ? "OpenAI not configured (missing API key)" : "Use OpenAI for voice"}
          className={`px-3 py-1.5 rounded-md transition-all cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-white ${
            provider === "openai"
              ? "bg-[#10a37f] text-white shadow-sm"
              : "text-text-dim hover:text-white"
          } ${!openaiAvailable ? "opacity-30 cursor-not-allowed" : ""}`}
        >
          OpenAI
        </button>
      </div>
    </div>
  );
}

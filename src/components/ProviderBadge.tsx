"use client";

import type { TTSProvider } from "./TTSToggle";

interface ProviderBadgeProps {
  provider: TTSProvider;
}

const config = {
  elevenlabs: { label: "ElevenLabs", color: "#8b5cf6" },
  openai: { label: "OpenAI", color: "#10a37f" },
};

export default function ProviderBadge({ provider }: ProviderBadgeProps) {
  const { label, color } = config[provider];
  return (
    <span
      className="inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full"
      style={{ backgroundColor: `${color}20`, color }}
    >
      <span
        className="w-1.5 h-1.5 rounded-full"
        style={{ backgroundColor: color }}
      />
      {label}
    </span>
  );
}

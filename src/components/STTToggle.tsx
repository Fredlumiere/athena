"use client";

import type { STTModel } from "./providers/OpenAIProvider";

interface STTToggleProps {
  model: STTModel;
  onChange: (model: STTModel) => void;
  disabled?: boolean;
}

export default function STTToggle({ model, onChange, disabled }: STTToggleProps) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[11px] text-text-dim mr-1">STT</span>
      <div
        role="radiogroup"
        aria-label="Speech-to-text model"
        className="flex items-center bg-surface border border-border rounded-lg p-0.5 text-xs"
      >
        <button
          role="radio"
          aria-checked={model === "whisper-1"}
          onClick={() => onChange("whisper-1")}
          disabled={disabled}
          title="OpenAI Whisper — most accurate ($0.006/min)"
          className={`px-3 py-1.5 rounded-md transition-all cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-white ${
            model === "whisper-1"
              ? "bg-[#10a37f] text-white shadow-sm"
              : "text-text-dim hover:text-white"
          }`}
        >
          Whisper
        </button>
        <button
          role="radio"
          aria-checked={model === "gpt-4o-mini-transcribe"}
          onClick={() => onChange("gpt-4o-mini-transcribe")}
          disabled={disabled}
          title="GPT-4o Mini Transcribe — half cost ($0.003/min)"
          className={`px-3 py-1.5 rounded-md transition-all cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-white ${
            model === "gpt-4o-mini-transcribe"
              ? "bg-[#10a37f]/80 text-white shadow-sm"
              : "text-text-dim hover:text-white"
          }`}
        >
          GPT-4o Mini
        </button>
      </div>
    </div>
  );
}

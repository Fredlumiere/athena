# Athena — Project Conventions

## What This Is

Athena is an AI voice assistant that connects ElevenLabs voice to Claude Code via an Express bridge. Users speak from their phone; Athena processes speech, routes to Claude Agent SDK, and speaks back.

## Architecture

```
Phone (Next.js PWA) → ngrok → Bridge (Express :8013) → Claude Agent SDK
                                  ↕                         ↕
                              OpenAI TTS/STT          Claude Code tools
```

- **Frontend**: `src/` — Next.js 15, React 19, Tailwind 4, TypeScript
- **Bridge**: `bridge/server.ts` — Express 5, WebSocket voice pipeline, session management
- **Voice**: OpenAI Whisper (STT) + OpenAI TTS, with ElevenLabs as optional provider
- **AI**: `@anthropic-ai/claude-agent-sdk` — spawns Claude Code processes

## Key Files

| File | Purpose |
|------|---------|
| `bridge/server.ts` | The entire backend — REST API, WebSocket voice, session scanning, Claude SDK integration |
| `src/components/VoiceInterface.tsx` | Main UI — auth, session picker, voice interface |
| `src/app/globals.css` | Theme variables, animations (Tailwind v4) |
| `.env.local` | All secrets (never commit) |

## Tech Stack

- Node.js 18+, TypeScript, Next.js 15, React 19, Tailwind CSS 4
- Express 5, WebSocket (`ws`), OpenAI SDK, Claude Agent SDK
- ngrok for tunnel (domain: athena-voice.ngrok.app)

## Git Workflow

### Workflow

- Commit and push directly to `main`
- `main` must always pass `npm run build`
- No branches or PRs — keep it simple

### Commits

Follow conventional commits:
```
feat: add session picker voice feedback
fix: active session detection using file recency
refactor: extract TTS pipeline into module
```

## Commands

| Command | What it does |
|---------|-------------|
| `npm run dev` | Start Next.js frontend (port 3001) |
| `npm run build` | Build frontend for production |
| `npm run bridge` | Start bridge server (port 8013) |
| `npm run bridge:dev` | Start bridge with file watching |

## Build Verification

Before reporting any change as done:
1. `npm run build` must pass
2. Bridge must start without errors: `npm run bridge`
3. Mobile-facing changes must be tested on phone

## Team Workflow

This project uses the Athena team of specialized agents. All work is coordinated through Athena (`/athena`). Key agents:

- **Max** (`/max`) — Code implementation, bug fixes, refactoring
- **Dan** (`/dan`) — DevOps, build pipeline, infrastructure
- **Gus** (`/gus`) — QA, testing, edge cases
- **Rio** (`/rio`) — Mobile compatibility, WebRTC, audio, tunnel testing
- **Dex** (`/dex`) — Git workflow, releases, commit hygiene
- **Sam** (`/sam`) — Architecture decisions, system design
- **Cal** (`/cal`) — Documentation, changelogs

### Routing Rules

- Code changes → Max writes, Gus verifies
- Mobile/voice/audio changes → Rio must review before done
- New dependencies or infra changes → Dan must review
- Architecture decisions → Sam weighs in first
- All work → filed as GitHub issues/PRs

## Environment

Secrets live in `.env.local` (gitignored). See `.env.example` for the template. Key vars:
- `BRIDGE_AUTH_TOKEN` — protects bridge endpoints
- `ATHENA_PIN` — access code for the phone UI
- `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` — AI provider keys

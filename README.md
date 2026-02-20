# Athena

AI voice assistant powered by ElevenLabs Conversational AI and Claude. Speak to Claude through a real-time voice interface with full access to development tools.

## How It Works

```
User speaks
    → ElevenLabs (speech-to-text)
    → LLM Bridge (Express server)
    → Claude Agent SDK (code tools, file access, shell)
    → LLM Bridge (OpenAI-compatible response)
    → ElevenLabs (text-to-speech)
    → User hears response
```

Athena connects ElevenLabs' voice pipeline to Claude's agentic capabilities. ElevenLabs handles speech-to-text and text-to-speech. The bridge server translates between ElevenLabs' OpenAI-compatible LLM format and the Claude Agent SDK, giving the voice assistant access to the full Claude Code toolset (file read/write, shell commands, code search, etc.).

## Architecture

The project has two components:

### 1. Next.js Frontend (`src/`)

A React web app that provides the voice UI:

- **Password gate** — Simple access code screen before the main interface
- **Voice conversation** — Real-time WebRTC connection to ElevenLabs
- **Message display** — Chat bubbles showing the full conversation transcript
- **Voice selector** — Choose from 6 ElevenLabs voices (Sarah, Jessica, Alice, Matilda, Lily, Bella)
- **State indicators** — Visual and audio feedback for listening, thinking, and speaking states

### 2. LLM Bridge (`bridge/`)

An Express server that acts as ElevenLabs' custom LLM backend:

- **OpenAI-compatible API** — Implements `POST /v1/chat/completions` (streaming and non-streaming)
- **Claude Agent SDK** — Routes requests to Claude with full tool access (file operations, shell, code search)
- **Session persistence** — Maintains conversation context across turns using Agent SDK sessions
- **Tunnel support** — Ships with a Cloudflare tunnel script to expose the local server to ElevenLabs

## Prerequisites

- Node.js 18+
- [ElevenLabs](https://elevenlabs.io) account with a Conversational AI agent
- [Anthropic](https://console.anthropic.com) API key
- [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/create-local-tunnel/) (`cloudflared`) for exposing the bridge to ElevenLabs

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

Copy the example and fill in your keys:

```bash
cp .env.example .env.local
```

```env
# ElevenLabs
ELEVENLABS_API_KEY=your_elevenlabs_api_key
NEXT_PUBLIC_ELEVENLABS_AGENT_ID=your_agent_id

# Bridge server
ANTHROPIC_API_KEY=your_anthropic_api_key
BRIDGE_PORT=8013
ATHENA_CWD=/path/to/your/project
ATHENA_MODEL=claude-sonnet-4-5-20250929
```

| Variable | Description |
|---|---|
| `ELEVENLABS_API_KEY` | ElevenLabs API key (used server-side for signed URLs) |
| `NEXT_PUBLIC_ELEVENLABS_AGENT_ID` | Your ElevenLabs Conversational AI agent ID |
| `ANTHROPIC_API_KEY` | Anthropic API key for Claude |
| `BRIDGE_PORT` | Port for the bridge server (default: `8013`) |
| `ATHENA_CWD` | Working directory Claude operates in (your project root) |
| `ATHENA_MODEL` | Claude model to use (default: `claude-sonnet-4-5-20250929`) |
| `BRIDGE_API_KEY` | Optional bearer token to protect the bridge endpoint |

### 3. Create an ElevenLabs Conversational AI agent

1. Go to [ElevenLabs](https://elevenlabs.io) > Conversational AI > Create agent
2. Set the LLM to **Custom LLM**
3. Set the URL to your bridge endpoint (see step 5)
4. Set the model ID to `athena`
5. Copy the agent ID into `NEXT_PUBLIC_ELEVENLABS_AGENT_ID`

### 4. Start the frontend

```bash
npm run dev
```

The app will be available at `http://localhost:3000`.

### 5. Start the bridge

**Option A — Quick start with tunnel:**

```bash
./bridge/start.sh [project_dir]
```

This starts the bridge server and a Cloudflare tunnel in one command. Copy the tunnel URL from the output.

**Option B — Manual:**

```bash
# Terminal 1: Start the bridge server
npm run bridge

# Terminal 2: Start a tunnel (or use ngrok, etc.)
cloudflared tunnel --url http://localhost:8013
```

### 6. Point ElevenLabs to the bridge

Once you have the tunnel URL, configure the ElevenLabs agent:

```bash
./bridge/configure-agent.sh https://your-tunnel-url.trycloudflare.com
```

Or manually set the custom LLM URL in the ElevenLabs dashboard to:
```
https://your-tunnel-url.trycloudflare.com/v1/chat/completions
```

## Usage

1. Open `http://localhost:3000`
2. Enter the access code
3. Optionally select a voice
4. Tap the microphone button to connect
5. Speak naturally — Athena will respond via voice

The interface shows conversation status:
- **Red pulsing orb** — Listening to you
- **Grey orb** — Thinking / processing
- **Purple pulsing orb** — Speaking

## Project Structure

```
athena/
├── bridge/
│   ├── server.ts            # LLM bridge server (Express + Claude Agent SDK)
│   ├── configure-agent.sh   # Script to configure ElevenLabs agent
│   ├── start.sh             # Script to start bridge + Cloudflare tunnel
│   └── tsconfig.json        # TypeScript config for bridge
├── public/
│   └── sounds/
│       └── thinking.wav     # Audio feedback during thinking state
├── src/
│   ├── app/
│   │   ├── api/
│   │   │   └── signed-url/
│   │   │       └── route.ts # API route to get ElevenLabs signed URL
│   │   ├── globals.css      # Theme variables, animations (Tailwind v4)
│   │   ├── layout.tsx       # Root layout
│   │   └── page.tsx         # Home page (renders VoiceInterface)
│   └── components/
│       └── VoiceInterface.tsx  # Main voice UI component
├── .env.example             # Environment variable template
├── next.config.ts           # Next.js configuration
├── package.json             # Dependencies and scripts
├── postcss.config.mjs       # PostCSS config (Tailwind)
└── tsconfig.json            # TypeScript config for frontend
```

## Scripts

| Command | Description |
|---|---|
| `npm run dev` | Start Next.js frontend in development mode |
| `npm run build` | Build the frontend for production |
| `npm run start` | Start the production frontend |
| `npm run bridge` | Start the LLM bridge server |
| `npm run bridge:dev` | Start the bridge with file watching |

## API Endpoints

### Frontend (Next.js)

| Endpoint | Description |
|---|---|
| `GET /api/signed-url` | Returns a signed URL for ElevenLabs WebRTC connection |

### Bridge Server

| Endpoint | Description |
|---|---|
| `POST /v1/chat/completions` | OpenAI-compatible chat endpoint (streaming + non-streaming) |
| `GET /health` | Health check, returns `{ status: "ok", sessions: <count> }` |
| `POST /test` | Simple test route |

## Tech Stack

- **Frontend**: Next.js 15, React 19, Tailwind CSS 4, TypeScript
- **Voice**: ElevenLabs Conversational AI (`@elevenlabs/react`), WebRTC
- **AI Backend**: Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`)
- **Bridge**: Express 5, Server-Sent Events (SSE)
- **Tunnel**: Cloudflare Tunnel (`cloudflared`)

## Deployment

The frontend is configured for Vercel deployment (`.vercel/` directory exists). The bridge server must run somewhere with access to the Anthropic API and the target project directory — typically your local machine or a dedicated server.

For production use:
1. Deploy the Next.js frontend to Vercel
2. Run the bridge on a server with a stable URL (or use a persistent tunnel)
3. Set `BRIDGE_API_KEY` to secure the bridge endpoint

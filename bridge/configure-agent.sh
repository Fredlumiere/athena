#!/bin/bash
# Configure ElevenLabs agent to use custom LLM endpoint
# Usage: ./bridge/configure-agent.sh <tunnel_url>
# Example: ./bridge/configure-agent.sh https://abc123.trycloudflare.com

set -e

TUNNEL_URL="$1"
if [ -z "$TUNNEL_URL" ]; then
  echo "Usage: $0 <tunnel_url>"
  echo "Example: $0 https://abc123.trycloudflare.com"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Load env vars
if [ -f "$SCRIPT_DIR/../.env.local" ]; then
  set -a
  source "$SCRIPT_DIR/../.env.local"
  set +a
fi

AGENT_ID="${NEXT_PUBLIC_ELEVENLABS_AGENT_ID}"
API_KEY="${ELEVENLABS_API_KEY}"

if [ -z "$AGENT_ID" ] || [ -z "$API_KEY" ]; then
  echo "Error: NEXT_PUBLIC_ELEVENLABS_AGENT_ID and ELEVENLABS_API_KEY must be set in .env.local"
  exit 1
fi

LLM_URL="${TUNNEL_URL}/v1/chat/completions"

echo "Configuring agent $AGENT_ID to use custom LLM at $LLM_URL..."

RESPONSE=$(curl -s -X PATCH "https://api.elevenlabs.io/v1/convai/agents/${AGENT_ID}" \
  -H "xi-api-key: ${API_KEY}" \
  -H "Content-Type: application/json" \
  -d "{
    \"conversation_config\": {
      \"agent\": {
        \"prompt\": {
          \"llm\": \"custom-llm\",
          \"custom_llm\": {
            \"url\": \"${LLM_URL}\",
            \"model_id\": \"athena\",
            \"api_type\": \"chat_completions\"
          }
        }
      }
    }
  }")

if echo "$RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('agent_id',''))" 2>/dev/null | grep -q "agent_"; then
  echo "Agent updated successfully."
  echo "Custom LLM endpoint: $LLM_URL"
else
  echo "Error updating agent:"
  echo "$RESPONSE" | python3 -m json.tool 2>/dev/null || echo "$RESPONSE"
fi

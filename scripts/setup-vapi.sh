#!/usr/bin/env bash
# Provisions the Vapi assistant, the 4 server tools it calls mid-call, and a
# free US phone number pointed at that assistant — entirely via Vapi's REST
# API. No dashboard clicking required at all.
#
# LLM wiring note: this deliberately does NOT point Vapi's custom-llm model
# straight at Google's OpenAI-compatible Gemini endpoint. That was tried
# first and failed on every real call with
# pipeline-error-custom-llm-400-bad-request-validation-failed — reproduced
# directly: Vapi's custom-llm client attaches a `metadata` object to every
# request for its own call tracing, and Google's OpenAI-compat layer
# hard-rejects any field it doesn't recognize (`Invalid JSON payload
# received. Unknown name "metadata": Cannot find field.`) — unlike real
# OpenAI, which just ignores unknown fields. So instead this points the
# custom-llm model at THIS REPO'S OWN /llm/chat/completions endpoint
# (src/llm-proxy/), which strips unrecognized fields via an allowlist
# before forwarding to Google, then streams the response straight back.
# The Gemini key lives only as a server env var on the deployed app; Vapi
# authenticates to our proxy with VAPI_SERVER_SECRET instead.
#
# The dashboard's native "Google" model provider was *also* tried and
# rejected first: as of Sep 2026 Google routes newly-created Gemini API
# keys away from gemini-2.5-flash, but Vapi's "Add Google Credential"
# dialog validates any key with a hardcoded test call against exactly that
# model, so saving a fresh key there fails regardless of whether the key
# actually works.
#
# Model tier note: defaults to gemini-flash-lite-latest, not
# gemini-flash-latest. The full "flash" tier alias returned consistent 503
# "high demand" errors / timeouts from Google when tested live (Sep 2026);
# the lite tier responded instantly and handled function calling
# correctly. Override with GEMINI_MODEL_ID if that changes.
#
# Prerequisites:
#   1. Sign up at https://dashboard.vapi.ai
#   2. Settings -> API Keys -> copy your Private API Key -> set VAPI_API_KEY
#   3. Deploy this repo with GEMINI_API_KEY and VAPI_SERVER_SECRET set as
#      server env vars (see README section 8) — this script does NOT need
#      your Gemini key at all, only the deployed app does.
#
# Usage:
#   export VAPI_API_KEY=...
#   export PUBLIC_API_BASE_URL=https://your-app.onrender.com
#   export VAPI_SERVER_SECRET=...        # must match the deployed API's env var
#   ./scripts/setup-vapi.sh
#
# Re-running this script is idempotent — it reuses the existing credential
# and tools by name instead of duplicating them. Set VAPI_ASSISTANT_ID to
# update an existing assistant in place instead of creating a new one.

set -euo pipefail

: "${VAPI_API_KEY:?Set VAPI_API_KEY to your Vapi private API key}"
: "${PUBLIC_API_BASE_URL:?Set PUBLIC_API_BASE_URL to your deployed API public HTTPS URL}"
: "${VAPI_SERVER_SECRET:?Set VAPI_SERVER_SECRET to the same secret configured on the server}"

MODEL_ID="${GEMINI_MODEL_ID:-gemini-flash-lite-latest}"
# Base only, no /chat/completions — Vapi's custom-llm client appends that
# path itself (confirmed: this is exactly how the working Google-direct
# config was shaped: "https://generativelanguage.googleapis.com/v1beta/openai/",
# and requests still reached the real chat-completions handler).
LLM_PROXY_BASE_URL="${PUBLIC_API_BASE_URL%/}/llm"
API_BASE="https://api.vapi.ai"
WEBHOOK_URL="${PUBLIC_API_BASE_URL%/}/vapi/webhook"

command -v jq >/dev/null || { echo "jq is required. Install with: brew install jq"; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROMPT_FILE="$SCRIPT_DIR/../prompts/system-prompt.md"

# Pull the fenced ``` block out of prompts/system-prompt.md so the prompt
# lives in exactly one place and this script never drifts from it.
SYSTEM_PROMPT="$(awk '/^```$/{c++;next} c==1' "$PROMPT_FILE")"
if [ -z "$SYSTEM_PROMPT" ]; then
  echo "Could not extract system prompt from $PROMPT_FILE"; exit 1
fi

echo "==> Webhook URL for all tools + assistant: $WEBHOOK_URL"

# Idempotency: re-running this script used to create a brand new credential
# and 4 new tools every time, littering the account with duplicates (had to
# be cleaned up by hand during development). Both credential and tool
# creation now look for an existing match by name first and update it in
# place instead of creating a new one.
CREDENTIAL_NAME="gemini-openai-compat"
EXISTING_CREDENTIAL_ID=$(curl -sS "$API_BASE/credential" -H "Authorization: Bearer $VAPI_API_KEY" \
  | jq -r --arg n "$CREDENTIAL_NAME" '[.[] | select(.name == $n)][0].id // empty')

if [ -n "$EXISTING_CREDENTIAL_ID" ]; then
  echo "==> Reusing existing custom-llm credential ($EXISTING_CREDENTIAL_ID), syncing its apiKey"
  # Keep the credential's apiKey in sync with the current VAPI_SERVER_SECRET
  # every run — it authenticates Vapi to OUR proxy, not to Google, so it
  # must always match whatever secret the deployed app currently checks.
  curl -sS -X PATCH "$API_BASE/credential/$EXISTING_CREDENTIAL_ID" \
    -H "Authorization: Bearer $VAPI_API_KEY" -H "Content-Type: application/json" \
    -d "{\"apiKey\": \"$VAPI_SERVER_SECRET\"}" > /dev/null
  LLM_CREDENTIAL_ID="$EXISTING_CREDENTIAL_ID"
else
  echo "==> Creating custom-llm credential (Gemini via OpenAI-compatible endpoint)"
  LLM_CREDENTIAL=$(curl -sS -X POST "$API_BASE/credential" \
    -H "Authorization: Bearer $VAPI_API_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"provider\": \"custom-llm\", \"apiKey\": \"$VAPI_SERVER_SECRET\", \"name\": \"$CREDENTIAL_NAME\"}")
  LLM_CREDENTIAL_ID=$(echo "$LLM_CREDENTIAL" | jq -r '.id // empty')
  if [ -z "$LLM_CREDENTIAL_ID" ]; then
    echo "!! Failed to create custom-llm credential:"; echo "$LLM_CREDENTIAL" | jq .; exit 1
  fi
fi
echo "    id=$LLM_CREDENTIAL_ID"

EXISTING_TOOLS_JSON=$(curl -sS "$API_BASE/tool" -H "Authorization: Bearer $VAPI_API_KEY")

create_tool() {
  local name="$1" description="$2" params_json="$3"
  local existing_id
  existing_id=$(echo "$EXISTING_TOOLS_JSON" | jq -r --arg n "$name" '[.[] | select(.function.name == $n)][0].id // empty')

  if [ -n "$existing_id" ]; then
    curl -sS -X PATCH "$API_BASE/tool/$existing_id" \
      -H "Authorization: Bearer $VAPI_API_KEY" \
      -H "Content-Type: application/json" \
      -d @- <<JSON
{
  "function": {
    "name": "$name",
    "description": "$description",
    "parameters": $params_json
  },
  "server": {
    "url": "$WEBHOOK_URL",
    "secret": "$VAPI_SERVER_SECRET"
  }
}
JSON
  else
    curl -sS -X POST "$API_BASE/tool" \
      -H "Authorization: Bearer $VAPI_API_KEY" \
      -H "Content-Type: application/json" \
      -d @- <<JSON
{
  "type": "function",
  "function": {
    "name": "$name",
    "description": "$description",
    "parameters": $params_json
  },
  "server": {
    "url": "$WEBHOOK_URL",
    "secret": "$VAPI_SERVER_SECRET"
  }
}
JSON
  fi
}

echo "==> Creating tool: lookup_patient_by_phone"
LOOKUP_TOOL=$(create_tool "lookup_patient_by_phone" \
  "Looks up an existing patient by phone number, for duplicate detection before creating a new record." \
  '{"type":"object","properties":{"phone_number":{"type":"string","description":"10-digit US phone number"}},"required":["phone_number"]}')
LOOKUP_TOOL_ID=$(echo "$LOOKUP_TOOL" | jq -r '.id')
echo "    id=$LOOKUP_TOOL_ID"

echo "==> Creating tool: create_patient"
CREATE_TOOL=$(create_tool "create_patient" \
  "Creates a new patient record once all required fields have been collected and confirmed with the caller." \
  '{
    "type": "object",
    "properties": {
      "first_name": {"type": "string"},
      "last_name": {"type": "string"},
      "date_of_birth": {"type": "string", "description": "MM/DD/YYYY"},
      "sex": {"type": "string", "enum": ["Male", "Female", "Other", "Decline to Answer"]},
      "phone_number": {"type": "string", "description": "10-digit US phone number"},
      "email": {"type": "string"},
      "address_line_1": {"type": "string"},
      "address_line_2": {"type": "string"},
      "city": {"type": "string"},
      "state": {"type": "string", "description": "2-letter US state abbreviation"},
      "zip_code": {"type": "string"},
      "insurance_provider": {"type": "string"},
      "insurance_member_id": {"type": "string"},
      "preferred_language": {"type": "string"},
      "emergency_contact_name": {"type": "string"},
      "emergency_contact_phone": {"type": "string"}
    },
    "required": ["first_name", "last_name", "date_of_birth", "sex", "phone_number", "address_line_1", "city", "state", "zip_code"]
  }')
CREATE_TOOL_ID=$(echo "$CREATE_TOOL" | jq -r '.id')
echo "    id=$CREATE_TOOL_ID"

echo "==> Creating tool: update_patient"
UPDATE_TOOL=$(create_tool "update_patient" \
  "Partially updates an existing patient record, identified by patient_id from a prior lookup_patient_by_phone call." \
  '{
    "type": "object",
    "properties": {
      "patient_id": {"type": "string"},
      "first_name": {"type": "string"},
      "last_name": {"type": "string"},
      "date_of_birth": {"type": "string"},
      "sex": {"type": "string", "enum": ["Male", "Female", "Other", "Decline to Answer"]},
      "phone_number": {"type": "string"},
      "email": {"type": "string"},
      "address_line_1": {"type": "string"},
      "address_line_2": {"type": "string"},
      "city": {"type": "string"},
      "state": {"type": "string"},
      "zip_code": {"type": "string"},
      "insurance_provider": {"type": "string"},
      "insurance_member_id": {"type": "string"},
      "preferred_language": {"type": "string"},
      "emergency_contact_name": {"type": "string"},
      "emergency_contact_phone": {"type": "string"}
    },
    "required": ["patient_id"]
  }')
UPDATE_TOOL_ID=$(echo "$UPDATE_TOOL" | jq -r '.id')
echo "    id=$UPDATE_TOOL_ID"

echo "==> Creating tool: propose_appointment"
APPT_TOOL=$(create_tool "propose_appointment" \
  "Proposes a mock next-available appointment slot after registration is complete." \
  '{"type":"object","properties":{}}')
APPT_TOOL_ID=$(echo "$APPT_TOOL" | jq -r '.id')
echo "    id=$APPT_TOOL_ID"

for pair in "lookup_patient_by_phone:$LOOKUP_TOOL_ID" "create_patient:$CREATE_TOOL_ID" "update_patient:$UPDATE_TOOL_ID" "propose_appointment:$APPT_TOOL_ID"; do
  id="${pair#*:}"
  if [ "$id" = "null" ] || [ -z "$id" ]; then
    echo "!! Failed to create tool ($pair). Full responses were printed above — check your VAPI_API_KEY."; exit 1
  fi
done

ASSISTANT_ID_TO_UPDATE="${VAPI_ASSISTANT_ID:-}"
if [ -n "$ASSISTANT_ID_TO_UPDATE" ]; then
  echo "==> Updating existing assistant $ASSISTANT_ID_TO_UPDATE (VAPI_ASSISTANT_ID set)"
else
  echo "==> Creating assistant"
fi
ASSISTANT_PAYLOAD=$(jq -n \
  --arg name "Patient Registration Agent" \
  --arg prompt "$SYSTEM_PROMPT" \
  --arg model "$MODEL_ID" \
  --arg llmUrl "$LLM_PROXY_BASE_URL" \
  --argjson credentialIds "$(jq -n --arg id "$LLM_CREDENTIAL_ID" '[$id]')" \
  --arg firstMessage "Thanks for calling — this is Casey with patient registration. Are you calling to register as a new patient today?" \
  --arg url "$WEBHOOK_URL" \
  --arg secret "$VAPI_SERVER_SECRET" \
  --argjson toolIds "$(jq -n --arg a "$LOOKUP_TOOL_ID" --arg b "$CREATE_TOOL_ID" --arg c "$UPDATE_TOOL_ID" --arg d "$APPT_TOOL_ID" '[$a,$b,$c,$d]')" \
  '{
    name: $name,
    firstMessage: $firstMessage,
    credentialIds: $credentialIds,
    model: {
      provider: "custom-llm",
      url: $llmUrl,
      model: $model,
      messages: [{role: "system", content: $prompt}],
      toolIds: $toolIds
    },
    voice: {provider: "vapi", voiceId: "Elliot"},
    server: {url: $url, secret: $secret}
  }')

if [ -n "$ASSISTANT_ID_TO_UPDATE" ]; then
  # PATCH always sends the FULL model object (provider, url, model,
  # messages, toolIds together) — never patch a subset of `model` fields by
  # hand. Vapi's PATCH replaces the whole `model` object rather than
  # merging it, so a partial update (e.g. just changing the model id)
  # silently deletes the system prompt. That exact mistake took a live
  # assistant down during development: a hand-run PATCH that omitted
  # `messages` wiped the system prompt, and every subsequent call failed
  # with pipeline-error-custom-llm-400-bad-request-validation-failed
  # because Google's endpoint was receiving no instructions at all.
  ASSISTANT=$(curl -sS -X PATCH "$API_BASE/assistant/$ASSISTANT_ID_TO_UPDATE" \
    -H "Authorization: Bearer $VAPI_API_KEY" \
    -H "Content-Type: application/json" \
    -d "$ASSISTANT_PAYLOAD")
  ASSISTANT_ID=$(echo "$ASSISTANT" | jq -r '.id')
else
  ASSISTANT=$(curl -sS -X POST "$API_BASE/assistant" \
    -H "Authorization: Bearer $VAPI_API_KEY" \
    -H "Content-Type: application/json" \
    -d "$ASSISTANT_PAYLOAD")
  ASSISTANT_ID=$(echo "$ASSISTANT" | jq -r '.id')
fi

if [ "$ASSISTANT_ID" = "null" ] || [ -z "$ASSISTANT_ID" ]; then
  echo "!! Failed to create/update assistant:"; echo "$ASSISTANT" | jq .; exit 1
fi
echo "    id=$ASSISTANT_ID"

echo "==> Checking for an existing free Vapi phone number to reuse"
EXISTING_PHONE_ID=$(curl -sS "$API_BASE/phone-number" -H "Authorization: Bearer $VAPI_API_KEY" \
  | jq -r '[.[] | select(.provider == "vapi")][0].id // empty')

if [ -n "$EXISTING_PHONE_ID" ]; then
  # Vapi's free tier caps out at a small number of numbers per account, and
  # re-running this script shouldn't accumulate new ones every time — just
  # repoint whichever free number already exists at the freshly created
  # assistant.
  echo "    Found existing number ($EXISTING_PHONE_ID) — repointing it at the new assistant"
  PHONE=$(curl -sS -X PATCH "$API_BASE/phone-number/$EXISTING_PHONE_ID" \
    -H "Authorization: Bearer $VAPI_API_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"assistantId\": \"$ASSISTANT_ID\"}")
else
  echo "==> Provisioning a free US phone number (area code: ${VAPI_AREA_CODE:-415})"
  PHONE=$(curl -sS -X POST "$API_BASE/phone-number" \
    -H "Authorization: Bearer $VAPI_API_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"provider\": \"vapi\", \"numberDesiredAreaCode\": \"${VAPI_AREA_CODE:-415}\", \"name\": \"Patient Registration Line\", \"assistantId\": \"$ASSISTANT_ID\"}")
fi

PHONE_NUMBER=$(echo "$PHONE" | jq -r '.number // empty')

echo ""
echo "================================================================"
if [ -n "$PHONE_NUMBER" ]; then
  echo "Success. Call this number to test:  $PHONE_NUMBER"
  echo "(Number can take a couple of minutes to become active.)"
else
  echo "Phone number response (check for errors, e.g. free-number limit reached):"
  echo "$PHONE" | jq .
fi
echo ""
echo "Assistant ID: $ASSISTANT_ID"
echo "To update the assistant after editing prompts/system-prompt.md, run:"
echo "  curl -X PATCH $API_BASE/assistant/$ASSISTANT_ID \\"
echo "    -H \"Authorization: Bearer \$VAPI_API_KEY\" -H \"Content-Type: application/json\" \\"
echo "    -d '{\"model\": {\"provider\": \"custom-llm\", \"url\": \"$LLM_PROXY_BASE_URL\", \"model\": \"$MODEL_ID\", \"messages\": [...], \"toolIds\": $(echo "$ASSISTANT_PAYLOAD" | jq -c '.model.toolIds')}}'"
echo "================================================================"

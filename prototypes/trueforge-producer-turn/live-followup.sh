#!/usr/bin/env bash
# PROTOTYPE — throw away after issue 43 is resolved.
set -euo pipefail

prototype_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
followup_signal_path="/tmp/codealongai-trueforge-producer-turn/live-question-${BASHPID}.json"

export CODEALONGAI_SPIKE_KIND=followup
export CODEALONGAI_SPIKE_HOLD_OPEN=1
export CODEALONGAI_SPIKE_SKIP_SKILL_READ=1
export CODEALONGAI_SPIKE_TRUEFORGE_URL="${CODEALONGAI_SPIKE_TRUEFORGE_URL:-http://127.0.0.1:4111}"
export CODEALONGAI_SPIKE_MCP_URL="${CODEALONGAI_SPIKE_MCP_URL:-http://127.0.0.1:61340/mcp}"
export CODEALONGAI_SPIKE_QUESTION_SIGNAL="$followup_signal_path"
export CODEALONGAI_SPIKE_MODEL="${CODEALONGAI_SPIKE_MODEL:-openai/gpt-5-6-luna}"
export CODEALONGAI_SPIKE_REASONING_EFFORT="${CODEALONGAI_SPIKE_REASONING_EFFORT:-medium}"

exec bash "$prototype_dir/run.sh"

#!/usr/bin/env bash
# Apps Script has no cross-project imports — admin/, agent/, and gateway/
# are each deployed as one flat script, so shared/*.gs (and, for gateway/,
# admin/Store.gs — see gateway/AgentApi.gs for why gateway is separate)
# must be physically copied into each before every clasp push. Run this,
# then clasp push in whichever directory you're deploying.
# There is no build step yet (see shared/Config.gs) — this is it, minimal as possible.
set -euo pipefail
cd "$(dirname "$0")/.."

mkdir -p admin/shared agent/shared gateway/shared
cp shared/*.gs admin/shared/
cp shared/*.gs agent/shared/
cp shared/*.gs gateway/shared/
cp admin/Store.gs gateway/Store.gs

echo "Synced $(ls shared/*.gs | wc -l | tr -d ' ') shared file(s) into admin/shared/, agent/shared/, gateway/shared/"
echo "Synced admin/Store.gs into gateway/Store.gs"

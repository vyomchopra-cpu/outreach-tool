#!/usr/bin/env bash
# Apps Script has no cross-project imports — admin/ and agent/ are each
# deployed as one flat script, so shared/*.gs must be physically copied into
# both before every clasp push. Run this, then clasp push in admin/ and agent/.
# There is no build step yet (see shared/Config.gs) — this is it, minimal as possible.
set -euo pipefail
cd "$(dirname "$0")/.."

mkdir -p admin/shared agent/shared
cp shared/*.gs admin/shared/
cp shared/*.gs agent/shared/

echo "Synced $(ls shared/*.gs | wc -l | tr -d ' ') shared file(s) into admin/shared/ and agent/shared/"

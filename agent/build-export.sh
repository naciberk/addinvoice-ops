#!/bin/bash
# company-backup.ts → company-backup.mjs (ajan çalışma zamanında npx/ağ KULLANMASIN diye derlenmiş kopya). Script değişirse yeniden çalıştır.
set -euo pipefail
cd "$(dirname "$0")"
/var/www/addinvoice/node_modules/.bin/esbuild /var/www/addinvoice/scripts/company-backup.ts --format=esm --platform=node --target=node20 --outfile=company-backup.mjs
echo "company-backup.mjs güncellendi"

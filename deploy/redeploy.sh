#!/bin/bash
# Ops konsolu kodu değişince: derle → önbellek symlink'ini yeniden kur → web servisini yeniden başlat.
# (Ajan koduna dokunulduysa ayrıca: systemctl restart addinvoice-ops-agent — derleme gerekmez.)
set -euo pipefail
cd /var/www/addinvoice-ops
NODE_ENV=production npx next build
rm -rf .next/cache && ln -s /var/lib/addinvoice-ops/next-cache .next/cache
systemctl restart addinvoice-ops
sleep 2
systemctl is-active addinvoice-ops

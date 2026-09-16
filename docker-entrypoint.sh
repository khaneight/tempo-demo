#!/bin/sh
set -e
echo "[entrypoint] applying migrations"
NODE_PATH=/app/node_modules_full /app/node_modules_full/.bin/tsx /app/src/db/migrate.ts
echo "[entrypoint] starting app"
exec node server.js

#!/bin/sh
set -e

echo "==> Running database migrations..."
npx prisma migrate deploy

echo "==> Starting Sosa Connect API..."
exec node dist/main.js

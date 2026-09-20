#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_DIR/app"

echo "=== Installing dependencies ==="
npm install

echo ""
echo "=== Running unit tests ==="
npm run test:unit

echo ""
echo "=== Running integration tests ==="
npm run test:integration

echo ""
echo "=== Running full test suite with coverage ==="
npm test

echo ""
echo "=== All tests passed! ==="

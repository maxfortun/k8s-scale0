#!/bin/bash
set -e

echo "=== Cleaning up test workloads ==="

kubectl delete namespace scale0-test --ignore-not-found=true

echo ""
echo "=== Test workloads removed ==="

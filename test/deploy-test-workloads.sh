#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "=== Deploying test workloads ==="
echo "These workloads use short scale-in timeouts for testing:"
echo "  - quick-scale-app: 30 seconds"
echo "  - test-app: 60 seconds"
echo "  - no-hpa-app: 90 seconds"
echo "  - gateway-api-app: 120 seconds"
echo ""

kubectl apply -f "$SCRIPT_DIR/manifests/"

echo ""
echo "=== Waiting for deployments to be ready ==="
kubectl wait --for=condition=available --timeout=120s deployment -l 'scale0/enabled' -n scale0-test 2>/dev/null || \
  kubectl wait --for=condition=available --timeout=120s deployment --all -n scale0-test

echo ""
echo "=== Test workloads deployed ==="
echo ""
echo "To monitor scale0 controller logs:"
echo "  kubectl logs -f -n scale0 deployment/scale0"
echo ""
echo "To check scaled-down services:"
echo "  curl http://localhost:8080/status"
echo ""
echo "Services will scale down after their configured idle timeout."
echo "Send traffic to keep them active, or wait for scale-down."

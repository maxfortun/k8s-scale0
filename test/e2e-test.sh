#!/bin/bash
set -e

# E2E test for k8s-scale0
# Deploys workloads, waits for scale-in, triggers scale-out, verifies

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NAMESPACE="scale0-test"
SCALE_IN_TIMEOUT=120    # 2 minutes idle before scale-in
WAIT_FOR_SCALE_IN=180   # 3 minutes total wait for scale-in to complete
WAIT_FOR_SCALE_OUT=120  # 2 minutes wait for scale-out after triggering

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

check_prerequisites() {
    log_info "Checking prerequisites..."

    if ! command -v kubectl &> /dev/null; then
        log_error "kubectl not found"
        exit 1
    fi

    if ! kubectl cluster-info &> /dev/null; then
        log_error "Cannot connect to Kubernetes cluster"
        exit 1
    fi

    log_info "Prerequisites OK"
}

deploy_scale0_controller() {
    log_info "Deploying scale0 controller..."

    # Check if scale0 namespace exists
    if ! kubectl get namespace scale0 &> /dev/null; then
        kubectl create namespace scale0
    fi

    # Build and deploy controller (assumes local development)
    cd "$SCRIPT_DIR/../app"

    # For local testing, run controller in background
    log_info "Starting controller locally..."
    SCALE0_SERVICE_NAME=scale0 \
    SCALE0_SERVICE_NAMESPACE=scale0 \
    SCALE_IN_AFTER_SECONDS=$SCALE_IN_TIMEOUT \
    CHECK_INTERVAL_MS=10000 \
    WAKEUP_PORT=8080 \
    node index.js &
    CONTROLLER_PID=$!

    echo "$CONTROLLER_PID" > /tmp/scale0-controller.pid
    sleep 3

    if ! kill -0 $CONTROLLER_PID 2>/dev/null; then
        log_error "Controller failed to start"
        exit 1
    fi

    log_info "Controller running (PID: $CONTROLLER_PID)"
}

deploy_test_workloads() {
    log_info "Deploying test workloads..."

    # Create test namespace
    kubectl create namespace $NAMESPACE --dry-run=client -o yaml | kubectl apply -f -

    # Deploy test app with 2 minute scale-in (using Gateway API HTTPRoute)
    cat <<EOF | kubectl apply -f -
apiVersion: apps/v1
kind: Deployment
metadata:
  name: e2e-test-app
  namespace: $NAMESPACE
spec:
  replicas: 2
  selector:
    matchLabels:
      app: e2e-test
  template:
    metadata:
      labels:
        app: e2e-test
    spec:
      containers:
        - name: nginx
          image: nginx:1.25-alpine
          ports:
            - containerPort: 80
          readinessProbe:
            httpGet:
              path: /
              port: 80
            initialDelaySeconds: 2
            periodSeconds: 5
---
apiVersion: v1
kind: Service
metadata:
  name: e2e-test-app
  namespace: $NAMESPACE
  labels:
    scale0/enabled: "true"
    scale0/scale-in-after: "$SCALE_IN_TIMEOUT"
spec:
  selector:
    app: e2e-test
  ports:
    - port: 80
      targetPort: 80
---
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: e2e-test-app
  namespace: $NAMESPACE
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: e2e-test-app
  minReplicas: 2
  maxReplicas: 10
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 70
---
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: e2e-test-route
  namespace: $NAMESPACE
spec:
  hostnames:
    - e2e-test.example.com
  rules:
    - matches:
        - path:
            type: PathPrefix
            value: /
      backendRefs:
        - kind: Service
          name: e2e-test-app
          port: 80
EOF

    log_info "Waiting for deployment to be ready..."
    kubectl rollout status deployment/e2e-test-app -n $NAMESPACE --timeout=120s

    log_info "Test workloads deployed"
}

get_replica_count() {
    kubectl get deployment e2e-test-app -n $NAMESPACE -o jsonpath='{.spec.replicas}' 2>/dev/null || echo "0"
}

get_hpa_min_replicas() {
    kubectl get hpa e2e-test-app -n $NAMESPACE -o jsonpath='{.spec.minReplicas}' 2>/dev/null || echo "?"
}

wait_for_scale_in() {
    log_info "Waiting for scale-in (up to ${WAIT_FOR_SCALE_IN}s)..."
    log_info "Service will be idle for ${SCALE_IN_TIMEOUT}s before scaling down"

    local elapsed=0
    local check_interval=10

    while [ $elapsed -lt $WAIT_FOR_SCALE_IN ]; do
        local replicas=$(get_replica_count)
        local hpa_min=$(get_hpa_min_replicas)

        echo -ne "\r  Elapsed: ${elapsed}s | Replicas: ${replicas} | HPA min: ${hpa_min}    "

        if [ "$hpa_min" = "0" ]; then
            echo ""
            log_info "Scale-in detected! HPA minReplicas set to 0"
            return 0
        fi

        sleep $check_interval
        elapsed=$((elapsed + check_interval))
    done

    echo ""
    log_error "Scale-in did not occur within ${WAIT_FOR_SCALE_IN}s"
    return 1
}

trigger_wakeup() {
    log_info "Triggering wakeup by calling the service endpoint..."

    # Call the scale0 wakeup server directly
    local wakeup_url="http://localhost:8080"

    # First request - should get tarpit cookie
    log_info "Sending initial request (tarpit check)..."
    local response=$(curl -s -w "\n%{http_code}" \
        -H "x-scale0-original-service: e2e-test-app" \
        -H "x-scale0-original-namespace: $NAMESPACE" \
        -H "Accept: application/json" \
        "$wakeup_url" 2>/dev/null || echo -e "\n000")

    local body=$(echo "$response" | head -n -1)
    local status=$(echo "$response" | tail -n 1)

    log_info "Initial response: HTTP $status"
    echo "$body" | head -c 200
    echo ""

    if [ "$status" = "503" ]; then
        # Extract cookie and wait for tarpit delay
        log_info "Got tarpit cookie, waiting for delay..."
        sleep 5

        # Second request with cookie
        local cookie=$(echo "$body" | grep -o '"test_tarpit=[^"]*"' | tr -d '"' || echo "")
        if [ -z "$cookie" ]; then
            # Try to extract Set-Cookie from a real curl
            cookie=$(curl -s -c - \
                -H "x-scale0-original-service: e2e-test-app" \
                -H "x-scale0-original-namespace: $NAMESPACE" \
                "$wakeup_url" 2>/dev/null | grep scale0_tarpit | awk '{print $NF}')
        fi

        log_info "Sending wakeup request..."
        curl -s \
            -H "x-scale0-original-service: e2e-test-app" \
            -H "x-scale0-original-namespace: $NAMESPACE" \
            -H "Cookie: scale0_tarpit=$cookie" \
            -H "Accept: application/json" \
            "$wakeup_url"
        echo ""
    fi
}

wait_for_scale_out() {
    log_info "Waiting for scale-out (up to ${WAIT_FOR_SCALE_OUT}s)..."

    local elapsed=0
    local check_interval=10

    while [ $elapsed -lt $WAIT_FOR_SCALE_OUT ]; do
        local replicas=$(get_replica_count)
        local hpa_min=$(get_hpa_min_replicas)

        echo -ne "\r  Elapsed: ${elapsed}s | Replicas: ${replicas} | HPA min: ${hpa_min}    "

        if [ "$hpa_min" != "0" ] && [ "$hpa_min" != "?" ]; then
            echo ""
            log_info "Scale-out detected! HPA minReplicas restored to $hpa_min"
            return 0
        fi

        sleep $check_interval
        elapsed=$((elapsed + check_interval))
    done

    echo ""
    log_error "Scale-out did not occur within ${WAIT_FOR_SCALE_OUT}s"
    return 1
}

cleanup() {
    log_info "Cleaning up..."

    # Stop controller
    if [ -f /tmp/scale0-controller.pid ]; then
        local pid=$(cat /tmp/scale0-controller.pid)
        if kill -0 $pid 2>/dev/null; then
            kill $pid 2>/dev/null || true
            log_info "Controller stopped"
        fi
        rm -f /tmp/scale0-controller.pid
    fi

    # Delete test resources
    kubectl delete namespace $NAMESPACE --ignore-not-found=true --wait=false

    log_info "Cleanup complete"
}

run_test() {
    log_info "=========================================="
    log_info "  K8S-SCALE0 E2E TEST"
    log_info "=========================================="
    log_info "Scale-in timeout: ${SCALE_IN_TIMEOUT}s ($(($SCALE_IN_TIMEOUT / 60)) minutes)"
    log_info ""

    check_prerequisites

    # Cleanup any previous run
    cleanup 2>/dev/null || true

    deploy_scale0_controller
    deploy_test_workloads

    log_info ""
    log_info "=== PHASE 1: Wait for scale-in ==="
    local initial_replicas=$(get_replica_count)
    log_info "Initial replica count: $initial_replicas"

    if ! wait_for_scale_in; then
        log_error "PHASE 1 FAILED: Scale-in did not occur"
        cleanup
        exit 1
    fi

    log_info ""
    log_info "=== PHASE 2: Trigger scale-out ==="
    trigger_wakeup

    if ! wait_for_scale_out; then
        log_error "PHASE 2 FAILED: Scale-out did not occur"
        cleanup
        exit 1
    fi

    # Verify final state
    local final_replicas=$(get_replica_count)
    local final_hpa_min=$(get_hpa_min_replicas)

    log_info ""
    log_info "=== FINAL STATE ==="
    log_info "Replicas: $final_replicas"
    log_info "HPA minReplicas: $final_hpa_min"

    if [ "$final_hpa_min" = "2" ]; then
        log_info ""
        log_info "=========================================="
        log_info "  E2E TEST PASSED"
        log_info "=========================================="
        cleanup
        exit 0
    else
        log_error ""
        log_error "=========================================="
        log_error "  E2E TEST FAILED"
        log_error "=========================================="
        cleanup
        exit 1
    fi
}

# Handle Ctrl+C
trap cleanup EXIT

# Parse arguments
case "${1:-}" in
    --cleanup)
        cleanup
        ;;
    --deploy-only)
        check_prerequisites
        deploy_test_workloads
        ;;
    *)
        run_test
        ;;
esac

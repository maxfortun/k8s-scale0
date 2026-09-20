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

install_gateway_api() {
    if kubectl get crd httproutes.gateway.networking.k8s.io &> /dev/null; then
        log_info "Gateway API CRDs already installed"
        return 0
    fi

    log_info "Installing Gateway API CRDs..."
    kubectl apply -f https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.0.0/standard-install.yaml 2>&1 || {
        log_error "Failed to install Gateway API CRDs"
        return 1
    }
    log_info "Gateway API CRDs installed"
}

install_istio() {
    if kubectl get crd virtualservices.networking.istio.io &> /dev/null; then
        log_info "Istio CRDs already installed"
        return 0
    fi

    log_info "Installing Istio (minimal profile)..."

    # Create modified kubeconfig for Docker (handles Docker Desktop)
    local kube_dir=$(mktemp -d)
    local k8s_server=$(kubectl config view --minify -o jsonpath='{.clusters[0].cluster.server}')

    # Replace localhost/127.0.0.1 with host.docker.internal for Docker access
    kubectl config view --raw | \
        sed 's/127.0.0.1/host.docker.internal/g' | \
        sed 's/localhost/host.docker.internal/g' | \
        sed 's/certificate-authority-data:.*/insecure-skip-tls-verify: true/' > "$kube_dir/config"
    chmod 644 "$kube_dir/config"

    docker run --rm --user root \
        -e KUBECONFIG=/root/.kube/config \
        -v "$kube_dir:/root/.kube" \
        istio/istioctl:1.20.0 install --set profile=minimal -y 2>&1 || {
        log_error "Failed to install Istio"
        rm -rf "$kube_dir"
        return 1
    }

    rm -rf "$kube_dir"

    # Wait for Istio to be ready
    log_info "Waiting for Istio to be ready..."
    kubectl wait --for=condition=available deployment/istiod -n istio-system --timeout=120s 2>&1 || {
        log_warn "Istio deployment not ready, continuing anyway"
    }

    log_info "Istio installed"
}

deploy_scale0_controller() {
    log_info "Deploying scale0 controller to cluster..."

    # Create scale0 namespace
    kubectl create namespace scale0 --dry-run=client -o yaml | kubectl apply -f -

    # Build Docker image
    log_info "Building Docker image..."
    cd "$SCRIPT_DIR/.."
    docker build -t scale0-controller:e2e-test . || {
        log_error "Docker build failed"
        exit 1
    }

    # Load image into cluster
    if command -v kind &> /dev/null && kind get clusters 2>/dev/null | grep -q .; then
        log_info "Loading image into kind..."
        kind load docker-image scale0-controller:e2e-test
    elif command -v minikube &> /dev/null && minikube status &> /dev/null; then
        log_info "Loading image into minikube..."
        minikube image load scale0-controller:e2e-test
    elif kubectl get nodes -o name | grep -q "desktop-control-plane"; then
        log_info "Loading image into Docker Desktop Kubernetes..."
        docker save scale0-controller:e2e-test | docker exec -i desktop-control-plane ctr --namespace k8s.io images import - 2>&1 || true
    fi

    # Deploy controller
    cat <<EOF | kubectl apply -f -
apiVersion: v1
kind: ServiceAccount
metadata:
  name: scale0-controller
  namespace: scale0
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: scale0-controller
rules:
  - apiGroups: [""]
    resources: ["services", "pods"]
    verbs: ["get", "list", "watch", "patch", "create", "delete"]
  - apiGroups: ["apps"]
    resources: ["deployments", "statefulsets", "replicasets"]
    verbs: ["get", "list", "watch", "patch"]
  - apiGroups: ["autoscaling"]
    resources: ["horizontalpodautoscalers"]
    verbs: ["get", "list", "watch", "patch"]
  - apiGroups: ["networking.istio.io"]
    resources: ["virtualservices"]
    verbs: ["get", "list", "watch", "patch", "update"]
  - apiGroups: ["gateway.networking.k8s.io"]
    resources: ["httproutes"]
    verbs: ["get", "list", "watch", "patch", "update"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: scale0-controller
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: scale0-controller
subjects:
  - kind: ServiceAccount
    name: scale0-controller
    namespace: scale0
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: scale0-controller
  namespace: scale0
spec:
  replicas: 1
  selector:
    matchLabels:
      app: scale0-controller
  template:
    metadata:
      labels:
        app: scale0-controller
    spec:
      serviceAccountName: scale0-controller
      containers:
        - name: scale0-controller
          image: scale0-controller:e2e-test
          imagePullPolicy: Never
          ports:
            - containerPort: 8080
          env:
            - name: CHECK_INTERVAL_MS
              value: "10000"
            - name: SCALE_IN_AFTER_SECONDS
              value: "$SCALE_IN_TIMEOUT"
            - name: WAKEUP_PORT
              value: "8080"
            - name: TARPIT_SECRET
              value: "e2e-test-secret"
            - name: TARPIT_DELAY_SECONDS
              value: "3"
            - name: SCALE0_SERVICE_NAME
              value: "scale0-controller"
            - name: SCALE0_SERVICE_NAMESPACE
              value: "scale0"
          readinessProbe:
            httpGet:
              path: /healthz
              port: 8080
            initialDelaySeconds: 5
            periodSeconds: 5
---
apiVersion: v1
kind: Service
metadata:
  name: scale0-controller
  namespace: scale0
spec:
  selector:
    app: scale0-controller
  ports:
    - port: 8080
      targetPort: 8080
EOF

    log_info "Waiting for controller to be ready..."
    kubectl rollout status deployment/scale0-controller -n scale0 --timeout=120s

    log_info "Controller deployed"
}

deploy_test_workloads() {
    log_info "Deploying test workloads (both Istio VirtualService and Gateway API HTTPRoute)..."

    # Create test namespace
    kubectl create namespace $NAMESPACE --dry-run=client -o yaml | kubectl apply -f -

    # Deploy test app with both routing types
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
# Gateway API HTTPRoute
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
---
# Istio VirtualService
apiVersion: networking.istio.io/v1beta1
kind: VirtualService
metadata:
  name: e2e-test-vs
  namespace: $NAMESPACE
spec:
  hosts:
    - e2e-test.example.com
  http:
    - match:
        - uri:
            prefix: /
      route:
        - destination:
            host: e2e-test-app
            port:
              number: 80
EOF

    log_info "Waiting for deployment to be ready..."
    kubectl rollout status deployment/e2e-test-app -n $NAMESPACE --timeout=120s

    log_info "Test workloads deployed (HTTPRoute + VirtualService)"
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

        echo -ne "\r  Elapsed: ${elapsed}s | Replicas: ${replicas}    "

        if [ "$replicas" = "0" ]; then
            echo ""
            log_info "Scale-in detected! Deployment scaled to 0 replicas"
            verify_routing_redirected
            return 0
        fi

        sleep $check_interval
        elapsed=$((elapsed + check_interval))
    done

    echo ""
    log_error "Scale-in did not occur within ${WAIT_FOR_SCALE_IN}s"
    return 1
}

verify_routing_redirected() {
    log_info "Verifying routing resources were redirected..."

    # Check HTTPRoute
    local httproute_backend=$(kubectl get httproute e2e-test-route -n $NAMESPACE -o jsonpath='{.spec.rules[0].backendRefs[0].name}' 2>/dev/null)
    if [ "$httproute_backend" = "scale0-controller" ]; then
        log_info "  HTTPRoute: redirected to scale0-controller ✓"
    else
        log_warn "  HTTPRoute: backend is '$httproute_backend' (expected scale0-controller)"
    fi

    # Check VirtualService
    local vs_host=$(kubectl get virtualservice e2e-test-vs -n $NAMESPACE -o jsonpath='{.spec.http[0].route[0].destination.host}' 2>/dev/null)
    if echo "$vs_host" | grep -q "scale0-controller"; then
        log_info "  VirtualService: redirected to scale0-controller ✓"
    else
        log_warn "  VirtualService: destination is '$vs_host' (expected scale0-controller)"
    fi
}

trigger_wakeup() {
    log_info "Triggering wakeup by calling the service endpoint..."

    # Port-forward to the scale0-controller service
    kubectl port-forward -n scale0 svc/scale0-controller 8080:8080 &
    local pf_pid=$!
    sleep 2

    local wakeup_url="http://localhost:8080"
    local cookie_jar=$(mktemp)

    # First request - should get tarpit cookie
    log_info "Sending initial request (tarpit check)..."
    local status=$(curl -s -o /dev/null -w "%{http_code}" -c "$cookie_jar" \
        -H "x-scale0-original-service: e2e-test-app" \
        -H "x-scale0-original-namespace: $NAMESPACE" \
        -H "Accept: application/json" \
        "$wakeup_url" 2>/dev/null || echo "000")

    log_info "Initial response: HTTP $status"

    if [ "$status" = "503" ]; then
        log_info "Got tarpit cookie, waiting for delay (5s)..."
        sleep 5

        log_info "Sending wakeup request with cookie..."
        local body=$(curl -s -b "$cookie_jar" \
            -H "x-scale0-original-service: e2e-test-app" \
            -H "x-scale0-original-namespace: $NAMESPACE" \
            -H "Accept: application/json" \
            "$wakeup_url" 2>/dev/null || echo "{}")

        log_info "Wakeup response: $body"
    fi

    rm -f "$cookie_jar"
    kill $pf_pid 2>/dev/null || true
}

wait_for_scale_out() {
    log_info "Waiting for scale-out (up to ${WAIT_FOR_SCALE_OUT}s)..."

    local elapsed=0
    local check_interval=10

    while [ $elapsed -lt $WAIT_FOR_SCALE_OUT ]; do
        local replicas=$(get_replica_count)

        echo -ne "\r  Elapsed: ${elapsed}s | Replicas: ${replicas}    "

        if [ "$replicas" != "0" ] && [ "$replicas" != "" ]; then
            echo ""
            log_info "Scale-out detected! Deployment scaled to $replicas replicas"
            verify_routing_restored
            return 0
        fi

        sleep $check_interval
        elapsed=$((elapsed + check_interval))
    done

    echo ""
    log_error "Scale-out did not occur within ${WAIT_FOR_SCALE_OUT}s"
    return 1
}

verify_routing_restored() {
    log_info "Verifying routing resources were restored..."

    # Check HTTPRoute
    local httproute_backend=$(kubectl get httproute e2e-test-route -n $NAMESPACE -o jsonpath='{.spec.rules[0].backendRefs[0].name}' 2>/dev/null)
    if [ "$httproute_backend" = "e2e-test-app" ]; then
        log_info "  HTTPRoute: restored to e2e-test-app ✓"
    else
        log_warn "  HTTPRoute: backend is '$httproute_backend' (expected e2e-test-app)"
    fi

    # Check VirtualService
    local vs_host=$(kubectl get virtualservice e2e-test-vs -n $NAMESPACE -o jsonpath='{.spec.http[0].route[0].destination.host}' 2>/dev/null)
    if [ "$vs_host" = "e2e-test-app" ]; then
        log_info "  VirtualService: restored to e2e-test-app ✓"
    else
        log_warn "  VirtualService: destination is '$vs_host' (expected e2e-test-app)"
    fi
}

cleanup() {
    log_info "Cleaning up..."

    # Delete test namespace
    kubectl delete namespace $NAMESPACE --ignore-not-found=true --wait=false

    # Delete scale0 controller
    kubectl delete namespace scale0 --ignore-not-found=true --wait=false

    log_info "Cleanup complete"
}

run_test() {
    log_info "=========================================="
    log_info "  K8S-SCALE0 E2E TEST"
    log_info "=========================================="
    log_info "Scale-in timeout: ${SCALE_IN_TIMEOUT}s ($(($SCALE_IN_TIMEOUT / 60)) minutes)"
    log_info ""

    check_prerequisites

    # Install routing CRDs if needed
    install_gateway_api
    install_istio

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

    log_info ""
    log_info "=== FINAL STATE ==="
    log_info "Replicas: $final_replicas"

    if [ "$final_replicas" -ge 1 ] 2>/dev/null; then
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

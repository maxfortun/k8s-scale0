# k8s-scale0

Kubernetes scale-to-zero controller with Istio VirtualService support.

## How it works

1. **Opt-in via labels**: Add labels to your Service to enable scale-to-zero
2. **Idle detection**: Controller monitors services and detects idle timeout
3. **Scale down**: When idle, sets HPA to 0 replicas and routes traffic to scale0
4. **Tarpit verification**: First request sets a signed cookie with future timestamp, returns 503 with Refresh header
5. **Wake on retry**: Second request verifies cookie timing, wakes the service, returns 503 with Refresh
6. **Bot detection**: Requests with invalid/early cookies get 418 "I'm a teapot"

## Labels

Add these to your Service:

| Label/Annotation | Required | Description |
|------------------|----------|-------------|
| `scale0/enabled` | Yes | Set to `"true"` to opt in |
| `scale0/scale-in-after` | No | Seconds of inactivity before scale-down (default: 86400 / 1 day) |
| `scale0/hpa` | No | HPA name (auto-discovered if not set) |
| `scale0/virtualservice` | No | VirtualService name(s), comma-separated (auto-discovered if not set) |
| `scale0/httproute` | No | HTTPRoute name(s), comma-separated (auto-discovered if not set) |
| `scale0/cors-origins` | No | Comma-separated list of allowed CORS origins for this service |
| `scale0/cors-credentials` | No | Set to `"true"` to allow credentials with CORS |

### Auto-Discovery

When `scale0/hpa` is not set, the controller auto-discovers the HPA:
1. HPA with same name as the Service
2. HPA whose `scaleTargetRef.name` matches the Service name
3. HPA targeting a workload that matches the Service selector

When `scale0/virtualservice` is not set, the controller auto-discovers all VirtualServices routing to the Service:
1. Scans all VirtualServices in the namespace
2. Matches any with a route destination pointing to the Service name

When `scale0/httproute` is not set, the controller auto-discovers all HTTPRoutes (Gateway API) routing to the Service:
1. Scans all HTTPRoutes in the namespace
2. Matches any with a backendRef pointing to the Service

Multiple VirtualServices and HTTPRoutes are supported - all will be redirected on scale-down and restored on wake-up.

### Scaling Modes

The controller auto-detects the best scaling method:

| Mode | Trigger | Scale Down | Wake Up |
|------|---------|------------|---------|
| **HPA** | HPA found | Set HPA min/max to 0 | Restore HPA min/max |
| **Workload** | No HPA, Deployment/StatefulSet found | Scale replicas to 0 | Restore replicas |
| **Pod** | No workload, standalone pods found | Delete pods | Recreate pods |

## Example

```yaml
apiVersion: v1
kind: Service
metadata:
  name: my-app
  labels:
    scale0/enabled: "true"
    scale0/scale-in-after: "3600"
spec:
  selector:
    app: my-app
  ports:
    - port: 80
```

## Deployment

```bash
# Build image
docker build -t scale0:latest .

# Deploy to cluster
kubectl apply -f k8s/
```

## Configuration

Environment variables:

### Controller Settings

| Variable | Default | Description |
|----------|---------|-------------|
| `CHECK_INTERVAL_MS` | 30000 | How often to check for idle services |
| `SCALE_IN_AFTER_SECONDS` | 86400 | Default scale-in timeout if not specified (1 day) |
| `LABEL_PREFIX` | scale0 | Label prefix for opt-in |
| `LEASE_DURATION_SECONDS` | 60 | Duration of distributed locks |
| `MAX_LOGGED_DISCOVERIES` | 1000 | Max discovery logs before clearing (memory bound) |
| `SCALE0_SERVICE_NAME` | scale0 | Name of the scale0 controller service |
| `SCALE0_SERVICE_NAMESPACE` | scale0 | Namespace of the scale0 controller |
| `SCALE0_PORT` | 8080 | Port used when redirecting traffic to scale0 |

### Wakeup Server Settings

| Variable | Default | Description |
|----------|---------|-------------|
| `WAKEUP_PORT` | 8080 | HTTP server port for wakeup requests |
| `RETRY_AFTER_SECONDS` | 5 | Seconds to wait before retry (Refresh header) |
| `WAKEUP_TIMEOUT_MS` | 30000 | Timeout for wakeup operations |
| `SERVER_TIMEOUT_MS` | 60000 | HTTP server request timeout |
| `SERVER_KEEPALIVE_MS` | 5000 | HTTP server keep-alive timeout |
| `SERVER_HEADERS_TIMEOUT_MS` | 10000 | HTTP server headers timeout |

### Tarpit Settings

| Variable | Default | Description |
|----------|---------|-------------|
| `TARPIT_SECRET` | (random) | HMAC secret for tarpit cookie signatures |
| `TARPIT_DELAY_SECONDS` | 3 | Minimum wait time before retry is accepted |
| `TARPIT_COOKIE_NAME` | scale0_tarpit | Cookie name for tarpit token |
| `TARPIT_COOKIE_MAX_AGE_SECONDS` | 300 | Cookie Max-Age attribute (5 minutes) |
| `TARPIT_MAX_VALIDITY_MS` | 300000 | Max time a tarpit token is valid after delay (5 minutes) |

### CORS Settings

| Variable | Default | Description |
|----------|---------|-------------|
| `CORS_ALLOWED_ORIGINS` | (none) | Default allowed CORS origins (comma-separated) |
| `CORS_ALLOW_CREDENTIALS` | false | Allow credentials when no explicit origins configured |

**Security notes:**
- Set `TARPIT_SECRET` explicitly in production. If not set, a random secret is generated, and tarpit cookies become invalid on pod restart.
- CORS can be configured per-service via annotations (highest priority), controller defaults, or fall back to wildcard `*`.

### CORS Priority

1. **Service annotation** (`scale0/cors-origins`) - highest priority
2. **Controller default** (`CORS_ALLOWED_ORIGINS` env var)
3. **Reflect origin** if `CORS_ALLOW_CREDENTIALS=true` or `scale0/cors-credentials=true`
4. **Wildcard `*`** - default when nothing configured

## Distributed Locking

When running multiple controller replicas, Kubernetes Leases are used to prevent race conditions during scale-down and wake-up operations:

- **Lease-based coordination**: Each scale-down or wake-up acquires a distributed lease before proceeding
- **Automatic expiry**: Leases expire after `LEASE_DURATION_SECONDS` (default 60s), preventing deadlocks from crashed pods
- **Per-service locks**: Each service has independent `scaledown-{name}` and `wakeup-{name}` leases

The controller requires RBAC permissions for the `coordination.k8s.io/leases` resource.

## State Persistence

Scaled-down state is persisted to Service annotations (`scale0/scaled-down-state`). This means:

- **Survives pod restarts**: On startup, the controller recovers state from Service annotations
- **No external dependencies**: State lives in Kubernetes, no Redis/etcd needed
- **Visible state**: You can inspect the annotation to see the original configuration

```bash
kubectl get svc my-app -o jsonpath='{.metadata.annotations.scale0/scaled-down-state}' | jq
```

## Endpoints

- `GET /healthz` - Liveness probe
- `GET /readyz` - Readiness probe
- `GET /status` - Current state of tracked/scaled-down services
- `GET /metrics` - Prometheus metrics

## Prometheus Metrics

The controller exposes Prometheus metrics at `/metrics`:

### Counters

| Metric | Labels | Description |
|--------|--------|-------------|
| `scale0_scaledowns_total` | namespace, service, mode | Total successful scale-down operations |
| `scale0_wakeups_total` | namespace, service, mode | Total successful wakeup operations |
| `scale0_scaledown_errors_total` | namespace, service | Failed scale-down operations |
| `scale0_wakeup_errors_total` | namespace, service | Failed wakeup operations |
| `scale0_tarpit_checks_total` | result | Tarpit verification attempts (new/early/invalid/pass) |
| `scale0_wakeup_requests_total` | status_code | Wakeup HTTP requests by response code |

### Gauges

| Metric | Description |
|--------|-------------|
| `scale0_services_tracked` | Services currently being monitored |
| `scale0_services_scaled_down` | Services currently in scaled-down state |
| `scale0_active_leases` | Currently held distributed leases |

### Histograms

| Metric | Labels | Buckets (seconds) | Description |
|--------|--------|-------------------|-------------|
| `scale0_scaledown_duration_seconds` | namespace, service, mode | 0.1, 0.5, 1, 2, 5, 10, 30, 60 | Duration of scale-down operations |
| `scale0_wakeup_duration_seconds` | namespace, service, mode | 0.1, 0.5, 1, 2, 5, 10, 30, 60 | Duration of wakeup operations |
| `scale0_reconcile_duration_seconds` | - | 0.01, 0.05, 0.1, 0.5, 1, 2, 5 | Duration of reconciliation loop iterations |

### Scrape Config

```yaml
scrape_configs:
  - job_name: 'scale0'
    kubernetes_sd_configs:
      - role: pod
    relabel_configs:
      - source_labels: [__meta_kubernetes_pod_label_app]
        regex: scale0
        action: keep
      - source_labels: [__meta_kubernetes_pod_container_port_number]
        regex: "8080"
        action: keep
```

## Tarpit

The tarpit prevents bots and scrapers from triggering unnecessary scale-outs:

1. **First request**: No cookie → set signed cookie with `exp = now + TARPIT_DELAY_SECONDS`, return 503 + Refresh header
2. **Valid retry**: Cookie present + signature valid + time elapsed → wake up service, return 503 + Refresh
3. **Invalid**: Bad signature → 418 "I'm a teapot"
4. **Too early**: Valid signature but arrived before expiry → 418 with remaining wait time

The cookie contains:
- `exp`: Unix timestamp when retry is allowed
- `nonce`: Random value to prevent replay
- `sig`: HMAC-SHA256 of the payload

Legitimate browsers follow Refresh headers and support cookies. Bots that ignore either get blocked.

## Rate Limiting

**The tarpit already provides effective rate limiting:**
- Each client can trigger at most 1 wakeup per `TARPIT_DELAY_SECONDS` (default 3s)
- Requests without valid cookies are rejected (503 with new cookie)
- Early retries are rejected (418)
- Invalid signatures are rejected (418)

This prevents both accidental spam and simple bot attacks without additional configuration.

**For additional protection** (DDoS, compliance requirements), you'll need mesh-level rate limiting. Istio VirtualService doesn't support rate limiting natively - it requires EnvoyFilter or an external rate limit service. Gateway API implementations vary:

- **Istio**: Use [EnvoyFilter with local_ratelimit](https://istio.io/latest/docs/tasks/policy-enforcement/rate-limit/)
- **Envoy Gateway**: Use [BackendTrafficPolicy](https://gateway.envoyproxy.io/docs/tasks/traffic/local-rate-limit/)
- **GKE Gateway**: Use GCPBackendPolicy
- **Kong**: Use KongPlugin with rate-limiting

These apply to the `scale0-controller` service to limit requests before they reach the tarpit.

## Testing

### Unit & Integration Tests (Mocked)

Fast tests using mocked K8s APIs (~4 seconds):

```bash
cd app
npm test              # All tests with coverage
npm run test:unit     # Unit tests only
npm run test:watch    # Watch mode
```

### E2E Test (Real Cluster)

Tests against a real Kubernetes cluster with actual scale-in/scale-out cycles:

```bash
./test/e2e-test.sh
```

This test:
1. Deploys test workloads to the cluster
2. Waits 2 minutes for services to go idle
3. Verifies HPA is set to 0 (scale-in)
4. Calls the wakeup endpoint (with tarpit flow)
5. Verifies HPA is restored (scale-out)

**Requirements:** `kubectl` with cluster access, Docker (for Istio install). ~5 minutes runtime.

The test automatically installs Gateway API CRDs and Istio if not present.

### Test Manifests

| Manifest | Scale-in | Description |
|----------|----------|-------------|
| `02-test-app.yaml` | 2 min | Standard test with HPA |
| `03-quick-scale-app.yaml` | 1 min | Fast iteration |
| `04-no-hpa-app.yaml` | 2 min | Direct workload scaling |
| `05-gateway-api-app.yaml` | 2 min | Gateway API HTTPRoute |

Deploy manually: `kubectl apply -f test/manifests/`

## Requirements

- Kubernetes cluster (GKE, EKS, AKS, etc.)
- One of:
  - Istio with VirtualServices
  - Gateway API with HTTPRoutes (GKE native)
- Optional: HPA for auto-scaling (works without HPA too)

## License

This project is licensed under the [PolyForm Noncommercial License 1.0.0](LICENSE). You may use, modify, and distribute this software for any noncommercial purpose. Commercial use requires a separate license.

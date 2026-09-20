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

| Label | Required | Description |
|-------|----------|-------------|
| `scale0/enabled` | Yes | Set to `"true"` to opt in |
| `scale0/scale-in-after` | No | Seconds of inactivity before scale-down (default: 86400 / 1 day) |
| `scale0/hpa` | No | HPA name (auto-discovered if not set) |
| `scale0/virtualservice` | No | VirtualService name(s), comma-separated (auto-discovered if not set) |
| `scale0/httproute` | No | HTTPRoute name(s), comma-separated (auto-discovered if not set) |

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

| Variable | Default | Description |
|----------|---------|-------------|
| `CHECK_INTERVAL_MS` | 30000 | How often to check for idle services |
| `WAKEUP_PORT` | 8080 | HTTP server port |
| `SCALE_IN_AFTER_SECONDS` | 86400 | Default scale-in timeout if not specified (1 day) |
| `RETRY_AFTER_SECONDS` | 5 | Seconds to wait before retry (Refresh header) |
| `LABEL_PREFIX` | scale0 | Label prefix for opt-in |
| `TARPIT_SECRET` | (random) | HMAC secret for tarpit cookie signatures |
| `TARPIT_DELAY_SECONDS` | 3 | Minimum wait time before retry is accepted |
| `TARPIT_COOKIE_NAME` | scale0_tarpit | Cookie name for tarpit token |
| `CORS_ALLOWED_ORIGINS` | (none) | Comma-separated list of allowed CORS origins |
| `WAKEUP_TIMEOUT_MS` | 30000 | Timeout for wakeup operations |

**Security note:** Set `TARPIT_SECRET` explicitly in production. If not set, a random secret is generated, and tarpit cookies become invalid on pod restart.

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

## Testing

```bash
cd app

# Run all tests with coverage
npm test

# Run unit tests only
npm run test:unit

# Run integration tests only
npm run test:integration

# Watch mode for development
npm run test:watch
```

Test workloads with short timeframes (30-120 seconds) are available in `test/manifests/` for testing in a real cluster.

## Requirements

- Kubernetes cluster (GKE, EKS, AKS, etc.)
- One of:
  - Istio with VirtualServices
  - Gateway API with HTTPRoutes (GKE native)
- Optional: HPA for auto-scaling (works without HPA too)

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
| `scale0.io/enabled` | Yes | Set to `"true"` to opt in |
| `scale0.io/scale-in-after` | No | Seconds of inactivity before scale-down (default: 86400 / 1 day) |
| `scale0.io/hpa` | No | HPA name if different from service name |
| `scale0.io/virtualservice` | No | VirtualService name if different from service name |

## Example

```yaml
apiVersion: v1
kind: Service
metadata:
  name: my-app
  labels:
    scale0.io/enabled: "true"
    scale0.io/scale-in-after: "3600"
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
kubectl apply -f k8s/rbac.yaml
kubectl apply -f k8s/deployment.yaml
```

## Configuration

Environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `CHECK_INTERVAL_MS` | 30000 | How often to check for idle services |
| `WAKEUP_PORT` | 8080 | HTTP server port |
| `SCALE_IN_AFTER_SECONDS` | 86400 | Default scale-in timeout if not specified (1 day) |
| `RETRY_AFTER_SECONDS` | 5 | Seconds to wait before retry (Refresh header) |
| `LABEL_PREFIX` | scale0.io | Label prefix for opt-in |
| `TARPIT_SECRET` | (random) | HMAC secret for tarpit cookie signatures |
| `TARPIT_DELAY_SECONDS` | 3 | Minimum wait time before retry is accepted |
| `TARPIT_COOKIE_NAME` | scale0_tarpit | Cookie name for tarpit token |

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

## Requirements

- Kubernetes cluster
- Istio with VirtualServices
- HPA configured for opt-in services

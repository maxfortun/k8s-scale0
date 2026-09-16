# Example: Opting into scale0

This example shows a complete application setup that opts into scale0.

## Key Configuration

The Service includes scale0 labels:

```yaml
metadata:
  labels:
    scale0/enabled: "true"           # Required: opt-in
    scale0/scale-in-after: "3600"    # Optional: 1 hour (default: 86400 / 1 day)
```

## Requirements

For scale0 to manage your application, you need:

1. **Service** with `scale0/enabled: "true"` label
2. **HPA** with the same name as the Service (or specify `scale0/hpa` label)
3. **VirtualService** with the same name as the Service (or specify `scale0/virtualservice` label)

## What happens

1. **Normal operation**: Your app runs as usual with HPA scaling
2. **After idle timeout**: scale0 sets HPA min/max to 0 and redirects VirtualService to itself
3. **On request**: scale0 verifies the client (tarpit), restores HPA/VirtualService, returns 503 with Refresh header
4. **Client retries**: Request goes to your now-waking app

## Examples

### Deployment-based app
```bash
kubectl apply -f deployment/
```

### StatefulSet-based app
```bash
kubectl apply -f statefulset/
```

### Standalone pod (no HPA/controller)
```bash
kubectl apply -f pod/
```

### Gateway API (GKE without Istio)
```bash
kubectl apply -f gateway-api/
```

## Labels Reference

| Label | Required | Default | Description |
|-------|----------|---------|-------------|
| `scale0/enabled` | Yes | - | Set to `"true"` to opt in |
| `scale0/scale-in-after` | No | `86400` | Seconds before scale-down |
| `scale0/hpa` | No | Service name | HPA name if different |
| `scale0/virtualservice` | No | Service name | VirtualService name if different |

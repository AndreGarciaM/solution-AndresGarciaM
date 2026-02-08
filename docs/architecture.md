# Architecture Documentation

## System Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   API Gateway   │────▶│  User Service   │────▶│     Redis       │
│   (port 3000)   │     │   (port 3001)   │     │   (port 6379)   │
└─────────────────┘     └─────────────────┘     └─────────────────┘
        │                       │                       │
        ▼                       ▼                       ▼
   Network Policy          Network Policy          Network Policy
   (ingress: any)          (ingress: gateway)     (ingress: user-svc)
   (egress: user-svc)      (egress: redis)        (egress: none)
```

## Design Decisions

### Docker Strategy

- Base image choice: `node:20.18-alpine3.19` for minimal footprint and security patches
- Multi-stage build approach: Stage 1 (deps) installs and cleans dependencies, Stage 2 (production) copies only required files
- Security considerations: Non-root user (UID 1001), removed npm/corepack from production image
- Layer optimization: Aggressive cleanup of node_modules (removed docs, tests, TypeScript files, licenses)
- Final image size: 196MB (under 200MB requirement)

### Kubernetes Design

- Namespace strategy: Dedicated `devops-challenge` namespace for isolation
- Resource allocation rationale:
  - Base: CPU 100m-500m, Memory 128Mi-256Mi (suitable for Node.js)
  - Prod: CPU 200m-1000m, Memory 256Mi-512Mi (headroom for traffic spikes)
- Health check configuration:
  - Liveness: `/health/live` - restart container if unresponsive
  - Readiness: `/health/ready` - remove from service if dependencies down
- Scaling strategy: HPA with CPU target 70%, min 2 replicas (base), min 3 replicas (prod)

### Environment & Secrets Management

- Config separation: ConfigMaps for non-sensitive (ports, URLs, log levels), Secrets for sensitive (passwords)
- Environment handling: Kustomize overlays for dev (debug logging, 1 replica) and prod (warn logging, 3 replicas)

#### Production Secrets Strategy

For production environments, the empty `REDIS_PASSWORD` in base configuration should be replaced using one of these approaches:

1. **External Secrets Operator** (Recommended for AWS/GCP/Azure)
   - Syncs secrets from cloud provider secret managers (AWS Secrets Manager, GCP Secret Manager, Azure Key Vault)
   - Automatic rotation support
   - Example: ExternalSecret CRD references AWS Secrets Manager ARN

2. **Sealed Secrets** (Recommended for GitOps)
   - Encrypt secrets with cluster-specific key
   - Safe to commit encrypted secrets to Git
   - Bitnami Sealed Secrets controller decrypts at runtime

3. **HashiCorp Vault**
   - Centralized secrets management
   - Dynamic secrets with TTL
   - Vault Agent Injector for automatic secret injection

Implementation: Secrets are never committed to Git. CI/CD pipeline injects secrets at deploy time via environment-specific secret stores.

## Trade-offs & Assumptions

1. **Trade-off: Image size vs build complexity**
   - Decision: Aggressive node_modules cleanup in Dockerfile
   - Rationale: Reduced image size from 212MB to 196MB
   - Alternative considered: Distroless images (rejected due to debugging limitations)

2. **Trade-off: HPA CPU-only vs multi-metric**
   - Decision: CPU-based autoscaling at 70%
   - Rationale: Simple, predictable, sufficient for HTTP workloads
   - Alternative considered: Memory + custom metrics (added complexity)

3. **Trade-off: Network Policy strictness**
   - Decision: Zero-trust model with explicit allow rules
   - Rationale: Defense in depth, limits blast radius
   - Alternative considered: Allow-all (rejected for security)

4. **Trade-off: Redis without persistent storage (no PVC)**
   - Decision: Redis deployed without PersistentVolumeClaim — data lives only in memory
   - Rationale: User data in this challenge is sample/seed data re-created on startup via `initializeData()`. Persistence would add operational complexity (PVC provisioning, backup strategy, StorageClass dependency) without benefit for ephemeral demo data
   - Risk: Pod restart or eviction loses all Redis data
   - Mitigation: Application re-seeds sample data on startup when the `users` key is absent
   - Alternative considered: PVC with ReadWriteOnce (rejected — adds infra dependency for throwaway data)

## Security Considerations

- Containers run as non-root (UID 1001)
- Network Policies implement zero-trust networking
- Secrets stored in Kubernetes Secret objects (not hardcoded)
- Security contexts enforce `runAsNonRoot: true`
- No privileged containers
- Resource limits prevent DoS via resource exhaustion

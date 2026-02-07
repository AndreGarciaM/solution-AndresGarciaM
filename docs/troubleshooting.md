# Troubleshooting Report

> **Note to Candidate:** Document all the issues you found in the `k8s/broken/` manifests.

## Overview

Analysis of the `k8s/broken/` directory revealed **8 configuration issues** that prevent the application from functioning correctly in a Kubernetes cluster.

| # | Issue | File | Description |
|---|-------|------|-------------|
| 1 | Label Mismatch | api-gateway.yaml | Selector uses `app: api-gateway` but pod labels use `app: gateway`, preventing Deployment from managing pods |
| 2 | Wrong Container Port | api-gateway.yaml | containerPort declared as 8080 but application listens on 3000, breaking service mesh and monitoring |
| 3 | Insufficient Memory | api-gateway.yaml | Memory limit of 64Mi is too low for Node.js, causing OOMKilled restarts |
| 4 | Wrong Redis Hostname | user-service.yaml | REDIS_HOST set to `redis-master` but service is named `redis`, causing connection failures |
| 5 | Aggressive Liveness Probe | user-service.yaml | failureThreshold of 1 causes unnecessary restarts on transient failures |
| 6 | Service Port Mismatch | user-service.yaml | Service targetPort is 8080 but container listens on 3001, making service unreachable |
| 7 | Redis Auth Mismatch | redis.yaml | Redis requires password but user-service has no REDIS_PASSWORD configured |
| 8 | Secrets in ConfigMap | configmap.yaml | Sensitive credentials stored in ConfigMap instead of Secret, violating security practices |

## Issues Found

---

### Issue 1: Label Mismatch in API Gateway Deployment

- **File:** `k8s/broken/api-gateway.yaml` (lines 10, 14)
- **Severity:** Critical
- **Category:** Configuration

#### What is wrong
The selector `matchLabels` specifies `app: api-gateway` but the pod template labels specify `app: gateway`. These labels must match exactly for the Deployment controller to manage pods.

#### Symptoms in Production
- `kubectl get deployments` shows 0/1 READY for api-gateway
- `kubectl get pods` shows pods running but Deployment doesn't recognize them
- Scaling commands have no effect
- Rolling updates fail silently

#### How to Diagnose
```bash
# Check deployment status
kubectl get deployment api-gateway -o wide

# Compare selector vs pod labels
kubectl get deployment api-gateway -o jsonpath='{.spec.selector.matchLabels}'
kubectl get pods -l app=gateway --show-labels

# View deployment events
kubectl describe deployment api-gateway | grep -A 10 Events
```

#### Root Cause Analysis
The Deployment controller uses label selectors to identify which pods it owns. When selector `app: api-gateway` doesn't match pod label `app: gateway`, the controller creates new pods infinitely or fails to track existing ones.

#### Solution
Change line 14 from `app: gateway` to `app: api-gateway`:

```yaml
spec:
  selector:
    matchLabels:
      app: api-gateway
  template:
    metadata:
      labels:
        app: api-gateway  # Must match selector exactly
```

---

### Issue 2: Wrong Container Port Declaration in API Gateway

- **File:** `k8s/broken/api-gateway.yaml` (line 20)
- **Severity:** Medium
- **Category:** Configuration

#### What is wrong
The `containerPort` is declared as 8080 but the application listens on port 3000 (confirmed by PORT environment variable on line 23).

#### Symptoms in Production
- Service mesh (Istio/Linkerd) routing failures
- Prometheus service discovery scrapes wrong port
- Network policies based on port may not work
- Health checks may target wrong port

#### How to Diagnose
```bash
# Check what port the container actually listens on
kubectl exec -it <pod-name> -- netstat -tlnp

# Check container port declaration
kubectl get pod <pod-name> -o jsonpath='{.spec.containers[0].ports}'

# Compare with environment variable
kubectl get pod <pod-name> -o jsonpath='{.spec.containers[0].env}' | grep PORT
```

#### Root Cause Analysis
While the Service correctly routes to port 3000, the containerPort declaration is informational metadata. Incorrect values cause confusion and break tools that rely on this metadata (service meshes, monitoring, documentation generators).

#### Solution
Change line 20 from `containerPort: 8080` to `containerPort: 3000`:

```yaml
ports:
  - name: http
    containerPort: 3000
    protocol: TCP
```

---

### Issue 3: Insufficient Memory Limit for Node.js Application

- **File:** `k8s/broken/api-gateway.yaml` (line 32)
- **Severity:** High
- **Category:** Resources

#### What is wrong
Memory limit is set to 64Mi which is insufficient for a Node.js application. Node.js V8 engine requires minimum 128Mi for basic operation, and Express applications typically need 256-512Mi.

#### Symptoms in Production
- Pods constantly restarting with OOMKilled status
- `kubectl describe pod` shows `Reason: OOMKilled`
- Application crashes during traffic spikes
- Incomplete request processing
- Memory-related errors in application logs

#### How to Diagnose
```bash
# Check pod restart count and status
kubectl get pods -l app=api-gateway

# Check termination reason
kubectl describe pod <pod-name> | grep -A 5 "Last State"

# View memory usage
kubectl top pod <pod-name>

# Check events for OOM
kubectl get events --field-selector reason=OOMKilled
```

#### Root Cause Analysis
Node.js uses V8 JavaScript engine which requires memory for:
- Heap allocation (default max ~512MB)
- Stack frames for async operations
- Buffer pools for I/O operations
- Internal structures and garbage collection

64Mi is below V8's minimum operational threshold, causing immediate OOMKill.

#### Solution
Increase memory limits to appropriate values:

```yaml
resources:
  requests:
    cpu: "50m"
    memory: "128Mi"
  limits:
    cpu: "200m"
    memory: "256Mi"
```

---

### Issue 4: Wrong Redis Hostname in User Service

- **File:** `k8s/broken/user-service.yaml` (line 25)
- **Severity:** Critical
- **Category:** Configuration

#### What is wrong
The `REDIS_HOST` environment variable is set to `redis-master` but the Redis Service is named `redis` (as defined in redis.yaml).

#### Symptoms in Production
- User service fails to start or crashes on first Redis operation
- Application logs show `ENOTFOUND redis-master` or connection refused
- Health checks fail on `/health/ready` endpoint
- All user CRUD operations return 500 errors

#### How to Diagnose
```bash
# Check DNS resolution inside the pod
kubectl exec -it <user-service-pod> -- nslookup redis-master
kubectl exec -it <user-service-pod> -- nslookup redis

# Check available services
kubectl get svc -n devops-challenge

# View application logs for connection errors
kubectl logs <user-service-pod> | grep -i redis

# Test Redis connectivity
kubectl exec -it <user-service-pod> -- nc -zv redis 6379
```

#### Root Cause Analysis
Kubernetes DNS creates service records in format `<service-name>.<namespace>.svc.cluster.local`. The Redis service is named `redis`, so the correct hostname is `redis` (or `redis.devops-challenge.svc.cluster.local`). `redis-master` doesn't exist in DNS.

#### Solution
Change line 25 from `value: "redis-master"` to `value: "redis"`:

```yaml
env:
  - name: REDIS_HOST
    value: "redis"
```

---

### Issue 5: Overly Aggressive Liveness Probe Failure Threshold

- **File:** `k8s/broken/user-service.yaml` (line 41)
- **Severity:** Medium
- **Category:** Reliability

#### What is wrong
The liveness probe `failureThreshold` is set to 1, meaning a single failed health check triggers an immediate pod restart.

#### Symptoms in Production
- Frequent unnecessary pod restarts
- `kubectl describe pod` shows multiple restarts
- Service disruptions during garbage collection pauses
- Restart loops during high CPU load
- Intermittent 503 errors during pod cycling

#### How to Diagnose
```bash
# Check restart count
kubectl get pods -l app=user-service -o wide

# View restart history
kubectl describe pod <pod-name> | grep -A 10 "Restart Count"

# Check liveness probe configuration
kubectl get pod <pod-name> -o jsonpath='{.spec.containers[0].livenessProbe}'

# Monitor real-time restarts
kubectl get pods -w
```

#### Root Cause Analysis
Transient failures are normal in distributed systems:
- Network latency spikes
- Garbage collection pauses (Node.js can pause 50-200ms)
- CPU throttling under load
- Temporary I/O delays

A single failure shouldn't trigger restart. Kubernetes best practice recommends `failureThreshold: 3` minimum.

#### Solution
Change line 41 from `failureThreshold: 1` to `failureThreshold: 3`:

```yaml
livenessProbe:
  httpGet:
    path: /health/live
    port: 3001
  initialDelaySeconds: 10
  periodSeconds: 10
  timeoutSeconds: 5
  failureThreshold: 3
  successThreshold: 1
```

---

### Issue 6: Service targetPort Mismatch in User Service

- **File:** `k8s/broken/user-service.yaml` (line 60)
- **Severity:** Critical
- **Category:** Networking

#### What is wrong
The Service `targetPort` is set to 8080 but the container listens on port 3001 (defined in containerPort and PORT environment variable).

#### Symptoms in Production
- All requests to user-service return connection refused
- API Gateway receives 502 Bad Gateway when proxying to user-service
- `kubectl port-forward svc/user-service 3001:3001` doesn't work
- Service endpoints show correct pod IPs but wrong port

#### How to Diagnose
```bash
# Check service endpoints
kubectl get endpoints user-service -o yaml

# Test connectivity to the service
kubectl run debug --image=busybox --rm -it -- wget -qO- http://user-service:3001/health

# Check what port container is listening on
kubectl exec -it <pod-name> -- netstat -tlnp

# Compare service spec vs container spec
kubectl get svc user-service -o jsonpath='{.spec.ports}'
kubectl get pod <pod-name> -o jsonpath='{.spec.containers[0].ports}'
```

#### Root Cause Analysis
The Service routes traffic as: `Client -> Service:port -> Pod:targetPort`. When targetPort (8080) doesn't match the actual listening port (3001), TCP connections fail with "connection refused" because nothing is bound to port 8080 inside the container.

#### Solution
Change line 60 from `targetPort: 8080` to `targetPort: 3001`:

```yaml
spec:
  selector:
    app: user-service
  ports:
    - name: http
      port: 3001
      targetPort: 3001
      protocol: TCP
```

---

### Issue 7: Redis Password Authentication Mismatch

- **File:** `k8s/broken/redis.yaml` (line 21)
- **Severity:** Critical
- **Category:** Security/Configuration

#### What is wrong
Redis is started with `--requirepass supersecret` requiring authentication, but the user-service configuration doesn't include `REDIS_PASSWORD` environment variable.

#### Symptoms in Production
- User service logs show `NOAUTH Authentication required`
- All Redis operations fail with authentication errors
- `/health/ready` endpoint returns 503 (Redis dependency down)
- Application starts but all user operations fail

#### How to Diagnose
```bash
# Check Redis logs
kubectl logs <redis-pod>

# Try to connect to Redis without password
kubectl exec -it <redis-pod> -- redis-cli PING
# Returns: (error) NOAUTH Authentication required

# Check if password env var exists in user-service
kubectl get pod <user-service-pod> -o jsonpath='{.spec.containers[0].env}' | grep -i redis

# Test with password
kubectl exec -it <redis-pod> -- redis-cli -a supersecret PING
# Returns: PONG
```

#### Root Cause Analysis
Redis `--requirepass` flag enables authentication. All clients must send `AUTH <password>` before any other command. The user-service application expects `REDIS_PASSWORD` environment variable to authenticate, but it's not configured.

#### Solution

**Option A: Remove password requirement (development only):**
```yaml
# redis.yaml
spec:
  containers:
    - name: redis
      command: ["redis-server"]  # Remove --requirepass
```

**Option B: Add password to user-service (recommended for production):**
```yaml
# Create secret
apiVersion: v1
kind: Secret
metadata:
  name: redis-credentials
type: Opaque
stringData:
  password: "supersecret"
---
# In user-service deployment
env:
  - name: REDIS_PASSWORD
    valueFrom:
      secretKeyRef:
        name: redis-credentials
        key: password
```

---

### Issue 8: Sensitive Credentials Stored in ConfigMap

- **File:** `k8s/broken/configmap.yaml` (lines 12, 15)
- **Severity:** High
- **Category:** Security

#### What is wrong
Sensitive data (`REDIS_PASSWORD: supersecret` and `DATABASE_URL` containing username/password) are stored in a ConfigMap instead of a Secret.

#### Symptoms in Production
- Security audit failures
- Compliance violations (SOC2, HIPAA, PCI-DSS)
- Credentials visible in plain text via `kubectl get configmap -o yaml`
- Credentials exposed in version control if manifests are committed
- No encryption at rest in etcd

#### How to Diagnose
```bash
# View ConfigMap contents (credentials visible in plain text)
kubectl get configmap app-config -o yaml

# Check if RBAC allows wide ConfigMap access
kubectl auth can-i get configmaps --as=system:serviceaccount:default:default

# Audit who accessed ConfigMaps
kubectl get events --field-selector reason=ConfigMapAccessed
```

#### Root Cause Analysis
ConfigMaps are designed for non-sensitive configuration. They:
- Store data in plain text (base64 in Secrets is not encryption, but enables binary data)
- Are not encrypted at rest by default
- Have less restrictive RBAC by convention
- May be logged or exposed in debugging output

Kubernetes Secrets:
- Can be encrypted at rest with EncryptionConfiguration
- Support external secret management integration (Vault, AWS Secrets Manager)
- Have stricter RBAC policies by convention
- Are designed for sensitive data workflows

#### Solution
Move credentials to a Kubernetes Secret:

```yaml
# Create Secret (never commit to version control)
apiVersion: v1
kind: Secret
metadata:
  name: app-secrets
  namespace: devops-challenge
type: Opaque
stringData:
  REDIS_PASSWORD: "supersecret"
  DATABASE_URL: "postgresql://admin:p4ssw0rd@db:5432/app"
---
# Update ConfigMap to remove sensitive values
apiVersion: v1
kind: ConfigMap
metadata:
  name: app-config
data:
  LOG_LEVEL: "info"
  NODE_ENV: "production"
---
# Reference in Deployment
env:
  - name: REDIS_PASSWORD
    valueFrom:
      secretKeyRef:
        name: app-secrets
        key: REDIS_PASSWORD
  - name: DATABASE_URL
    valueFrom:
      secretKeyRef:
        name: app-secrets
        key: DATABASE_URL
  - name: LOG_LEVEL
    valueFrom:
      configMapKeyRef:
        name: app-config
        key: LOG_LEVEL
```

**Production Recommendation:** Use external secrets management:
- HashiCorp Vault with Kubernetes auth
- AWS Secrets Manager with External Secrets Operator
- Azure Key Vault with CSI driver

---

## Summary Table

| # | Issue | File | Line(s) | Severity | Impact |
|---|-------|------|---------|----------|--------|
| 1 | Label mismatch | api-gateway.yaml | 10, 14 | Critical | Deployment cannot manage pods |
| 2 | Wrong containerPort | api-gateway.yaml | 20 | Medium | Service mesh/monitoring failures |
| 3 | Insufficient memory | api-gateway.yaml | 32 | High | OOMKilled, constant restarts |
| 4 | Wrong Redis hostname | user-service.yaml | 25 | Critical | Cannot connect to Redis |
| 5 | Aggressive failureThreshold | user-service.yaml | 41 | Medium | Unnecessary restarts |
| 6 | targetPort mismatch | user-service.yaml | 60 | Critical | Service unreachable |
| 7 | Redis auth mismatch | redis.yaml | 21 | Critical | Authentication failures |
| 8 | Secrets in ConfigMap | configmap.yaml | 12, 15 | High | Security/compliance violation |

## Impact Analysis

### Critical Issues (Must Fix Immediately)
Issues 1, 4, 6, and 7 will completely prevent the application from functioning:
- No traffic reaches the API Gateway (Issue 1)
- User service cannot store/retrieve data (Issues 4, 7)
- Inter-service communication fails (Issue 6)

### High Severity Issues (Fix Before Production)
Issues 3 and 8 cause runtime failures or security risks:
- Application crashes under normal load (Issue 3)
- Credential exposure risk (Issue 8)

### Medium Severity Issues (Fix Soon)
Issues 2 and 5 affect reliability and observability:
- Monitoring and service mesh issues (Issue 2)
- Reduced availability from unnecessary restarts (Issue 5)

## Verification Commands

After applying fixes, verify with:

```bash
# Check all pods are running
kubectl get pods -n devops-challenge

# Verify deployment is managing pods
kubectl get deployment -n devops-challenge -o wide

# Test service connectivity
kubectl run debug --rm -it --image=busybox -- wget -qO- http://api-gateway:3000/health

# Check Redis connectivity
kubectl exec -it <user-service-pod> -- node -e "require('ioredis')({host:'redis'}).ping().then(console.log)"

# Verify no secrets in ConfigMaps
kubectl get configmap -o yaml | grep -i password
```

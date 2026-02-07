# Monitoring Strategy

## Overview

This document outlines the monitoring and observability strategy for the DevOps Challenge project. Both services (API Gateway and User Service) implement Prometheus metrics and structured JSON logging for comprehensive system monitoring.

## Metrics Collection

### Metrics Endpoint

Both services expose metrics at the `/metrics` endpoint in Prometheus format:
- API Gateway: `http://localhost:3000/metrics`
- User Service: `http://localhost:3001/metrics`

### Application Metrics

| Metric Name | Type | Description |
|-------------|------|-------------|
| `http_requests_total` | Counter | Total number of HTTP requests by method, route, and status |
| `http_request_duration_seconds` | Histogram | Duration of HTTP requests in seconds with buckets |

### Infrastructure Metrics

| Metric Name | Source | Description |
|-------------|--------|-------------|
| `process_cpu_seconds_total` | Node.js Process | Total CPU time consumed by the process |
| `process_resident_memory_bytes` | Node.js Process | Resident memory size in bytes |
| `process_heap_bytes` | Node.js Process | Process heap size in bytes |
| `nodejs_eventloop_lag_seconds` | Node.js Runtime | Event loop lag in seconds |
| `nodejs_active_handles_total` | Node.js Runtime | Number of active handles |
| `nodejs_active_requests_total` | Node.js Runtime | Number of active requests |

## Logging

### Log Format

Structured JSON logging format implemented with Winston:

```json
{
  "level": "info",
  "message": "HTTP request",
  "service": "api-gateway",
  "environment": "development",
  "method": "GET",
  "route": "/api/users",
  "status": 200,
  "duration": "0.025s",
  "timestamp": "2026-02-06T12:00:00.000Z"
}
```

### HIPAA Compliance

Logs are configured to NEVER include:
- User identifiers (names, emails, IDs)
- Passwords or authentication tokens
- Request/response bodies containing PHI
- Any Protected Health Information (PHI)

### Log Aggregation Strategy

In production, logs should be collected using:

1. **Fluentd/Fluent Bit** - Parse JSON logs and forward to Elasticsearch or CloudWatch
2. **Promtail** - Collect logs and send to Loki for long-term storage
3. **Filebeat** - Ship logs to Elasticsearch for full-text search

JSON format enables easy parsing and indexing without custom parsers.

## Alerting Rules

Define at least 3 alerting rules using Prometheus format:

### Alert 1: High Error Rate

```yaml
groups:
  - name: service_alerts
    rules:
      - alert: HighErrorRate
        expr: |
          (
            sum(rate(http_requests_total{status=~"5.."}[5m]))
            /
            sum(rate(http_requests_total[5m]))
          ) > 0.05
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "High error rate detected"
          description: "Error rate exceeds 5% over the last 5 minutes"
          runbook: |
            1. Check service logs for error patterns
            2. Verify downstream dependencies (Redis, user-service)
            3. Check resource utilization (CPU, memory)
            4. Review recent deployments
            5. Scale service if necessary
```

### Alert 2: High Request Latency

```yaml
      - alert: HighRequestLatency
        expr: |
          histogram_quantile(0.99,
            sum(rate(http_request_duration_seconds_bucket[5m])) by (le, service)
          ) > 1
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "High request latency detected"
          description: "P99 latency exceeds 1 second"
          runbook: |
            1. Identify affected routes from metrics labels
            2. Check for slow database queries
            3. Review Redis connection pool performance
            4. Check for resource contention
            5. Optimize slow operations
```

### Alert 3: Service Unavailability

```yaml
      - alert: ServiceDown
        expr: up{job=~"api-gateway|user-service"} == 0
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "Service is unavailable"
          description: "Service {{ $labels.job }} is down"
          runbook: |
            1. Verify service is running
            2. Check service logs for crash errors
            3. Verify network connectivity
            4. Check dependent services
            5. Restart service if necessary
```

### Alert 4: High Memory Usage

```yaml
      - alert: HighMemoryUsage
        expr: |
          (
            process_resident_memory_bytes
            /
            container_spec_memory_limit_bytes
          ) > 0.8
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "High memory usage detected"
          description: "Memory usage exceeds 80% of limit"
          runbook: |
            1. Check for memory leaks in logs
            2. Review recent code changes
            3. Analyze heap dumps
            4. Monitor garbage collection
            5. Increase memory allocation if needed
```

### Alert 5: Dependency Health Failures

```yaml
      - alert: DependencyHealthCheckFailed
        expr: rate(http_requests_total{route="/health/ready",status="503"}[5m]) > 0
        for: 3m
        labels:
          severity: warning
        annotations:
          summary: "Dependency health check failing"
          description: "Service dependencies are unhealthy"
          runbook: |
            1. Check Redis connection (user-service)
            2. Verify user-service availability (api-gateway)
            3. Review dependency service logs
            4. Check network connectivity
```

## Dashboards

Recommended Grafana dashboard panels:

1. **Service Health Overview**
   - Request rate by service (http_requests_total)
   - Error rate percentage by service
   - P50, P95, P99 latency graphs
   - Success vs error status codes

2. **Resource Utilization**
   - CPU usage (process_cpu_seconds_total)
   - Memory usage (process_resident_memory_bytes)
   - Event loop lag (nodejs_eventloop_lag_seconds)
   - Active handles and requests

3. **Dependency Health**
   - Redis connection status
   - Health check success rate
   - Inter-service communication latency

## Prometheus Configuration

Add to `prometheus.yml`:

```yaml
scrape_configs:
  - job_name: 'api-gateway'
    static_configs:
      - targets: ['localhost:3000']
    metrics_path: '/metrics'
    scrape_interval: 15s

  - job_name: 'user-service'
    static_configs:
      - targets: ['localhost:3001']
    metrics_path: '/metrics'
    scrape_interval: 15s
```

## Testing

Verify metrics endpoint:
```bash
curl http://localhost:3000/metrics
curl http://localhost:3001/metrics
```

Verify structured logging:
```bash
npm start | jq .
```

const express = require('express');
const axios = require('axios');
const promClient = require('prom-client');
const winston = require('winston');

const app = express();
const PORT = process.env.PORT || 3000;
const USER_SERVICE_URL = process.env.USER_SERVICE_URL || 'http://localhost:3001';

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.json(),
  defaultMeta: { service: 'api-gateway', environment: process.env.NODE_ENV || 'development' },
  transports: [
    new winston.transports.Console()
  ]
});

const register = new promClient.Registry();
promClient.collectDefaultMetrics({ register });

const httpRequestsTotal = new promClient.Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status'],
  registers: [register]
});

const httpRequestDuration = new promClient.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [register]
});

app.use(express.json());

app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = (Date.now() - start) / 1000;
    const route = req.route ? req.route.path : 'unmatched';
    const labels = { method: req.method, route, status: res.statusCode };

    httpRequestsTotal.inc(labels);
    httpRequestDuration.observe(labels, duration);

    logger.info('HTTP request', {
      method: req.method,
      route,
      status: res.statusCode,
      duration: `${duration.toFixed(3)}s`,
      timestamp: new Date().toISOString()
    });
  });
  next();
});

app.get('/metrics', async (req, res) => {
  res.setHeader('Content-Type', register.contentType);
  res.send(await register.metrics());
});

app.get('/health', (req, res) => {
  res.json({ status: 'healthy', service: 'api-gateway', timestamp: new Date().toISOString() });
});

app.get('/health/live', (req, res) => {
  res.json({ status: 'alive' });
});

app.get('/health/ready', async (req, res) => {
  try {
    await axios.get(`${USER_SERVICE_URL}/health`, { timeout: 2000 });
    res.json({ status: 'ready', dependencies: { userService: 'up' } });
  } catch (error) {
    res.status(503).json({
      status: 'not ready',
      dependencies: { userService: 'down' }
    });
  }
});

app.get('/api/users', async (req, res) => {
  try {
    const response = await axios.get(`${USER_SERVICE_URL}/users`);
    res.json(response.data);
  } catch (error) {
    logger.error('Failed to fetch users', { errorType: error.constructor.name });
    res.status(502).json({ error: 'Failed to fetch users from user-service' });
  }
});

app.get('/api/users/:id', async (req, res) => {
  try {
    const response = await axios.get(`${USER_SERVICE_URL}/users/${req.params.id}`);
    res.json(response.data);
  } catch (error) {
    if (error.response?.status === 404) {
      return res.status(404).json({ error: 'User not found' });
    }
    logger.error('Failed to fetch user', { errorType: error.constructor.name });
    res.status(502).json({ error: 'Failed to fetch user from user-service' });
  }
});

app.post('/api/users', async (req, res) => {
  try {
    const response = await axios.post(`${USER_SERVICE_URL}/users`, req.body);
    res.status(201).json(response.data);
  } catch (error) {
    logger.error('Failed to create user', { errorType: error.constructor.name });
    res.status(502).json({ error: 'Failed to create user' });
  }
});

app.delete('/api/users/:id', async (req, res) => {
  try {
    const response = await axios.delete(`${USER_SERVICE_URL}/users/${req.params.id}`);
    res.status(204).send();
  } catch (error) {
    if (error.response?.status === 404) {
      return res.status(404).json({ error: 'User not found' });
    }
    logger.error('Failed to delete user', { errorType: error.constructor.name });
    res.status(502).json({ error: 'Failed to delete user' });
  }
});

app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.use((err, req, res, next) => {
  logger.error('Unhandled error', { errorType: err.constructor.name });
  res.status(500).json({ error: 'Internal server error' });
});

const server = app.listen(PORT, () => {
  logger.info('API Gateway started', { port: PORT });
});

const SHUTDOWN_TIMEOUT_MS = 30000;

function handleGracefulShutdown(signal) {
  logger.info('Starting graceful shutdown', { signal });

  server.close((err) => {
    if (err) {
      logger.error('Error during server close', { errorType: err.constructor.name });
      process.exit(1);
    }
    logger.info('HTTP server closed successfully');
    process.exit(0);
  });

  setTimeout(() => {
    logger.error('Forced shutdown: timeout exceeded');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
}

process.on('SIGTERM', () => handleGracefulShutdown('SIGTERM'));
process.on('SIGINT', () => handleGracefulShutdown('SIGINT'));

module.exports = { app, server };

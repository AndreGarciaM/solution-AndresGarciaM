const express = require('express');
const Redis = require('ioredis');
const { v4: uuidv4 } = require('uuid');
const promClient = require('prom-client');
const winston = require('winston');

const app = express();
const PORT = process.env.PORT || 3001;

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.json(),
  defaultMeta: { service: 'user-service', environment: process.env.NODE_ENV || 'development' },
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

const redis = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
  maxRetriesPerRequest: 3,
  lazyConnect: true
});

redis.on('connect', () => logger.info('Connected to Redis'));
redis.on('error', (err) => logger.error('Redis error', { errorType: err.constructor.name }));

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
  res.json({ status: 'healthy', service: 'user-service', timestamp: new Date().toISOString() });
});

app.get('/health/live', (req, res) => {
  res.json({ status: 'alive' });
});

app.get('/health/ready', async (req, res) => {
  try {
    await redis.ping();
    res.json({ status: 'ready', dependencies: { redis: 'up' } });
  } catch (error) {
    res.status(503).json({
      status: 'not ready',
      dependencies: { redis: 'down' }
    });
  }
});

const USERS_KEY = 'users';

const initializeData = async () => {
  try {
    await redis.connect();
    const exists = await redis.exists(USERS_KEY);
    if (!exists) {
      const sampleUsers = [
        { id: uuidv4(), name: 'John Doe', email: 'john@example.com', role: 'admin', createdAt: new Date().toISOString() },
        { id: uuidv4(), name: 'Jane Smith', email: 'jane@example.com', role: 'user', createdAt: new Date().toISOString() },
        { id: uuidv4(), name: 'Bob Wilson', email: 'bob@example.com', role: 'user', createdAt: new Date().toISOString() }
      ];
      await redis.set(USERS_KEY, JSON.stringify(sampleUsers));
      logger.info('Sample data initialized');
    }
  } catch (error) {
    logger.warn('Could not initialize Redis data', { errorType: error.constructor.name });
  }
};

app.get('/users', async (req, res) => {
  try {
    const data = await redis.get(USERS_KEY);
    const users = data ? JSON.parse(data) : [];
    res.json({ data: users, total: users.length });
  } catch (error) {
    logger.error('Failed to get users', { errorType: error.constructor.name });
    res.status(500).json({ error: 'Failed to retrieve users' });
  }
});

app.get('/users/:id', async (req, res) => {
  try {
    const data = await redis.get(USERS_KEY);
    const users = data ? JSON.parse(data) : [];
    const user = users.find(u => u.id === req.params.id);

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json(user);
  } catch (error) {
    logger.error('Failed to get user', { errorType: error.constructor.name });
    res.status(500).json({ error: 'Failed to retrieve user' });
  }
});

app.post('/users', async (req, res) => {
  try {
    const { name, email, role } = req.body;

    if (!name || !email) {
      return res.status(400).json({ error: 'Name and email are required' });
    }

    const data = await redis.get(USERS_KEY);
    const users = data ? JSON.parse(data) : [];

    if (users.find(u => u.email === email)) {
      return res.status(409).json({ error: 'Email already exists' });
    }

    const newUser = {
      id: uuidv4(),
      name,
      email,
      role: role || 'user',
      createdAt: new Date().toISOString()
    };

    users.push(newUser);
    await redis.set(USERS_KEY, JSON.stringify(users));

    res.status(201).json(newUser);
  } catch (error) {
    logger.error('Failed to create user', { errorType: error.constructor.name });
    res.status(500).json({ error: 'Failed to create user' });
  }
});

app.delete('/users/:id', async (req, res) => {
  try {
    const data = await redis.get(USERS_KEY);
    const users = data ? JSON.parse(data) : [];
    const index = users.findIndex(u => u.id === req.params.id);

    if (index === -1) {
      return res.status(404).json({ error: 'User not found' });
    }

    users.splice(index, 1);
    await redis.set(USERS_KEY, JSON.stringify(users));

    res.status(204).send();
  } catch (error) {
    logger.error('Failed to delete user', { errorType: error.constructor.name });
    res.status(500).json({ error: 'Failed to delete user' });
  }
});

app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.use((err, req, res, next) => {
  logger.error('Unhandled error', { errorType: err.constructor.name });
  res.status(500).json({ error: 'Internal server error' });
});

let server;
const SHUTDOWN_TIMEOUT_MS = 30000;

async function handleGracefulShutdown(signal) {
  logger.info('Starting graceful shutdown', { signal });

  if (server) {
    server.close(async (err) => {
      if (err) {
        logger.error('Error during server close', { errorType: err.constructor.name });
      }
      logger.info('HTTP server closed');

      try {
        await redis.quit();
        logger.info('Redis connection closed');
      } catch (redisErr) {
        logger.error('Error closing Redis', { errorType: redisErr.constructor.name });
      }

      process.exit(err ? 1 : 0);
    });
  }

  setTimeout(() => {
    logger.error('Forced shutdown: timeout exceeded');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
}

process.on('SIGTERM', () => handleGracefulShutdown('SIGTERM'));
process.on('SIGINT', () => handleGracefulShutdown('SIGINT'));

const start = async () => {
  await initializeData();
  server = app.listen(PORT, () => {
    logger.info('User Service started', { port: PORT });
  });
  return server;
};

start();

module.exports = { app };

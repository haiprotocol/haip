# HAIP Server

[![npm version](https://badge.fury.io/js/%40haip%2Fserver.svg)](https://badge.fury.io/js/%40haip%2Fserver)
[![npm downloads](https://img.shields.io/npm/dm/@haip/server)](https://www.npmjs.com/package/@haip/server)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A reference implementation of the HAIP (Human-Agent Interaction Protocol) server with support for WebSocket, Server-Sent Events (SSE), and HTTP streaming transports.

## Features

- ✅ **Full HAI Protocol Support** - Complete implementation of HAIP 1.1.2
- ✅ **Multiple Transports** - WebSocket, SSE, and HTTP streaming
- ✅ **Authentication** - JWT-based authentication
- ✅ **Flow Control** - Credit-based flow control with back-pressure management
- ✅ **Tool Integration** - Model Context Protocol (MCP) tool support
- ✅ **Run Management** - Complete run lifecycle management
- ✅ **Binary Data** - Support for audio chunks and binary frames
- ✅ **Heartbeat** - Automatic ping/pong for connection health
- ✅ **Replay Support** - Message replay with sequence ranges
- ✅ **Error Handling** - Comprehensive error handling and recovery
- ✅ **Performance Monitoring** - Real-time server statistics

## Quick Start

### Installation

```bash
# Clone the repository
git clone https://github.com/haiprotocol/haip.git
cd haip/haip-server

# Install dependencies
npm install

# Build the server
npm run build

# Start the server
npm start
```

### Environment Variables

```bash
# Server configuration
PORT=8080
HOST=0.0.0.0

# Security
JWT_SECRET=your-secret-key-change-in-production
JWT_EXPIRES_IN=24h

# Performance
MAX_CONNECTIONS=1000
HEARTBEAT_INTERVAL=30000
HEARTBEAT_TIMEOUT=5000

# Features
ENABLE_CORS=true
ENABLE_COMPRESSION=true
ENABLE_LOGGING=true
```

### Development

```bash
# Start in development mode
npm run dev

# Run tests
npm test

# Run tests with coverage
npm run test:coverage

# Lint code
npm run lint

# Fix linting issues
npm run lint:fix
```

## API Endpoints

### WebSocket
```
ws://localhost:8080?token=your-jwt-token
```

### Server-Sent Events (SSE)
```
GET /haip/sse?token=your-jwt-token
```

### HTTP Streaming
```
POST /haip/stream
Authorization: Bearer your-jwt-token
```

### Health Check
```
GET /health
```

### Server Statistics
```
GET /stats
```

## Usage Examples

### WebSocket Connection

```javascript
import { createHAIPClient } from '@haip/sdk';

const client = createHAIPClient({
  url: 'ws://localhost:8080',
  token: 'your-jwt-token'
});

await client.connect();

// Send a text message
const messageId = await client.sendTextMessage('USER', 'Hello, HAIP!');

// Start a run
const runId = await client.startRun('thread-123', { metadata: 'test' });

// Call a tool
const callId = await client.callTool('AGENT', 'echo', { message: 'Hello' });
```

### Server-Sent Events

```javascript
const eventSource = new EventSource('/haip/sse?token=your-jwt-token');

eventSource.onmessage = (event) => {
  const message = JSON.parse(event.data);
  console.log('Received message:', message);
};

eventSource.onerror = (error) => {
  console.error('SSE error:', error);
};
```

### HTTP Streaming

```javascript
const response = await fetch('/haip/stream', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer your-jwt-token',
    'Content-Type': 'application/json'
  }
});

const reader = response.body.getReader();
const decoder = new TextDecoder();

while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  
  const chunk = decoder.decode(value);
  const messages = chunk.split('\n').filter(line => line.trim());
  
  for (const messageStr of messages) {
    const message = JSON.parse(messageStr);
    console.log('Received message:', message);
  }
}
```

## Tool Integration

### Registering Tools

```javascript
import { HAIPServer } from 'haip-server';

const server = new HAIPServer();

// Register a simple echo tool
server.registerTool({
  name: 'echo',
  description: 'Echo back the input',
  inputSchema: {
    type: 'object',
    properties: {
      message: { type: 'string' }
    },
    required: ['message']
  },
  outputSchema: {
    type: 'object',
    properties: {
      echoed: { type: 'string' }
    }
  }
});

// Register a math tool
server.registerTool({
  name: 'add',
  description: 'Add two numbers',
  inputSchema: {
    type: 'object',
    properties: {
      a: { type: 'number' },
      b: { type: 'number' }
    },
    required: ['a', 'b']
  },
  outputSchema: {
    type: 'object',
    properties: {
      result: { type: 'number' }
    }
  }
});
```

### Custom Tool Implementation

```javascript
// Handle tool calls
server.on('toolCall', (sessionId, execution) => {
  console.log(`Tool call: ${execution.toolName}`, execution.arguments);
  
  // Implement your tool logic here
  if (execution.toolName === 'echo') {
    const result = { echoed: execution.arguments.message };
    server.sendToolDone(sessionId, execution.callId, 'OK', result);
  } else if (execution.toolName === 'add') {
    const result = { result: execution.arguments.a + execution.arguments.b };
    server.sendToolDone(sessionId, execution.callId, 'OK', result);
  }
});
```

## Flow Control

The server implements credit-based flow control to prevent overwhelming the system:

```javascript
// Flow control configuration
const flowControl = {
  enabled: true,
  initialCredits: 1000,
  minCredits: 100,
  maxCredits: 10000,
  creditThreshold: 200,
  backPressureThreshold: 0.8,
  adaptiveAdjustment: true,
  initialCreditMessages: 1000,
  initialCreditBytes: 1024 * 1024
};

const server = new HAIPServer({
  flowControl
});
```

## Error Handling

The server provides comprehensive error handling:

```javascript
// Handle server events
server.on('error', (error) => {
  console.error('Server error:', error);
});

server.on('connect', (sessionId) => {
  console.log('Client connected:', sessionId);
});

server.on('disconnect', (sessionId) => {
  console.log('Client disconnected:', sessionId);
});

server.on('handshake', (sessionId, payload) => {
  console.log('Handshake completed:', sessionId, payload);
});
```

## Performance Monitoring

Monitor server performance with built-in statistics:

```javascript
// Get server statistics
const stats = server.getStats();
console.log('Server stats:', {
  activeConnections: stats.activeConnections,
  totalConnections: stats.totalConnections,
  messagesPerSecond: stats.messagesPerSecond,
  averageLatency: stats.averageLatency,
  errorRate: stats.errorRate,
  uptime: stats.uptime
});
```

## Security

### JWT Authentication

The server uses JWT tokens for authentication:

```javascript
// Generate a JWT token (client-side)
const jwt = require('jsonwebtoken');

const token = jwt.sign(
  { userId: 'user-123', exp: Math.floor(Date.now() / 1000) + (24 * 60 * 60) },
  'your-secret-key'
);
```

### CORS Configuration

Enable CORS for browser clients:

```javascript
const server = new HAIPServer({
  enableCORS: true
});
```

## Testing

### Unit Tests

```bash
npm test
```

### Integration Tests

```bash
npm run test:integration
```

### Load Testing

```bash
npm run test:load
```

## Deployment

### Docker

```dockerfile
FROM node:18-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY dist ./dist

EXPOSE 8080

CMD ["node", "dist/index.js"]
```

### Docker Compose

```yaml
version: '3.8'
services:
  haip-server:
    build: .
    ports:
      - "8080:8080"
    environment:
      - JWT_SECRET=your-secret-key
      - PORT=8080
    restart: unless-stopped
```

### Kubernetes

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: haip-server
spec:
  replicas: 3
  selector:
    matchLabels:
      app: haip-server
  template:
    metadata:
      labels:
        app: haip-server
    spec:
      containers:
      - name: haip-server
        image: haip-protocol/haip-server:latest
        ports:
        - containerPort: 8080
        env:
        - name: JWT_SECRET
          valueFrom:
            secretKeyRef:
              name: haip-secrets
              key: jwt-secret
        - name: PORT
          value: "8080"
---
apiVersion: v1
kind: Service
metadata:
  name: haip-server
spec:
  selector:
    app: haip-server
  ports:
  - port: 8080
    targetPort: 8080
  type: LoadBalancer
```



## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests for new functionality
5. Run the test suite
6. Submit a pull request

## License

MIT License - see LICENSE file for details.

## Protocol Version

This SDK implements HAIP version 1.1.2. For protocol documentation, see the [HAI Protocol Specification](https://github.com/haiprotocol/specification). 

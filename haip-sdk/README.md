# HAIP TypeScript SDK

A complete TypeScript SDK for the Human-Agent Interaction Protocol (HAIP) version 1.1.2.

## Features

- **Full Protocol Support**: Complete implementation of all HAIP 1.1.2 features
- **Multiple Transport Types**: WebSocket, Server-Sent Events (SSE), and HTTP streaming
- **Run Lifecycle Management**: Start, finish, cancel, and track runs with metadata
- **Advanced Flow Control**: Credit-based flow control with back-pressure management
- **Tool Integration**: Complete tool lifecycle with MCP (Model Context Protocol) support
- **Replay & Sequencing**: Message replay, acknowledgment, and sequence management
- **Binary Data Support**: Audio, video, and file data transmission
- **Heartbeat & Health Monitoring**: Automatic ping/pong with latency tracking
- **Error Handling**: Comprehensive error handling with recovery strategies
- **TypeScript First**: Full type safety with comprehensive TypeScript definitions
- **Event-Driven Architecture**: Event emitter pattern with custom event handlers
- **Performance Metrics**: Built-in performance monitoring and metrics
- **Reconnection Logic**: Automatic reconnection with exponential backoff

## Installation

```bash
npm install @haip/sdk
```

## Quick Start

```typescript
import { createHAIPClient, HAIPEventHandlers } from "@haip/sdk";

// Create client configuration
const config = {
  url: "ws://localhost:8080",
  token: "your-jwt-token",
  sessionId: "optional-session-id"
};

// Set up event handlers
const handlers: HAIPEventHandlers = {
  onConnect: () => console.log("Connected!"),
  onDisconnect: (reason) => console.log("Disconnected:", reason),
  onTextMessage: (payload) => console.log("Message:", payload),
  onToolCall: (payload) => console.log("Tool call:", payload),
  onError: (error) => console.error("Error:", error)
};

// Create and connect client
const client = createHAIPClient(config);
client.setHandlers(handlers);

await client.connect();

// Start a run
const runId = await client.startRun("thread-123", { user: "alice" });

// Send a text message
const messageId = await client.sendTextMessage("USER", "Hello, agent!", "user", runId);

// Call a tool
const callId = await client.callTool("AGENT", "calculator", { expression: "2+2" }, runId);

// Finish the run
await client.finishRun(runId, "OK", "Conversation completed");
```

## API Reference

### Client Configuration

```typescript
interface HAIPConnectionConfig {
  url: string;                    // Server URL
  token: string;                  // JWT authentication token
  sessionId?: string;             // Optional session ID
  reconnectAttempts?: number;     // Max reconnection attempts (default: 3)
  reconnectDelay?: number;        // Base reconnection delay (default: 1000ms)
  heartbeatInterval?: number;     // Heartbeat interval (default: 30000ms)
  heartbeatTimeout?: number;      // Heartbeat timeout (default: 10000ms)
  flowControl?: FlowControlConfig; // Flow control settings
  maxConcurrentRuns?: number;     // Max concurrent runs (default: 5)
  replayWindowSize?: number;      // Replay window size (default: 1000)
  replayWindowTime?: number;      // Replay window time (default: 300000ms)
}
```

### Run Lifecycle

```typescript
// Start a new run
const runId = await client.startRun(threadId?, metadata?);

// Finish a run
await client.finishRun(runId, status?, summary?);

// Cancel a run
await client.cancelRun(runId);

// Get run information
const run = client.getRun(runId);
const activeRuns = client.getActiveRuns();
```

### Messaging

```typescript
// Send text message (automatically chunked)
const messageId = await client.sendTextMessage(
  channel,    // "USER" | "AGENT" | "SYSTEM" | "AUDIO_IN" | "AUDIO_OUT"
  text,       // Message content
  author?,    // Optional author
  runId?,     // Optional run ID
  threadId?   // Optional thread ID
);

// Send audio chunk
await client.sendAudioChunk(
  channel,      // Channel
  messageId,    // Message ID
  mime,         // MIME type
  data,         // ArrayBuffer
  durationMs?,  // Duration in milliseconds
  runId?,       // Optional run ID
  threadId?     // Optional thread ID
);
```

### Tool Integration

```typescript
// Call a tool
const callId = await client.callTool(
  channel,    // Channel
  tool,       // Tool name
  params?,    // Tool parameters
  runId?,     // Optional run ID
  threadId?   // Optional thread ID
);

// Update tool status
await client.updateTool(
  channel,    // Channel
  callId,     // Call ID
  status,     // "QUEUED" | "RUNNING" | "CANCELLING"
  progress?,  // Progress percentage
  partial?,   // Partial result
  runId?,     // Optional run ID
  threadId?   // Optional thread ID
);

// Complete tool execution
await client.completeTool(
  channel,    // Channel
  callId,     // Call ID
  status?,    // "OK" | "CANCELLED" | "ERROR"
  result?,    // Tool result
  runId?,     // Optional run ID
  threadId?   // Optional thread ID
);

// Cancel tool execution
await client.cancelTool(
  channel,    // Channel
  callId,     // Call ID
  reason?,    // Cancellation reason
  runId?,     // Optional run ID
  threadId?   // Optional thread ID
);

// List available tools
await client.listTools(channel, tools);

// Send tool schema
await client.sendToolSchema(channel, tool, schema);
```

### Flow Control

```typescript
// Pause a channel
await client.pauseChannel(channel);

// Resume a channel
await client.resumeChannel(channel);

// Send flow update
await client.sendFlowUpdate(channel, addMessages?, addBytes?);

// Get connection state
const state = client.getConnectionState();
console.log("Credits:", state.credits);
console.log("Paused channels:", state.pausedChannels);
```

### Replay & Sequencing

```typescript
// Request message replay
await client.requestReplay(fromSeq, toSeq?);

// Get performance metrics
const metrics = client.getPerformanceMetrics();
console.log("Messages sent:", metrics.messagesSent);
console.log("Average latency:", metrics.averageLatency);
console.log("Replay requests:", metrics.replayRequests);
```

### Event Handling

```typescript
// Set event handlers
client.setHandlers({
  onConnect: () => console.log("Connected"),
  onDisconnect: (reason) => console.log("Disconnected:", reason),
  onHandshake: (payload) => console.log("Handshake:", payload),
  onRunStarted: (payload) => console.log("Run started:", payload),
  onRunFinished: (payload) => console.log("Run finished:", payload),
  onTextMessage: (payload) => console.log("Text message:", payload),
  onAudioChunk: (payload, binaryData) => console.log("Audio chunk:", payload),
  onToolCall: (payload) => console.log("Tool call:", payload),
  onToolUpdate: (payload) => console.log("Tool update:", payload),
  onToolDone: (payload) => console.log("Tool done:", payload),
  onFlowUpdate: (payload) => console.log("Flow update:", payload),
  onError: (payload) => console.error("Error:", payload),
  onHeartbeat: (latency) => console.log("Heartbeat latency:", latency)
});

// Use event emitter pattern
client.on("connect", () => console.log("Connected"));
client.on("message", (message) => console.log("Message:", message));
client.on("error", (error) => console.error("Error:", error));
```

### Transport Types

The SDK supports three transport types:

#### WebSocket (Default)
```typescript
const config = {
  url: "ws://localhost:8080",
  token: "your-token"
};
```

#### Server-Sent Events (SSE)
```typescript
const config = {
  url: "http://localhost:8080/sse",
  token: "your-token"
};
// SSE transport is automatically selected for HTTP URLs
```

#### HTTP Streaming
```typescript
const config = {
  url: "http://localhost:8080/stream",
  token: "your-token"
};
// HTTP streaming transport is automatically selected
```

### Error Handling

```typescript
// Handle connection errors
client.on("error", (error) => {
  console.error("Connection error:", error);
});

// Handle protocol errors
client.setHandlers({
  onError: (payload) => {
    console.error("Protocol error:", payload.code, payload.message);
    if (payload.code === "AUTHENTICATION_FAILED") {
      // Handle authentication error
    } else if (payload.code === "RATE_LIMITED") {
      // Handle rate limiting
    }
  }
});
```

### Binary Data Support

```typescript
// Send binary data
const audioData = new ArrayBuffer(1024);
await client.sendBinary(audioData);

// Handle incoming binary data
client.on("audioChunk", (payload, binaryData) => {
  if (binaryData) {
    // Process binary audio data
    console.log("Received audio data:", binaryData.byteLength, "bytes");
  }
});
```

## Advanced Usage

### Custom Transport

```typescript
import { HAIPTransport, HAIPTransportConfig } from "@haip/sdk";

class CustomTransport implements HAIPTransport {
  // Implement transport interface
}

const config = {
  type: "custom" as any,
  url: "custom://localhost:8080",
  token: "your-token"
};
```

### Flow Control Configuration

```typescript
const config = {
  url: "ws://localhost:8080",
  token: "your-token",
  flowControl: {
    enabled: true,
    initialCredits: 10,
    minCredits: 1,
    maxCredits: 100,
    creditThreshold: 5,
    backPressureThreshold: 0.8,
    adaptiveAdjustment: true,
    initialCreditMessages: 10,
    initialCreditBytes: 1024 * 1024
  }
};
```

### Performance Monitoring

```typescript
// Get real-time metrics
setInterval(() => {
  const metrics = client.getPerformanceMetrics();
  const state = client.getConnectionState();
  
  console.log("Performance:", {
    messagesSent: metrics.messagesSent,
    messagesReceived: metrics.messagesReceived,
    averageLatency: metrics.averageLatency,
    backPressureEvents: metrics.backPressureEvents,
    activeRuns: state.activeRuns.size,
    credits: Object.fromEntries(state.credits)
  });
}, 5000);
```

## Testing

```bash
# Run all tests
npm test

# Run tests in watch mode
npm run test:watch

# Run tests with coverage
npm run test:coverage
```

## Building

```bash
# Build the SDK
npm run build

# Development build with watch
npm run dev
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

This SDK implements HAIP version 1.1.2. For protocol documentation, see the [HAIP Specification](https://github.com/haiprotocol/specification). 
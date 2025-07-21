# HAIP CLI

[![npm version](https://badge.fury.io/js/%40haip%2Fcli.svg)](https://badge.fury.io/js/%40haip%2Fcli)
[![npm downloads](https://img.shields.io/npm/dm/@haip/cli)](https://www.npmjs.com/package/@haip/cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A command-line interface for the Human-Agent Interaction Protocol (HAIP), providing tools for testing, monitoring, and interacting with HAIP servers.

## Features

- **Multiple Transport Support** - WebSocket, SSE, and HTTP streaming
- **Real-time Monitoring** - Monitor server events with filtering and formatting
- **Performance Testing** - Test server connectivity and performance
- **Health Checks** - Check server health and status
- **Message Sending** - Send text messages, tool calls, and run commands
- **Interactive Mode** - Connect and interact with servers in real-time
- **Comprehensive Logging** - Verbose output and detailed error reporting

## Installation

### From Source

```bash
# Clone the repository
git clone https://github.com/haiprotocol/haip-cli.git
cd haip-cli

# Install dependencies
npm install

# Build the project
npm run build

# Link globally (optional)
npm link
```

### From NPM

```bash
npm install -g @haip/cli
```

## Quick Start

### 1. Check Server Health

```bash
haip health
```

### 2. Connect to a Server

```bash
haip connect ws://localhost:8080
```

### 3. Send a Message

```bash
haip send text "Hello, HAIP!"
```

### 4. Monitor Events

```bash
haip monitor --follow
```

### 5. Test Performance

```bash
haip test --message-count 100
```

## Commands

### `haip connect <url>`

Connect to a HAIP server and maintain an interactive connection.

**Options:**
- `-t, --transport <type>` - Transport type (websocket, sse, http-streaming)
- `--token <token>` - JWT authentication token
- `--timeout <ms>` - Connection timeout in milliseconds
- `--reconnect-attempts <count>` - Maximum reconnection attempts
- `--reconnect-delay <ms>` - Base reconnection delay in milliseconds
- `-v, --verbose` - Enable verbose output

**Examples:**
```bash
# Connect via WebSocket
haip connect ws://localhost:8080

# Connect via SSE with authentication
haip connect http://localhost:8080 --transport sse --token your-jwt-token

# Connect with custom options
haip connect ws://localhost:8080 --timeout 5000 --reconnect-attempts 5
```

### `haip send`

Send messages to a HAIP server.

#### `haip send text <message>`

Send a text message.

**Options:**
- `-u, --url <url>` - Server URL
- `-t, --transport <type>` - Transport type
- `--token <token>` - JWT authentication token
- `-c, --channel <channel>` - Message channel (USER, AGENT, SYSTEM)
- `--author <author>` - Message author
- `--run-id <id>` - Run ID
- `--thread-id <id>` - Thread ID
- `-v, --verbose` - Enable verbose output

**Examples:**
```bash
# Send a simple message
haip send text "Hello, world!"

# Send with specific channel and author
haip send text "Hello" --channel AGENT --author bot

# Send within a run context
haip send text "Hello" --run-id run-123 --thread-id thread-456
```

#### `haip send tool <tool> [params...]`

Call a tool with parameters.

**Options:**
- `-u, --url <url>` - Server URL
- `-t, --transport <type>` - Transport type
- `--token <token>` - JWT authentication token
- `-c, --channel <channel>` - Message channel
- `--run-id <id>` - Run ID
- `--thread-id <id>` - Thread ID
- `-v, --verbose` - Enable verbose output

**Examples:**
```bash
# Call echo tool
haip send tool echo message="Hello World"

# Call calculator tool
haip send tool calculator expression="2+2"

# Call with multiple parameters
haip send tool weather location="London" units="celsius"
```

#### `haip send run`

Start a new run.

**Options:**
- `-u, --url <url>` - Server URL
- `-t, --transport <type>` - Transport type
- `--token <token>` - JWT authentication token
- `--thread-id <id>` - Thread ID
- `--metadata <json>` - Run metadata (JSON string)
- `-v, --verbose` - Enable verbose output

**Examples:**
```bash
# Start a simple run
haip send run

# Start with thread ID
haip send run --thread-id my-thread

# Start with metadata
haip send run --metadata '{"user":"alice","session":"chat-1"}'
```

### `haip monitor`

Monitor HAIP server events in real-time.

**Options:**
- `-u, --url <url>` - Server URL
- `-t, --transport <type>` - Transport type
- `--token <token>` - JWT authentication token
- `--show-timestamps` - Show message timestamps
- `--show-metadata` - Show message metadata
- `--filter-types <types>` - Filter by message types (comma-separated)
- `--filter-channels <channels>` - Filter by channels (comma-separated)
- `--max-lines <count>` - Maximum lines to display
- `--follow` - Follow new messages
- `-v, --verbose` - Enable verbose output

**Examples:**
```bash
# Basic monitoring
haip monitor

# Monitor with filtering
haip monitor --filter-types TEXT_MESSAGE_START,TOOL_CALL

# Monitor specific channels
haip monitor --filter-channels USER,AGENT

# Follow mode with metadata
haip monitor --follow --show-metadata
```

### `haip test`

Test HAIP server connectivity and performance.

**Options:**
- `-u, --url <url>` - Server URL
- `-t, --transport <type>` - Transport type
- `--token <token>` - JWT authentication token
- `--message-count <count>` - Number of test messages to send
- `--message-size <bytes>` - Size of test messages in bytes
- `--delay <ms>` - Delay between messages in milliseconds
- `--timeout <ms>` - Test timeout in milliseconds
- `--validate-responses` - Validate server responses
- `-v, --verbose` - Enable verbose output

**Examples:**
```bash
# Basic performance test
haip test

# High-load test
haip test --message-count 1000 --delay 10

# Large message test
haip test --message-size 8192 --message-count 100

# Validate responses
haip test --validate-responses
```

### `haip health`

Check HAIP server health status.

**Options:**
- `-u, --url <url>` - Server URL
- `--timeout <ms>` - Request timeout in milliseconds
- `--format <format>` - Output format (text, json)

**Examples:**
```bash
# Check health
haip health

# JSON output
haip health --format json

# Custom server
haip health --url http://my-server:8080
```

### `haip version`

Show version information.

### `haip info`

Show system information.

### `haip examples`

Show usage examples.

## Configuration

The HAIP CLI can be configured using environment variables:

```bash
# Server configuration
HAIP_DEFAULT_URL=ws://localhost:8080
HAIP_DEFAULT_TRANSPORT=websocket
HAIP_DEFAULT_TOKEN=your-jwt-token

# Connection settings
HAIP_TIMEOUT=10000
HAIP_RECONNECT_ATTEMPTS=3
HAIP_RECONNECT_DELAY=1000

# Output settings
HAIP_VERBOSE=false
HAIP_COLOR=true
```

## Development

### Prerequisites

- Node.js 20.0.0 or higher
- npm 9.0.0 or higher

### Setup

```bash
# Clone the repository
git clone https://github.com/haiprotocol/haip-cli.git
cd haip-cli

# Install dependencies
npm install

# Build the project
npm run build

# Run tests
npm test

# Run with coverage
npm run test:coverage

# Lint code
npm run lint

# Fix linting issues
npm run lint:fix
```

### Development Mode

```bash
# Start in development mode
npm run dev

# Link for global testing
npm link
```

## Testing

The CLI includes comprehensive tests:

```bash
# Run all tests
npm test

# Run with coverage
npm run test:coverage

# Run specific test suites
npm run test:unit
npm run test:integration
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
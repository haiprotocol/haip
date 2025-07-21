import { HAIPServer } from './server';
import { HAIPServerUtils } from './utils';

// Create server with test configuration
const server = new HAIPServer({
  port: 8080,
  host: '0.0.0.0',
  jwtSecret: 'test-secret-key',
  enableCORS: true,
  enableLogging: true,
  flowControl: {
    enabled: true,
    initialCredits: 1000,
    minCredits: 100,
    maxCredits: 10000,
    creditThreshold: 200,
    backPressureThreshold: 0.8,
    adaptiveAdjustment: true
  }
});

// Register test tools
server.registerTool({
  name: 'echo',
  description: 'Echo back the input message',
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
      echoed: { type: 'string' },
      timestamp: { type: 'string' }
    }
  }
});

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

server.registerTool({
  name: 'weather',
  description: 'Get weather information (mock)',
  inputSchema: {
    type: 'object',
    properties: {
      location: { type: 'string' }
    },
    required: ['location']
  },
  outputSchema: {
    type: 'object',
    properties: {
      location: { type: 'string' },
      temperature: { type: 'number' },
      condition: { type: 'string' }
    }
  }
});

// Handle server events
server.on('started', () => {
  console.log('🚀 HAIP Test Server started on port 8080');
  console.log('📡 WebSocket: ws://localhost:8080?token=test-token');
  console.log('📡 SSE: http://localhost:8080/haip/sse?token=test-token');
  console.log('📡 HTTP Stream: POST http://localhost:8080/haip/stream');
  console.log('📊 Stats: http://localhost:8080/stats');
  console.log('❤️  Health: http://localhost:8080/health');
});

server.on('connect', (sessionId) => {
  console.log(`🔗 Client connected: ${sessionId}`);
});

server.on('disconnect', (sessionId) => {
  console.log(`🔌 Client disconnected: ${sessionId}`);
});

server.on('handshake', (sessionId, payload) => {
  console.log(`🤝 Handshake completed: ${sessionId}`, payload);
});

server.on('textMessage', (sessionId, message) => {
  console.log(`💬 Text message from ${sessionId}:`, message.payload);
  
  // Echo back the message
  const echoMessage = HAIPServerUtils.createTextMessageStart(
    sessionId,
    {
      message_id: HAIPServerUtils.generateUUID(),
      author: 'server',
      text: `Echo: ${message.payload.text || ''}`
    }
  );
  server.sendMessage(sessionId, echoMessage);
});

server.on('toolCall', (sessionId, execution) => {
  console.log(`🔧 Tool call: ${execution.toolName}`, execution.arguments);
  
  // Simulate tool execution
  setTimeout(() => {
    let result: any;
    
    switch (execution.toolName) {
      case 'echo':
        result = {
          echoed: execution.arguments.message,
          timestamp: new Date().toISOString()
        };
        break;
        
      case 'add':
        result = {
          result: execution.arguments.a + execution.arguments.b
        };
        break;
        
      case 'weather':
        result = {
          location: execution.arguments.location,
          temperature: Math.floor(Math.random() * 30) + 10,
          condition: ['sunny', 'cloudy', 'rainy', 'snowy'][Math.floor(Math.random() * 4)]
        };
        break;
        
      default:
        result = { error: 'Unknown tool' };
    }
    
    server.sendToolDone(sessionId, execution.callId, 'OK', result);
  }, 500);
});

server.on('error', (error) => {
  console.error('❌ Server error:', error);
});

// Start the server
server.start();

// Generate a test JWT token
function generateTestToken(): string {
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = {
    userId: 'test-user',
    exp: Math.floor(Date.now() / 1000) + (24 * 60 * 60), // 24 hours
    iat: Math.floor(Date.now() / 1000)
  };
  
  const base64Encode = (obj: any) => {
    return Buffer.from(JSON.stringify(obj)).toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '');
  };
  
  const encodedHeader = base64Encode(header);
  const encodedPayload = base64Encode(payload);
  
  // Simple signature (not cryptographically secure for testing)
  const signature = Buffer.from('test-secret-key').toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
  
  return `${encodedHeader}.${encodedPayload}.${signature}`;
}

// Print test token
console.log('\n🔑 Test JWT Token:');
console.log(generateTestToken());
console.log('\n📝 Usage Examples:');
console.log('WebSocket: ws://localhost:8080?token=test-token');
console.log('SSE: curl "http://localhost:8080/haip/sse?token=test-token"');
console.log('HTTP Stream: curl -X POST http://localhost:8080/haip/stream -H "Authorization: Bearer test-token"');

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down HAIP Test Server...');
  server.stop();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n🛑 Shutting down HAIP Test Server...');
  server.stop();
  process.exit(0);
}); 
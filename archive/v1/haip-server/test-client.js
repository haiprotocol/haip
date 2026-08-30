const WebSocket = require('ws');

// Simple JWT token for testing (not cryptographically secure)
function generateTestToken() {
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = {
    userId: 'test-user',
    exp: Math.floor(Date.now() / 1000) + (24 * 60 * 60),
    iat: Math.floor(Date.now() / 1000)
  };
  
  const base64Encode = (obj) => {
    return Buffer.from(JSON.stringify(obj)).toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '');
  };
  
  const encodedHeader = base64Encode(header);
  const encodedPayload = base64Encode(payload);
  const signature = Buffer.from('test-secret-key').toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
  
  return `${encodedHeader}.${encodedPayload}.${signature}`;
}

const token = generateTestToken();
const serverUrl = process.env.HAIP_SERVER_URL || 'ws://localhost:8080';
const ws = new WebSocket(`${serverUrl}?token=${token}`);

console.log('🔗 Connecting to HAIP Server...');
console.log(`📡 URL: ${serverUrl}?token=${token}`);

ws.on('open', () => {
  console.log('✅ Connected to HAIP Server');
  
  // Send a text message
  setTimeout(() => {
    const textMessage = {
      id: 'msg-1',
      session: 'test-session',
      seq: Date.now().toString(),
      ts: Date.now().toString(),
      channel: 'USER',
      type: 'MESSAGE_START',
      payload: {
        message_id: 'msg-1',
        author: 'test-client',
        text: 'Hello, HAIP Server!'
      }
    };
    
    console.log('💬 Sending text message:', textMessage);
    ws.send(JSON.stringify(textMessage));
  }, 1000);
  
  // Call a tool
  setTimeout(() => {
    const toolCall = {
      id: 'tool-1',
      session: 'test-session',
      seq: (Date.now() + 1).toString(),
      ts: Date.now().toString(),
      channel: 'AGENT',
      type: 'TOOL_CALL',
      payload: {
        call_id: 'call-1',
        tool: 'echo',
        params: {
          message: 'Hello from tool call!'
        }
      }
    };
    
    console.log('🔧 Calling tool:', toolCall);
    ws.send(JSON.stringify(toolCall));
  }, 2000);
  
  // Call another tool
  setTimeout(() => {
    const addToolCall = {
      id: 'tool-2',
      session: 'test-session',
      seq: (Date.now() + 2).toString(),
      ts: Date.now().toString(),
      channel: 'AGENT',
      type: 'TOOL_CALL',
      payload: {
        call_id: 'call-2',
        tool: 'add',
        params: {
          a: 5,
          b: 3
        }
      }
    };
    
    console.log('🔧 Calling add tool:', addToolCall);
    ws.send(JSON.stringify(addToolCall));
  }, 3000);
  
  // Send ping
  setTimeout(() => {
    const ping = {
      id: 'ping-1',
      session: 'test-session',
      seq: (Date.now() + 3).toString(),
      ts: Date.now().toString(),
      channel: 'SYSTEM',
      type: 'PING',
      payload: {
        nonce: 'test-nonce'
      }
    };
    
    console.log('🏓 Sending ping:', ping);
    ws.send(JSON.stringify(ping));
  }, 4000);
});

ws.on('message', (data) => {
  try {
    const message = JSON.parse(data.toString());
    console.log('📨 Received message:', message);
    
    // Handle different message types
    switch (message.type) {
      case 'HAI':
        console.log('🤝 Handshake received');
        break;
      case 'PONG':
        console.log('🏓 Pong received');
        break;
      case 'TOOL_DONE':
        console.log('✅ Tool execution completed:', message.payload);
        break;
      case 'MESSAGE_START':
        console.log('💬 Text message received:', message.payload);
        break;
      case 'ERROR':
        console.error('❌ Error received:', message.payload);
        break;
      default:
        console.log('📨 Other message type:', message.type);
    }
  } catch (error) {
    console.error('❌ Error parsing message:', error);
  }
});

ws.on('error', (error) => {
  console.error('❌ WebSocket error:', error);
});

ws.on('close', (code, reason) => {
  console.log(`🔌 Connection closed: ${code} - ${reason}`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down test client...');
  ws.close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n🛑 Shutting down test client...');
  ws.close();
  process.exit(0);
}); 
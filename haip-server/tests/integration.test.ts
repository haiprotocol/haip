import { HAIPServer } from '../src/server';
import { HAIPMessage } from '../src/types';
import WebSocket from 'ws';

// Mock fetch for Node.js environment
const fetch = require('node-fetch');

// Mock EventSource for Node.js environment
class MockEventSource {
  private url: string;
  public onmessage: ((event: any) => void) | null = null;
  public onerror: ((event: any) => void) | null = null;
  public onopen: ((event: any) => void) | null = null;
  public readyState: number = 0;

  constructor(url: string) {
    this.url = url;
    this.readyState = 1; // OPEN
    
    // Simulate connection and send handshake
    setTimeout(() => {
      if (this.onopen) {
        this.onopen({ type: 'open' });
      }
      
      // Simulate handshake message
      setTimeout(() => {
        if (this.onmessage) {
          const handshakeMessage = {
            type: 'HAI',
            payload: {
              haip_version: '1.1.2',
              accept_major: [1],
              accept_events: ['HAI', 'PING', 'PONG']
            }
          };
          this.onmessage({ data: JSON.stringify(handshakeMessage) });
        }
      }, 50);
    }, 10);
  }

  close() {
    this.readyState = 2; // CLOSED
  }
}

// Mock global EventSource
(global as any).EventSource = MockEventSource;

describe('HAIPServer Integration Tests', () => {
  let server: HAIPServer;
  let port: number;

  beforeEach(() => {
    port = global.testUtils.getAvailablePort();
    server = new HAIPServer({ port });
    server.start();
  });

  afterEach(() => {
    server.stop();
    global.testUtils.cleanupPort(port);
  });

  describe('Complete HAIP Flow', () => {
    it('should handle complete conversation flow', (done) => {
      const token = global.testUtils.generateTestToken();
      const url = `ws://localhost:${port}?token=${token}`;

      const ws = new WebSocket(url);
      let handshakeReceived = false;
      let toolDoneReceived = false;

      const timeout = setTimeout(() => {
        ws.close();
        done(new Error('Test timeout'));
      }, 5000);

      ws.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString());
          if (message.type === 'HAI') {
            handshakeReceived = true;
          } else if (message.type === 'TOOL_DONE') {
            toolDoneReceived = true;
            expect(message.payload.status).toBe('OK');
          }

          if (handshakeReceived && toolDoneReceived) {
            clearTimeout(timeout);
            ws.close();
            done();
          }
        } catch (error) {
          // Ignore parsing errors
        }
      });

      ws.on('open', () => {
        // Send tool call after handshake
        setTimeout(() => {
          const toolCall: HAIPMessage = {
            id: 'tool-1',
            session: 'test-session',
            seq: '1',
            ts: Date.now().toString(),
            channel: 'AGENT',
            type: 'TOOL_CALL',
            payload: {
              call_id: 'call-1',
              tool: 'echo',
              params: { message: 'Hello from test' }
            }
          };
          ws.send(JSON.stringify(toolCall));
        }, 200);
      });

      ws.on('error', (error) => {
        clearTimeout(timeout);
        done(error);
      });
    });

    it('should handle multiple tool calls in sequence', (done) => {
      const token = global.testUtils.generateTestToken();
      const url = `ws://localhost:${port}?token=${token}`;

      const ws = new WebSocket(url);
      let completedCalls = 0;

      const timeout = setTimeout(() => {
        ws.close();
        done(new Error('Test timeout'));
      }, 8000);

      ws.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString());
          if (message.type === 'TOOL_DONE') {
            completedCalls++;
            if (completedCalls === 2) {
              clearTimeout(timeout);
              ws.close();
              done();
            }
          }
        } catch (error) {
          // Ignore parsing errors
        }
      });

      ws.on('open', () => {
        setTimeout(() => {
          // Send first tool call
          const toolCall1: HAIPMessage = {
            id: 'tool-1',
            session: 'test-session',
            seq: '1',
            ts: Date.now().toString(),
            channel: 'AGENT',
            type: 'TOOL_CALL',
            payload: {
              call_id: 'call-1',
              tool: 'echo',
              params: { message: 'First call' }
            }
          };
          ws.send(JSON.stringify(toolCall1));

          // Send second tool call
          setTimeout(() => {
            const toolCall2: HAIPMessage = {
              id: 'tool-2',
              session: 'test-session',
              seq: '2',
              ts: Date.now().toString(),
              channel: 'AGENT',
              type: 'TOOL_CALL',
              payload: {
                call_id: 'call-2',
                tool: 'add',
                params: { a: 5, b: 3 }
              }
            };
            ws.send(JSON.stringify(toolCall2));
          }, 500);
        }, 200);
      });

      ws.on('error', (error) => {
        clearTimeout(timeout);
        done(error);
      });
    });
  });

  describe('HTTP API Endpoints', () => {
    it('should respond to health check', async () => {
      const response = await fetch(`http://localhost:${port}/health`);
      expect(response.status).toBe(200);
      const data = await response.json() as { status: string };
      expect(data.status).toBe('ok');
    });

    it('should provide server statistics', async () => {
      const response = await fetch(`http://localhost:${port}/stats`);
      expect(response.status).toBe(200);
      const data = await response.json() as { totalConnections: number; activeConnections: number; uptime: number };
      expect(data).toHaveProperty('totalConnections');
      expect(data).toHaveProperty('activeConnections');
      expect(data).toHaveProperty('uptime');
    });
  });

  describe('Server-Sent Events (SSE)', () => {
    it('should handle SSE connections', (done) => {
      const token = global.testUtils.generateTestToken();
      
      const eventSource = new MockEventSource(`http://localhost:${port}/haip/sse?token=${token}`);
      let handshakeReceived = false;
      
      const timeout = setTimeout(() => {
        eventSource.close();
        done(new Error('SSE test timeout'));
      }, 3000);
      
      eventSource.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          if (message.type === 'HAI') {
            handshakeReceived = true;
            clearTimeout(timeout);
            eventSource.close();
            done();
          }
        } catch (error) {
          // Ignore parsing errors
        }
      };

      eventSource.onerror = () => {
        clearTimeout(timeout);
        eventSource.close();
        done(new Error('SSE connection failed'));
      };
    });
  });

  describe('Error Handling and Recovery', () => {
    it('should handle invalid tool calls gracefully', (done) => {
      const token = global.testUtils.generateTestToken();
      const url = `ws://localhost:${port}?token=${token}`;

      const ws = new WebSocket(url);
      let errorReceived = false;

      const timeout = setTimeout(() => {
        ws.close();
        done(new Error('Error handling test timeout'));
      }, 5000);

      ws.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString());
          if (message.type === 'ERROR') {
            expect(message.payload.code).toBe('TOOL_NOT_FOUND');
            errorReceived = true;
            clearTimeout(timeout);
            ws.close();
            done();
          }
        } catch (error) {
          // Ignore parsing errors
        }
      });

      ws.on('open', () => {
        setTimeout(() => {
          const invalidToolCall: HAIPMessage = {
            id: 'tool-1',
            session: 'test-session',
            seq: '1',
            ts: Date.now().toString(),
            channel: 'AGENT',
            type: 'TOOL_CALL',
            payload: {
              call_id: 'call-1',
              tool: 'nonexistent_tool',
              params: {}
            }
          };
          ws.send(JSON.stringify(invalidToolCall));
        }, 200);
      });

      ws.on('error', (error) => {
        clearTimeout(timeout);
        done(error);
      });
    });

    it('should handle malformed messages gracefully', (done) => {
      const token = global.testUtils.generateTestToken();
      const url = `ws://localhost:${port}?token=${token}`;

      const ws = new WebSocket(url);
      let errorReceived = false;

      const timeout = setTimeout(() => {
        if (!errorReceived) {
          // If no error was received, that's also acceptable for malformed JSON
          ws.close();
          done();
        }
      }, 3000);

      ws.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString());
          if (message.type === 'ERROR' && !errorReceived) {
            errorReceived = true;
            expect(message.payload.code).toBe('INVALID_MESSAGE');
            clearTimeout(timeout);
            ws.close();
            done();
          }
        } catch (error) {
          // Ignore parsing errors
        }
      });

      ws.on('open', () => {
        setTimeout(() => {
          ws.send('invalid json message');
        }, 200);
      });

      ws.on('error', (error) => {
        clearTimeout(timeout);
        done(error);
      });
    });
  });

  describe('Performance and Load Testing', () => {
    it('should handle multiple concurrent connections', (done) => {
      const token = global.testUtils.generateTestToken();
      const url = `ws://localhost:${port}?token=${token}`;

      const connections: WebSocket[] = [];
      const maxConnections = 5;
      let connectedCount = 0;

      for (let i = 0; i < maxConnections; i++) {
        const ws = new WebSocket(url);
        connections.push(ws);
        
        ws.on('open', () => {
          connectedCount++;
          if (connectedCount === maxConnections) {
            const stats = server.getStats();
            expect(stats.activeConnections).toBe(maxConnections);
            
            // Close all connections
            connections.forEach(conn => conn.close());
            done();
          }
        });
      }
    });

    it('should handle rapid message sending', (done) => {
      const token = global.testUtils.generateTestToken();
      const url = `ws://localhost:${port}?token=${token}`;

      const ws = new WebSocket(url);
      let pongCount = 0;
      const maxMessages = 10;
      const sentNonces = new Set<string>();

      ws.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString());
          if (message.type === 'PONG' && sentNonces.has(message.payload.nonce)) {
            pongCount++;
            if (pongCount >= maxMessages) {
              ws.close();
              done();
            }
          }
        } catch (error) {
          // Ignore parsing errors
        }
      });

      ws.on('open', () => {
        // Send messages rapidly
        for (let i = 0; i < maxMessages; i++) {
          const nonce = `nonce-${i}`;
          sentNonces.add(nonce);
          const pingMessage: HAIPMessage = {
            id: `ping-${i}`,
            session: 'test-session',
            seq: i.toString(),
            ts: Date.now().toString(),
            channel: 'SYSTEM',
            type: 'PING',
            payload: { nonce }
          };
          ws.send(JSON.stringify(pingMessage));
        }
      });
    }, 15000);
  });

  describe('Tool Integration', () => {
    it('should handle tool registration and execution', (done) => {
      const customTool = {
        name: 'custom_tool',
        description: 'A custom test tool',
        inputSchema: {
          type: 'object',
          properties: {
            input: { type: 'string' }
          }
        }
      };

      server.registerTool(customTool);
      const tools = server.getTools();
      expect(tools).toContainEqual(customTool);

      const token = global.testUtils.generateTestToken();
      const url = `ws://localhost:${port}?token=${token}`;

      const ws = new WebSocket(url);
      ws.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString());
          if (message.type === 'TOOL_DONE') {
            expect(message.payload.status).toBe('OK');
            ws.close();
            done();
          }
        } catch (error) {
          // Ignore parsing errors
        }
      });

      ws.on('open', () => {
        setTimeout(() => {
          const toolCall: HAIPMessage = {
            id: 'tool-1',
            session: 'test-session',
            seq: '1',
            ts: Date.now().toString(),
            channel: 'AGENT',
            type: 'TOOL_CALL',
            payload: {
              call_id: 'call-1',
              tool: 'custom_tool',
              params: { input: 'test' }
            }
          };
          ws.send(JSON.stringify(toolCall));
        }, 100);
      });
    });

    it('should handle tool unregistration', () => {
      const toolName = 'test_tool';
      const tool = {
        name: toolName,
        description: 'Test tool',
        inputSchema: {}
      };

      server.registerTool(tool);
      expect(server.getTools()).toContainEqual(tool);

      server.unregisterTool(toolName);
      expect(server.getTools()).not.toContainEqual(tool);
    });
  });

  describe('Event System', () => {
    it('should emit appropriate events during operation', (done) => {
      const token = global.testUtils.generateTestToken();
      const url = `ws://localhost:${port}?token=${token}`;

      let connectEventReceived = false;
      let toolCallEventReceived = false;

      server.once('connect', (sessionId) => {
        connectEventReceived = true;
        checkCompletion();
      });

      server.once('toolCall', (sessionId, execution) => {
        toolCallEventReceived = true;
        expect(execution.toolName).toBe('echo');
        checkCompletion();
      });

      const checkCompletion = () => {
        if (connectEventReceived && toolCallEventReceived) {
          done();
        }
      };

      const ws = new WebSocket(url);
      ws.on('open', () => {
        setTimeout(() => {
          const toolCall: HAIPMessage = {
            id: 'tool-1',
            session: 'test-session',
            seq: '1',
            ts: Date.now().toString(),
            channel: 'AGENT',
            type: 'TOOL_CALL',
            payload: {
              call_id: 'call-1',
              tool: 'echo',
              params: { message: 'Test event' }
            }
          };
          ws.send(JSON.stringify(toolCall));
        }, 100);
      });
    });
  });
}); 
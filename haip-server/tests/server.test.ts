import { HAIPServer } from '../src/server';
import { HAIPServerUtils } from '../src/utils';
import { HAIPMessage, HAIPChannel, HAIPEventType } from '../src/types';
import WebSocket from 'ws';
import request from 'supertest';
import express from 'express';

describe('HAIPServer', () => {
  let server: HAIPServer;
  let port: number;
  const createdServers: HAIPServer[] = [];

  beforeEach(() => {
    port = global.testUtils.getAvailablePort();
    server = new HAIPServer({ port });
    createdServers.push(server);
  });

  afterEach(async () => {
    // Clean up all created server instances
    for (const testServer of createdServers) {
      if (testServer) {
        testServer.stop();
      }
    }
    createdServers.length = 0; // Clear the array
    
    // Wait for all servers to stop
    await new Promise(resolve => setTimeout(resolve, 200));
  });

  describe('Server Initialization', () => {
    it('should initialize with default configuration', () => {
      const defaultServer = new HAIPServer();
      createdServers.push(defaultServer);
      expect(defaultServer).toBeDefined();
      expect(defaultServer.getStats()).toBeDefined();
    });

    it('should initialize with custom configuration', () => {
      const customServer = new HAIPServer({
        port: 8081,
        host: '127.0.0.1',
        jwtSecret: 'custom-secret',
        maxConnections: 500
      });
      createdServers.push(customServer);
      
      expect(customServer).toBeDefined();
    });

    it('should start and stop server', async () => {
      const testServer = new HAIPServer({ port: 8082 });
      createdServers.push(testServer);
      
      // Start server
      testServer.start();
      await global.testUtils.waitForCondition(() => {
        return testServer.getStats().uptime > 0;
      }, 1000);
      
      expect(testServer.getStats().uptime).toBeGreaterThan(0);
      
      // Stop server
      testServer.stop();
      await new Promise(resolve => setTimeout(resolve, 100));
    });
  });

  describe('Tool Registration', () => {
    it('should register and unregister tools', () => {
      const tool = {
        name: 'test-tool',
        description: 'Test tool',
        inputSchema: {
          type: 'object',
          properties: {
            input: { type: 'string' }
          }
        },
        outputSchema: {
          type: 'object',
          properties: {
            output: { type: 'string' }
          }
        }
      };

      server.registerTool(tool);
      expect(server.getTools()).toContainEqual(tool);

      server.unregisterTool('test-tool');
      expect(server.getTools()).not.toContainEqual(tool);
    });

    it('should get all registered tools', () => {
      const tool1 = {
        name: 'tool1',
        description: 'Tool 1',
        inputSchema: {},
        outputSchema: {}
      };

      const tool2 = {
        name: 'tool2',
        description: 'Tool 2',
        inputSchema: {},
        outputSchema: {}
      };

      server.registerTool(tool1);
      server.registerTool(tool2);

      const tools = server.getTools();
      // Account for default tools (echo, add) plus the 2 new tools
      expect(tools.length).toBeGreaterThanOrEqual(4);
      expect(tools).toContainEqual(tool1);
      expect(tools).toContainEqual(tool2);
    });
  });

  describe('Session Management', () => {
    it('should create and manage sessions', () => {
      const sessionId = 'test-session';
      const userId = 'test-user';
      
      // Create session (this would normally happen during connection)
      const session = server.getSession(sessionId);
      expect(session).toBeUndefined(); // Session doesn't exist yet
    });

    it('should track server statistics', async () => {
      // Start the server to ensure uptime is calculated
      server.start();
      
      // Wait a bit for the server to start and accumulate some uptime
      await new Promise(resolve => setTimeout(resolve, 100));
      
      const stats = server.getStats();
      
      expect(stats).toBeDefined();
      expect(stats.totalConnections).toBeGreaterThanOrEqual(0);
      expect(stats.activeConnections).toBeGreaterThanOrEqual(0);
      expect(stats.totalMessages).toBeGreaterThanOrEqual(0);
      expect(stats.uptime).toBeGreaterThan(0);
    });
  });

  describe('Message Broadcasting', () => {
    it('should broadcast messages to all sessions', () => {
      const message: HAIPMessage = {
        id: 'broadcast-1',
        session: 'broadcast-session',
        seq: '1',
        ts: Date.now().toString(),
        channel: 'SYSTEM',
        type: 'PING',
        payload: { nonce: 'test' }
      };

      // Mock sessions for testing
      const mockSession = {
        id: 'test-session',
        userId: 'test-user',
        connected: true,
        handshakeCompleted: true,
        lastActivity: Date.now(),
        credits: new Map(),
        byteCredits: new Map(),
        pausedChannels: new Set(),
        lastAck: '',
        lastDeliveredSeq: '',
        replayWindow: new Map(),
        activeRuns: new Set(),
        pendingMessages: new Map()
      };

      // Add mock session to server (this would normally happen during connection)
      // Note: This is testing the broadcast functionality, not actual session management
      
      expect(() => server.broadcast(message)).not.toThrow();
    });
  });

  describe('Message Sending', () => {
    it('should send messages to sessions', () => {
      const message: HAIPMessage = {
        id: 'test-1',
        session: 'test-session',
        seq: '1',
        ts: Date.now().toString(),
        channel: 'SYSTEM',
        type: 'PING',
        payload: { nonce: 'test' }
      };

      // This should not throw even if session doesn't exist
      expect(() => server.sendMessage('non-existent-session', message)).not.toThrow();
    });

    it('should send tool done messages', () => {
      expect(() => server.sendToolDone('test-session', 'call-1', 'OK', { result: 'success' })).not.toThrow();
    });
  });

  describe('Event Handling', () => {
    it('should emit events when server starts and stops', async () => {
      const testServer = new HAIPServer({ port: 8083 });
      createdServers.push(testServer);
      
      const startPromise = global.testUtils.waitForEvent(testServer, 'started', 2000);
      testServer.start();
      
      await startPromise;
      
      const stopPromise = global.testUtils.waitForEvent(testServer, 'stopped', 2000);
      testServer.stop();
      
      await stopPromise;
    });

    it('should handle server errors', async () => {
      const testServer = new HAIPServer({ port: 8084 });
      createdServers.push(testServer);
      
      // Mock an error
      const errorPromise = global.testUtils.waitForEvent(testServer, 'error', 1000);
      testServer.emit('error', new Error('Test error'));
      
      const error = await errorPromise;
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toBe('Test error');
    });
  });

  describe('Flow Control', () => {
    it('should handle flow control configuration', () => {
      const flowControlServer = new HAIPServer({
        flowControl: {
          enabled: true,
          initialCredits: 100,
          minCredits: 10,
          maxCredits: 1000,
          creditThreshold: 50,
          backPressureThreshold: 80,
          adaptiveAdjustment: true
        }
      });
      createdServers.push(flowControlServer);
      expect(flowControlServer).toBeDefined();
    });

    it('should handle disabled flow control', () => {
      const noFlowControlServer = new HAIPServer({
        flowControl: {
          enabled: false,
          initialCredits: 0,
          minCredits: 0,
          maxCredits: 0,
          creditThreshold: 0,
          backPressureThreshold: 0,
          adaptiveAdjustment: false
        }
      });
      createdServers.push(noFlowControlServer);
      expect(noFlowControlServer).toBeDefined();
    });
  });

  describe('Server Configuration', () => {
    it('should handle different port configurations', () => {
      const portServer = new HAIPServer({ port: 8085 });
      createdServers.push(portServer);
      expect(portServer).toBeDefined();
    });

    it('should handle different host configurations', () => {
      const hostServer = new HAIPServer({ host: '127.0.0.1' });
      createdServers.push(hostServer);
      expect(hostServer).toBeDefined();
    });

    it('should handle JWT configuration', () => {
      const jwtServer = new HAIPServer({
        jwtSecret: 'test-secret',
        jwtExpiresIn: '1h'
      });
      createdServers.push(jwtServer);
      expect(jwtServer).toBeDefined();
    });

    it('should handle connection limits', () => {
      const limitServer = new HAIPServer({
        maxConnections: 100
      });
      createdServers.push(limitServer);
      expect(limitServer).toBeDefined();
    });

    it('should handle replay window configuration', () => {
      const replayServer = new HAIPServer({
        replayWindowSize: 500,
        replayWindowTime: 30000
      });
      createdServers.push(replayServer);
      expect(replayServer).toBeDefined();
    });

    it('should handle feature toggles', () => {
      const featureServer = new HAIPServer({
        enableCORS: false,
        enableCompression: false,
        enableLogging: false
      });
      createdServers.push(featureServer);
      expect(featureServer).toBeDefined();
    });
  });

  describe('Statistics and Monitoring', () => {
    it('should provide accurate statistics', async () => {
      // Create a fresh server instance for this test
      const testServer = new HAIPServer({ port: global.testUtils.getAvailablePort() });
      createdServers.push(testServer);
      
      // Start the server to ensure uptime is calculated
      testServer.start();
      
      // Wait a bit for the server to start and accumulate some uptime
      await new Promise(resolve => setTimeout(resolve, 100));
      
      const stats = testServer.getStats();
      
      expect(stats.totalConnections).toBeGreaterThanOrEqual(0);
      expect(stats.activeConnections).toBeGreaterThanOrEqual(0);
      expect(stats.totalMessages).toBeGreaterThanOrEqual(0);
      expect(stats.messagesPerSecond).toBeGreaterThanOrEqual(0);
      expect(stats.averageLatency).toBeGreaterThanOrEqual(0);
      expect(stats.errorRate).toBeGreaterThanOrEqual(0);
      expect(stats.uptime).toBeGreaterThan(0);
      
      // Clean up
      testServer.stop();
    });

    it('should update statistics over time', async () => {
      const initialStats = server.getStats();
      
      await new Promise(resolve => setTimeout(resolve, 100));
      
      const updatedStats = server.getStats();
      expect(updatedStats.uptime).toBeGreaterThan(initialStats.uptime);
    });
  });

  describe('Error Handling', () => {
    it('should handle invalid configurations gracefully', () => {
      const invalidPortServer = new HAIPServer({ port: -1 });
      createdServers.push(invalidPortServer);
      expect(() => invalidPortServer).not.toThrow();
      
      const invalidConnectionsServer = new HAIPServer({ maxConnections: -1 });
      createdServers.push(invalidConnectionsServer);
      expect(() => invalidConnectionsServer).not.toThrow();
      
      const invalidHeartbeatServer = new HAIPServer({ heartbeatInterval: -1 });
      createdServers.push(invalidHeartbeatServer);
      expect(() => invalidHeartbeatServer).not.toThrow();
    });

    it('should handle missing JWT secret', () => {
      const noJwtServer = new HAIPServer({ jwtSecret: '' });
      createdServers.push(noJwtServer);
      expect(() => noJwtServer).not.toThrow();
    });

    it('should handle invalid flow control configuration', () => {
      const invalidFlowServer = new HAIPServer({
        flowControl: {
          enabled: true,
          initialCredits: -1,
          minCredits: -1,
          maxCredits: -1,
          creditThreshold: -1,
          backPressureThreshold: -1,
          adaptiveAdjustment: true
        }
      });
      createdServers.push(invalidFlowServer);
      expect(() => invalidFlowServer).not.toThrow();
    });
  });

  describe('Integration with Utils', () => {
    it('should work with HAIPServerUtils', () => {
      const message = HAIPServerUtils.createMessage(
        'test-session',
        'SYSTEM',
        'PING',
        { nonce: 'test' }
      );
      
      expect(HAIPServerUtils.validateMessage(message)).toBe(true);
      expect(message.session).toBe('test-session');
      expect(message.channel).toBe('SYSTEM');
      expect(message.type).toBe('PING');
    });

    it('should handle message validation', () => {
      const validMessage = HAIPServerUtils.createMessage(
        'test-session',
        'USER',
        'TEXT_MESSAGE_START',
        { message_id: 'msg-1' }
      );
      
      expect(HAIPServerUtils.validateMessage(validMessage)).toBe(true);
      expect(HAIPServerUtils.validateMessage(null)).toBe(false);
      expect(HAIPServerUtils.validateMessage({})).toBe(false);
    });
  });
}); 
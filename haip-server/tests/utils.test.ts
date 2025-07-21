import { HAIPServerUtils } from '../src/utils';
import { 
  HAIPMessage, 
  HAIPChannel, 
  HAIPEventType,
  HAIPHandshakePayload,
  HAIPRunStartedPayload,
  HAIPRunFinishedPayload,
  HAIPRunCancelPayload,
  HAIPRunErrorPayload,
  HAIPPingPayload,
  HAIPPongPayload,
  HAIPReplayRequestPayload,
  HAIPTextMessageStartPayload,
  HAIPTextMessagePartPayload,
  HAIPTextMessageEndPayload,
  HAIPAudioChunkPayload,
  HAIPToolCallPayload,
  HAIPToolUpdatePayload,
  HAIPToolDonePayload,
  HAIPToolCancelPayload,
  HAIPToolListPayload,
  HAIPToolSchemaPayload,
  HAIPErrorPayload,
  HAIPFlowUpdatePayload,
  HAIPChannelControlPayload
} from '../src/types';

describe('HAIPServerUtils', () => {
  describe('UUID Generation', () => {
    it('should generate unique UUIDs', () => {
      const uuid1 = HAIPServerUtils.generateUUID();
      const uuid2 = HAIPServerUtils.generateUUID();
      
      expect(uuid1).toBeDefined();
      expect(uuid2).toBeDefined();
      expect(uuid1).not.toBe(uuid2);
      expect(uuid1).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });
  });

  describe('Timestamp Generation', () => {
    it('should generate timestamps', () => {
      const ts1 = HAIPServerUtils.generateTimestamp();
      // Add a small delay to ensure different timestamps
      setTimeout(() => {
        const ts2 = HAIPServerUtils.generateTimestamp();
        
        expect(ts1).toBeDefined();
        expect(ts2).toBeDefined();
        expect(parseInt(ts1)).toBeGreaterThan(0);
        expect(parseInt(ts2)).toBeGreaterThanOrEqual(parseInt(ts1));
      }, 1);
    });
  });

  describe('Sequence Number Generation', () => {
    it('should generate unique sequence numbers', () => {
      const seq1 = HAIPServerUtils.generateSequenceNumber();
      const seq2 = HAIPServerUtils.generateSequenceNumber();
      
      expect(seq1).toBeDefined();
      expect(seq2).toBeDefined();
      expect(seq1).not.toBe(seq2);
    });
  });

  describe('Message Validation', () => {
    it('should validate correct messages', () => {
      const validMessage: HAIPMessage = {
        id: 'test-id',
        session: 'test-session',
        seq: '123',
        ts: '1234567890',
        channel: 'USER',
        type: 'TEXT_MESSAGE_START',
        payload: { message_id: 'msg-1' }
      };
      
      expect(HAIPServerUtils.validateMessage(validMessage)).toBe(true);
    });

    it('should reject invalid messages', () => {
      expect(HAIPServerUtils.validateMessage(null)).toBe(false);
      expect(HAIPServerUtils.validateMessage(undefined)).toBe(false);
      expect(HAIPServerUtils.validateMessage({})).toBe(false);
      expect(HAIPServerUtils.validateMessage({ id: 'test' })).toBe(false);
    });

    it('should reject messages with invalid channels', () => {
      const invalidMessage = {
        id: 'test-id',
        session: 'test-session',
        seq: '123',
        ts: '1234567890',
        channel: 'INVALID',
        type: 'TEXT_MESSAGE_START',
        payload: { message_id: 'msg-1' }
      };
      
      expect(HAIPServerUtils.validateMessage(invalidMessage)).toBe(false);
    });

    it('should reject messages with invalid event types', () => {
      const invalidMessage = {
        id: 'test-id',
        session: 'test-session',
        seq: '123',
        ts: '1234567890',
        channel: 'USER',
        type: 'INVALID_TYPE',
        payload: { message_id: 'msg-1' }
      };
      
      expect(HAIPServerUtils.validateMessage(invalidMessage)).toBe(false);
    });
  });

  describe('Channel Validation', () => {
    it('should validate correct channels', () => {
      const validChannels: HAIPChannel[] = ['USER', 'AGENT', 'SYSTEM', 'AUDIO_IN', 'AUDIO_OUT'];
      
      validChannels.forEach(channel => {
        expect(HAIPServerUtils.validateChannel(channel)).toBe(true);
      });
    });

    it('should reject invalid channels', () => {
      expect(HAIPServerUtils.validateChannel('INVALID')).toBe(false);
      expect(HAIPServerUtils.validateChannel('')).toBe(false);
      expect(HAIPServerUtils.validateChannel(null)).toBe(false);
      expect(HAIPServerUtils.validateChannel(undefined)).toBe(false);
    });
  });

  describe('Event Type Validation', () => {
    it('should validate correct event types', () => {
      const validTypes: HAIPEventType[] = [
        'HAI', 'RUN_STARTED', 'RUN_FINISHED', 'RUN_CANCEL', 'RUN_ERROR',
        'PING', 'PONG', 'REPLAY_REQUEST', 'TEXT_MESSAGE_START',
        'TEXT_MESSAGE_PART', 'TEXT_MESSAGE_END', 'AUDIO_CHUNK',
        'TOOL_CALL', 'TOOL_UPDATE', 'TOOL_DONE', 'TOOL_CANCEL',
        'TOOL_LIST', 'TOOL_SCHEMA', 'ERROR', 'FLOW_UPDATE',
        'PAUSE_CHANNEL', 'RESUME_CHANNEL'
      ];
      
      validTypes.forEach(type => {
        expect(HAIPServerUtils.validateEventType(type)).toBe(true);
      });
    });

    it('should reject invalid event types', () => {
      expect(HAIPServerUtils.validateEventType('INVALID')).toBe(false);
      expect(HAIPServerUtils.validateEventType('')).toBe(false);
      expect(HAIPServerUtils.validateEventType(null)).toBe(false);
      expect(HAIPServerUtils.validateEventType(undefined)).toBe(false);
    });
  });

  describe('Message Creation', () => {
    const sessionId = 'test-session';
    const channel: HAIPChannel = 'USER';
    const type: HAIPEventType = 'TEXT_MESSAGE_START';
    const payload = { message_id: 'msg-1' };

    it('should create basic messages', () => {
      const message = HAIPServerUtils.createMessage(sessionId, channel, type, payload);
      
      expect(message.id).toBeDefined();
      expect(message.session).toBe(sessionId);
      expect(message.channel).toBe(channel);
      expect(message.type).toBe(type);
      expect(message.payload).toEqual(payload);
      expect(message.ts).toBeDefined();
      expect(message.seq).toBeDefined();
    });

    it('should create messages with custom options', () => {
      const customId = 'custom-id';
      const customSeq = 'custom-seq';
      const customTs = '1234567890';
      const ack = 'ack-123';
      const pv = 1;
      const crit = true;
      const binLen = 1024;
      const binMime = 'audio/wav';
      const runId = 'run-123';
      const threadId = 'thread-123';

      const message = HAIPServerUtils.createMessage(sessionId, channel, type, payload, {
        id: customId,
        seq: customSeq,
        ts: customTs,
        ack,
        pv,
        crit,
        bin_len: binLen,
        bin_mime: binMime,
        run_id: runId,
        thread_id: threadId
      });

      expect(message.id).toBe(customId);
      expect(message.seq).toBe(customSeq);
      expect(message.ts).toBe(customTs);
      expect(message.ack).toBe(ack);
      expect(message.pv).toBe(pv);
      expect(message.crit).toBe(crit);
      expect(message.bin_len).toBe(binLen);
      expect(message.bin_mime).toBe(binMime);
      expect(message.run_id).toBe(runId);
      expect(message.thread_id).toBe(threadId);
    });
  });

  describe('Specific Message Types', () => {
    const sessionId = 'test-session';

    describe('Handshake Messages', () => {
      it('should create handshake messages', () => {
        const payload: HAIPHandshakePayload = {
          haip_version: '1.1.2',
          accept_major: [1],
          accept_events: ['HAI', 'PING', 'PONG'],
          capabilities: {
            binary_frames: true,
            flow_control: {
              initial_credit_messages: 1000,
              initial_credit_bytes: 1024 * 1024
            }
          }
        };

        const message = HAIPServerUtils.createHandshakeMessage(sessionId, payload);
        
        expect(message.type).toBe('HAI');
        expect(message.channel).toBe('SYSTEM');
        expect(message.payload).toEqual(payload);
      });
    });

    describe('Run Messages', () => {
      it('should create run started messages', () => {
        const payload: HAIPRunStartedPayload = {
          run_id: 'run-123',
          thread_id: 'thread-123',
          metadata: { test: true }
        };

        const message = HAIPServerUtils.createRunStartedMessage('test-session', payload, 'run-123', 'thread-123');
        
        expect(message.id).toBeDefined();
        expect(message.session).toBe('test-session');
        expect(message.channel).toBe('SYSTEM');
        expect(message.type).toBe('RUN_STARTED');
        expect(message.payload).toEqual(payload);
        expect(message.run_id).toBe('run-123');
        expect(message.thread_id).toBe('thread-123');
      });

      it('should create run finished messages', () => {
        const payload: HAIPRunFinishedPayload = {
          run_id: 'run-123',
          status: 'OK',
          summary: 'Run completed successfully'
        };

        const message = HAIPServerUtils.createRunFinishedMessage('test-session', payload, 'run-123');
        
        expect(message.id).toBeDefined();
        expect(message.session).toBe('test-session');
        expect(message.channel).toBe('SYSTEM');
        expect(message.type).toBe('RUN_FINISHED');
        expect(message.payload).toEqual(payload);
        expect(message.run_id).toBe('run-123');
      });

      it('should create run cancel messages', () => {
        const payload: HAIPRunCancelPayload = {
          run_id: 'run-123'
        };

        const message = HAIPServerUtils.createRunCancelMessage('test-session', payload, 'run-123');
        
        expect(message.id).toBeDefined();
        expect(message.session).toBe('test-session');
        expect(message.channel).toBe('SYSTEM');
        expect(message.type).toBe('RUN_CANCEL');
        expect(message.payload).toEqual(payload);
        expect(message.run_id).toBe('run-123');
      });

      it('should create run error messages', () => {
        const payload: HAIPRunErrorPayload = {
          run_id: 'run-123',
          code: 'TEST_ERROR',
          message: 'Test error occurred'
        };

        const message = HAIPServerUtils.createRunErrorMessage('test-session', payload, 'run-123');
        
        expect(message.id).toBeDefined();
        expect(message.session).toBe('test-session');
        expect(message.channel).toBe('SYSTEM');
        expect(message.type).toBe('RUN_ERROR');
        expect(message.payload).toEqual(payload);
        expect(message.run_id).toBe('run-123');
      });
    });

    describe('Ping/Pong Messages', () => {
      it('should create ping messages', () => {
        const payload: HAIPPingPayload = {
          nonce: 'test-nonce'
        };

        const message = HAIPServerUtils.createPingMessage(sessionId, payload);
        
        expect(message.type).toBe('PING');
        expect(message.channel).toBe('SYSTEM');
        expect(message.payload).toEqual(payload);
      });

      it('should create pong messages', () => {
        const payload: HAIPPongPayload = {
          nonce: 'test-nonce'
        };

        const message = HAIPServerUtils.createPongMessage(sessionId, payload);
        
        expect(message.type).toBe('PONG');
        expect(message.channel).toBe('SYSTEM');
        expect(message.payload).toEqual(payload);
      });
    });

    describe('Text Messages', () => {
      it('should create text message start', () => {
        const payload: HAIPTextMessageStartPayload = {
          message_id: 'msg-1',
          author: 'user',
          text: 'Hello'
        };

        const message = HAIPServerUtils.createTextMessageStart(sessionId, payload);
        
        expect(message.type).toBe('TEXT_MESSAGE_START');
        expect(message.channel).toBe('USER');
        expect(message.payload).toEqual(payload);
      });

      it('should create text message part', () => {
        const payload: HAIPTextMessagePartPayload = {
          message_id: 'msg-1',
          text: 'Hello'
        };

        const message = HAIPServerUtils.createTextMessagePart(sessionId, payload);
        
        expect(message.type).toBe('TEXT_MESSAGE_PART');
        expect(message.channel).toBe('USER');
        expect(message.payload).toEqual(payload);
      });

      it('should create text message end', () => {
        const payload: HAIPTextMessageEndPayload = {
          message_id: 'msg-1',
          tokens: '5'
        };

        const message = HAIPServerUtils.createTextMessageEnd(sessionId, payload);
        
        expect(message.type).toBe('TEXT_MESSAGE_END');
        expect(message.channel).toBe('USER');
        expect(message.payload).toEqual(payload);
      });
    });

    describe('Tool Messages', () => {
      it('should create tool call messages', () => {
        const payload: HAIPToolCallPayload = {
          call_id: 'call-1',
          tool: 'echo',
          params: { message: 'Hello' }
        };

        const message = HAIPServerUtils.createToolCallMessage(sessionId, payload);
        
        expect(message.type).toBe('TOOL_CALL');
        expect(message.channel).toBe('AGENT');
        expect(message.payload).toEqual(payload);
      });

      it('should create tool update messages', () => {
        const payload: HAIPToolUpdatePayload = {
          call_id: 'call-1',
          status: 'RUNNING',
          progress: 50
        };

        const message = HAIPServerUtils.createToolUpdateMessage(sessionId, payload);
        
        expect(message.type).toBe('TOOL_UPDATE');
        expect(message.channel).toBe('AGENT');
        expect(message.payload).toEqual(payload);
      });

      it('should create tool done messages', () => {
        const payload: HAIPToolDonePayload = {
          call_id: 'call-1',
          status: 'OK',
          result: { echoed: 'Hello' }
        };

        const message = HAIPServerUtils.createToolDoneMessage(sessionId, payload);
        
        expect(message.type).toBe('TOOL_DONE');
        expect(message.channel).toBe('AGENT');
        expect(message.payload).toEqual(payload);
      });

      it('should create tool cancel messages', () => {
        const payload: HAIPToolCancelPayload = {
          call_id: 'call-1',
          reason: 'User cancelled'
        };

        const message = HAIPServerUtils.createToolCancelMessage(sessionId, payload);
        
        expect(message.type).toBe('TOOL_CANCEL');
        expect(message.channel).toBe('AGENT');
        expect(message.payload).toEqual(payload);
      });
    });
  });

  describe('JWT Utilities', () => {
    it('should parse valid JWT tokens', () => {
      const token = global.testUtils.generateTestToken();
      const payload = HAIPServerUtils.parseJWT(token);
      
      expect(payload).toBeDefined();
      expect(payload?.userId).toBe('test-user');
      expect(payload?.exp).toBeGreaterThan(0);
      expect(payload?.iat).toBeGreaterThan(0);
    });

    it('should return null for invalid JWT tokens', () => {
      expect(HAIPServerUtils.parseJWT('invalid-token')).toBeNull();
      expect(HAIPServerUtils.parseJWT('')).toBeNull();
      expect(HAIPServerUtils.parseJWT('header.payload')).toBeNull();
    });

    it('should validate JWT tokens', () => {
      const validToken = global.testUtils.generateTestToken();
      const expiredToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiJ0ZXN0LXVzZXIiLCJleHAiOjEwMDAwMDAwMDB9.signature';
      
      expect(HAIPServerUtils.validateJWT(validToken)).toBe(true);
      expect(HAIPServerUtils.validateJWT(expiredToken)).toBe(false);
      expect(HAIPServerUtils.validateJWT('invalid')).toBe(false);
    });

    it('should extract user ID from JWT tokens', () => {
      const token = global.testUtils.generateTestToken();
      const userId = HAIPServerUtils.getUserIdFromToken(token);
      
      expect(userId).toBe('test-user');
    });

    it('should return null for invalid tokens when extracting user ID', () => {
      expect(HAIPServerUtils.getUserIdFromToken('invalid')).toBeNull();
    });
  });

  describe('Utility Functions', () => {
    it('should calculate latency', () => {
      const startTime = Date.now();
      const latency = HAIPServerUtils.calculateLatency(startTime);
      
      expect(latency).toBeGreaterThanOrEqual(0);
      expect(latency).toBeLessThan(100); // Should be very fast
    });

    it('should format bytes', () => {
      expect(HAIPServerUtils.formatBytes(0)).toBe('0 Bytes');
      expect(HAIPServerUtils.formatBytes(1024)).toBe('1 KB');
      expect(HAIPServerUtils.formatBytes(1024 * 1024)).toBe('1 MB');
      expect(HAIPServerUtils.formatBytes(1024 * 1024 * 1024)).toBe('1 GB');
    });

    it('should format duration', () => {
      expect(HAIPServerUtils.formatDuration(500)).toBe('500ms');
      expect(HAIPServerUtils.formatDuration(1500)).toBe('1.5s');
      expect(HAIPServerUtils.formatDuration(65000)).toBe('1m 5.0s');
    });
  });
}); 
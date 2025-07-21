/// <reference types="jest" />

import { WebSocketTransport } from "../src/transports/websocket";
import { SSETransport } from "../src/transports/sse";
import { HTTPStreamingTransport } from "../src/transports/http-streaming";
import { HAIPTransportConfig, HAIPMessage } from "../src/types";
import { HAIPUtils } from "../src/utils";

// Mock Node.js WebSocket
class MockNodeWebSocket {
  public readyState: number = 0; // CONNECTING
  public url: string;
  public sentMessages: string[] = [];
  public sentBinary: ArrayBuffer[] = [];
  private listeners: Map<string, ((...args: any[]) => void)[]> = new Map();

  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSED = 3;

  constructor(url: string) {
    this.url = url;
  }

  on(event: string, listener: (...args: any[]) => void): this {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event)!.push(listener);
    return this;
  }

  once(event: string, listener: (...args: any[]) => void): this {
    const wrappedListener = (...args: any[]) => {
      listener(...args);
      this.removeListener(event, wrappedListener);
    };
    return this.on(event, wrappedListener);
  }

  removeListener(event: string, listener: (...args: any[]) => void): this {
    const listeners = this.listeners.get(event);
    if (listeners) {
      const index = listeners.indexOf(listener);
      if (index > -1) {
        listeners.splice(index, 1);
      }
    }
    return this;
  }

  send(data: string | ArrayBuffer, callback?: (error?: Error) => void): void {
    if (typeof data === "string") {
      this.sentMessages.push(data);
    } else {
      this.sentBinary.push(data);
    }
    if (callback) {
      callback();
    }
  }

  close(code?: number, reason?: string | Buffer): void {
    this.readyState = MockNodeWebSocket.CLOSED;
    const listeners = this.listeners.get("close");
    if (listeners) {
      listeners.forEach(listener => listener(code || 1000, reason || Buffer.from("Normal closure")));
    }
  }

  ping(): void {
    const listeners = this.listeners.get("ping");
    if (listeners) {
      listeners.forEach(listener => listener());
    }
  }

  pong(): void {
    const listeners = this.listeners.get("pong");
    if (listeners) {
      listeners.forEach(listener => listener());
    }
  }

  terminate(): void {
    this.readyState = MockNodeWebSocket.CLOSED;
    const listeners = this.listeners.get("close");
    if (listeners) {
      listeners.forEach(listener => listener(1006, Buffer.from("Connection terminated")));
    }
  }

  // Test helpers
  simulateOpen(): void {
    this.readyState = MockNodeWebSocket.OPEN;
    const listeners = this.listeners.get("open");
    if (listeners) {
      listeners.forEach(listener => listener());
    }
  }

  simulateMessage(data: string): void {
    const listeners = this.listeners.get("message");
    if (listeners) {
      listeners.forEach(listener => listener(data));
    }
  }

  simulateBinary(data: Buffer | ArrayBuffer): void {
    const listeners = this.listeners.get("message");
    if (listeners) {
      const bufferData = data instanceof ArrayBuffer ? Buffer.from(data) : data;
      listeners.forEach(listener => listener(bufferData));
    }
  }

  simulateError(error: Error): void {
    const listeners = this.listeners.get("error");
    if (listeners) {
      listeners.forEach(listener => listener(error));
    }
  }

  simulateClose(code: number, reason: string): void {
    this.readyState = MockNodeWebSocket.CLOSED;
    const listeners = this.listeners.get("close");
    if (listeners) {
      listeners.forEach(listener => listener(code, Buffer.from(reason)));
    }
  }

  getSentMessages(): string[] {
    return this.sentMessages;
  }

  getSentBinary(): ArrayBuffer[] {
    return this.sentBinary;
  }

  clearSent(): void {
    this.sentMessages = [];
    this.sentBinary = [];
  }
}

// Mock EventSource
class MockEventSource {
  public url: string;
  public readyState: number = 0; // CONNECTING
  public onopen?: () => void;
  public onerror?: (event: any) => void;
  public onmessage?: (event: any) => void;
  private listeners: Map<string, ((event: any) => void)[]> = new Map();

  constructor(url: string) {
    this.url = url;
  }

  addEventListener(type: string, listener: (event: any) => void): void {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, []);
    }
    this.listeners.get(type)!.push(listener);
  }

  removeEventListener(type: string, listener: (event: any) => void): void {
    const listeners = this.listeners.get(type);
    if (listeners) {
      const index = listeners.indexOf(listener);
      if (index > -1) {
        listeners.splice(index, 1);
      }
    }
  }

  close(): void {
    this.readyState = 2; // CLOSED
  }

  // Test helpers
  simulateOpen(): void {
    this.readyState = 1; // OPEN
    this.onopen?.();
  }

  simulateMessage(data: string): void {
    this.onmessage?.({ data });
  }

  simulateCustomEvent(type: string, detail: any): void {
    const listeners = this.listeners.get(type);
    if (listeners) {
      const event = { detail };
      listeners.forEach(listener => listener(event));
    }
  }

  simulateError(error: Error): void {
    this.onerror?.({ error });
  }
}

// Mock fetch
const mockFetch = jest.fn();
global.fetch = mockFetch;

// Mock the ws module
jest.mock("ws", () => {
  return jest.fn().mockImplementation((url: string) => {
    return new MockNodeWebSocket(url);
  });
});

describe("Transports", () => {
  let config: HAIPTransportConfig;

  beforeEach(() => {
    config = {
      type: "websocket",
      url: "ws://localhost:8080",
      token: "test-token",
      options: {}
    };
    mockFetch.mockClear();
  });

  describe("WebSocketTransport", () => {
    let transport: WebSocketTransport;
    let mockWs: MockNodeWebSocket;

    beforeEach(() => {
      // Get the mocked WebSocket constructor
      const WebSocket = require("ws");
      mockWs = new MockNodeWebSocket(config.url);
      WebSocket.mockImplementation(() => mockWs);

      transport = new WebSocketTransport(config.url, config.token, config.options);
    });

    afterEach(() => {
      transport.disconnect();
    });

    test("should connect successfully", async () => {
      const connectPromise = transport.connect();
      
      mockWs.simulateOpen();
      
      await connectPromise;
      
      expect(transport.isConnected()).toBe(true);
    });

    test("should handle connection errors", async () => {
      const errorPromise = new Promise<Error>((resolve) => {
        transport.onError((error) => resolve(error));
      });

      const connectPromise = transport.connect();
      mockWs.simulateError(new Error("Connection failed"));
      
      await expect(connectPromise).rejects.toThrow("Connection failed");
      
      const error = await errorPromise;
      expect(error.message).toBe("Connection failed");
    });

    test("should handle disconnection", async () => {
      await transport.connect();
      
      const disconnectPromise = new Promise<string>((resolve) => {
        transport.onDisconnect((reason) => resolve(reason));
      });

      mockWs.simulateClose(1000, "Normal closure");
      
      const reason = await disconnectPromise;
      expect(reason).toBe("Normal closure");
      expect(transport.isConnected()).toBe(false);
    });

    test("should send messages", async () => {
      await transport.connect();
      
      const message: HAIPMessage = {
        id: "test-id",
        session: "test-session",
        seq: "1",
        ts: "1234567890",
        channel: "USER",
        type: "TEXT_MESSAGE_START",
        payload: { message_id: "test" }
      };

      await transport.send(message);
      
      expect(mockWs.getSentMessages()).toHaveLength(1);
      expect(JSON.parse(mockWs.getSentMessages()[0])).toEqual(message);
    });

    test("should send binary data", async () => {
      await transport.connect();
      
      const data = new ArrayBuffer(8);
      const view = new Uint8Array(data);
      view.set([1, 2, 3, 4, 5, 6, 7, 8]);
      
      await transport.sendBinary(data);
      
      expect(mockWs.getSentBinary()).toHaveLength(1);
      expect(mockWs.getSentBinary()[0]).toEqual(data);
    });

    test("should handle incoming messages", async () => {
      await transport.connect();
      
      const messagePromise = new Promise<HAIPMessage>((resolve) => {
        transport.onMessage((message) => resolve(message));
      });

      const testMessage: HAIPMessage = {
        id: "test-id",
        session: "test-session",
        seq: "1",
        ts: "1234567890",
        channel: "USER",
        type: "TEXT_MESSAGE_START",
        payload: { message_id: "test" }
      };

      mockWs.simulateMessage(JSON.stringify(testMessage));
      
      const receivedMessage = await messagePromise;
      expect(receivedMessage).toEqual(testMessage);
    });

    test("should handle incoming binary data", async () => {
      await transport.connect();
      
      const binaryPromise = new Promise<ArrayBuffer>((resolve) => {
        transport.onBinary((data) => resolve(data));
      });

      const testData = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
      mockWs.simulateBinary(testData);
      
      const receivedData = await binaryPromise;
      expect(new Uint8Array(receivedData)).toEqual(new Uint8Array(testData));
    });

    test("should handle heartbeat", async () => {
      await transport.connect();
      
      // Wait for heartbeat
      await new Promise(resolve => setTimeout(resolve, 100));
      
      // Should have sent a ping
      expect(mockWs.getSentMessages().length).toBeGreaterThan(0);
    });

    test("should reconnect on connection loss", async () => {
      await transport.connect();
      
      const reconnectPromise = new Promise<void>((resolve) => {
        transport.onConnect(() => resolve());
      });

      mockWs.simulateClose(1006, "Connection lost");
      
      // Wait for reconnection
      await reconnectPromise;
      expect(transport.isConnected()).toBe(true);
    });
  });

  describe("SSETransport", () => {
    let transport: SSETransport;
    let mockEventSource: MockEventSource;

    beforeEach(() => {
      // Mock browser environment
      Object.defineProperty(global, "window", {
        value: {},
        writable: true
      });
      
      // Mock EventSource constructor
      (global as any).EventSource = jest.fn().mockImplementation((url: string) => {
        mockEventSource = new MockEventSource(url);
        return mockEventSource;
      });

      config.type = "sse";
      transport = new SSETransport(config);
    });

    afterEach(() => {
      transport.disconnect();
    });

    test("should connect successfully", async () => {
      const connectPromise = transport.connect();
      
      mockEventSource.simulateOpen();
      
      await connectPromise;
      
      expect(transport.isConnected()).toBe(true);
    });

    test("should handle connection errors", async () => {
      const errorPromise = new Promise<Error>((resolve) => {
        transport.onError((error) => resolve(error));
      });

      const connectPromise = transport.connect();
      mockEventSource.simulateError(new Error("SSE connection error"));
      
      await expect(connectPromise).rejects.toThrow("SSE connection error");
      
      const error = await errorPromise;
      expect(error.message).toBe("SSE connection error");
    });

    test("should handle disconnection", async () => {
      await transport.connect();
      
      const disconnectPromise = new Promise<string>((resolve) => {
        transport.onDisconnect((reason) => resolve(reason));
      });

      mockEventSource.close();
      
      const reason = await disconnectPromise;
      expect(reason).toBe("EventSource closed");
      expect(transport.isConnected()).toBe(false);
    });

    test("should send messages via HTTP POST", async () => {
      const mockResponse = {
        ok: true,
        status: 200
      };

      mockFetch.mockResolvedValue(mockResponse);
      await transport.connect();

      const message: HAIPMessage = {
        id: "test-id",
        session: "test-session",
        seq: "1",
        ts: "1234567890",
        channel: "USER",
        type: "TEXT_MESSAGE_START",
        payload: { message_id: "test" }
      };

      await transport.send(message);
      
      expect(mockFetch).toHaveBeenCalledWith(
        "ws://localhost:8080",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            "Content-Type": "application/json",
            "Authorization": "Bearer test-token",
            "X-HAIP-Message": "true"
          }),
          body: JSON.stringify(message)
        })
      );
    });

    test("should send binary data via HTTP POST", async () => {
      const mockResponse = {
        ok: true,
        status: 200
      };

      mockFetch.mockResolvedValue(mockResponse);
      await transport.connect();

      const data = new ArrayBuffer(8);
      await transport.sendBinary(data);
      
      expect(mockFetch).toHaveBeenCalledWith(
        "ws://localhost:8080",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            "Content-Type": "application/octet-stream",
            "Authorization": "Bearer test-token",
            "X-HAIP-Binary": "true"
          }),
          body: expect.any(String) // base64 encoded data
        })
      );
    });

    test("should handle incoming messages", async () => {
      await transport.connect();
      
      const messagePromise = new Promise<HAIPMessage>((resolve) => {
        transport.onMessage((message) => resolve(message));
      });

      const testMessage = {
        id: "test-id",
        session: "test-session",
        seq: "1",
        ts: "1234567890",
        channel: "USER",
        type: "TEXT_MESSAGE_START",
        payload: { message_id: "test" }
      };

      mockEventSource.simulateMessage(JSON.stringify(testMessage));
      
      const receivedMessage = await messagePromise;
      expect(receivedMessage).toEqual(testMessage);
    });

    test("should handle custom HAIP events", async () => {
      await transport.connect();
      
      const messagePromise = new Promise<HAIPMessage>((resolve) => {
        transport.onMessage((message) => resolve(message));
      });

      const testMessage = {
        id: "test-id",
        session: "test-session",
        seq: "1",
        ts: "1234567890",
        channel: "USER",
        type: "TEXT_MESSAGE_START",
        payload: { message_id: "test" }
      };

      mockEventSource.simulateCustomEvent("haip-message", testMessage);
      
      const receivedMessage = await messagePromise;
      expect(receivedMessage).toEqual(testMessage);
    });

    test("should handle binary events", async () => {
      await transport.connect();
      
      const binaryPromise = new Promise<ArrayBuffer>((resolve) => {
        transport.onBinary((data) => resolve(data));
      });

      const testData = "SGVsbG8gV29ybGQ="; // base64 encoded "Hello World"
      mockEventSource.simulateCustomEvent("haip-binary", { data: testData });
      
      const receivedData = await binaryPromise;
      expect(new TextDecoder().decode(receivedData)).toBe("Hello World");
    });

    test("should handle error events", async () => {
      await transport.connect();
      
      const errorPromise = new Promise<Error>((resolve) => {
        transport.onError((error) => resolve(error));
      });

      mockEventSource.simulateError(new Error("SSE error"));
      
      const error = await errorPromise;
      expect(error.message).toBe("SSE error");
    });

    test("should handle HTTP errors", async () => {
      mockFetch.mockRejectedValue(new Error("HTTP error"));

      const errorPromise = new Promise<Error>((resolve) => {
        transport.onError((error) => resolve(error));
      });

      await transport.connect();
      
      const error = await errorPromise;
      expect(error.message).toBe("HTTP error");
    });
  });

  describe("HTTPStreamingTransport", () => {
    let transport: HTTPStreamingTransport;

    beforeEach(() => {
      config.type = "http-streaming";
      transport = new HTTPStreamingTransport(config);
    });

    afterEach(() => {
      transport.disconnect();
    });

    test("should connect successfully", async () => {
      const mockResponse = {
        ok: true,
        status: 200,
        body: {
          getReader: jest.fn().mockReturnValue({
            read: jest.fn().mockResolvedValue({ done: true, value: undefined }),
            releaseLock: jest.fn()
          })
        }
      };

      mockFetch.mockResolvedValue(mockResponse);

      const connectPromise = transport.connect();
      
      await connectPromise;
      
      expect(transport.isConnected()).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("ws://localhost:8080/?token=test-token&stream=true"),
        expect.objectContaining({
          method: "GET",
          headers: expect.objectContaining({
            "Authorization": "Bearer test-token",
            "Accept": "text/event-stream",
            "Cache-Control": "no-cache"
          })
        })
      );
    });

    test("should handle connection errors", async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        statusText: "Internal Server Error"
      });

      await expect(transport.connect()).rejects.toThrow("HTTP 500: Internal Server Error");
    });

    test("should handle null response body", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        body: null
      });

      await expect(transport.connect()).rejects.toThrow("Response body is null");
    });

    test("should send messages via HTTP POST", async () => {
      const mockResponse = {
        ok: true,
        status: 200,
        body: {
          getReader: jest.fn().mockReturnValue({
            read: jest.fn().mockResolvedValue({ done: true, value: undefined }),
            releaseLock: jest.fn()
          })
        }
      };

      mockFetch.mockResolvedValue(mockResponse);
      await transport.connect();

      mockFetch.mockResolvedValue({
        ok: true,
        status: 200
      });

      const message: HAIPMessage = {
        id: "test-id",
        session: "test-session",
        seq: "1",
        ts: "1234567890",
        channel: "USER",
        type: "TEXT_MESSAGE_START",
        payload: { message_id: "test" }
      };

      await transport.send(message);
      
      expect(mockFetch).toHaveBeenCalledWith(
        "ws://localhost:8080",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            "Content-Type": "application/json",
            "Authorization": "Bearer test-token",
            "X-HAIP-Message": "true"
          }),
          body: JSON.stringify(message)
        })
      );
    });

    test("should send binary data via HTTP POST", async () => {
      const mockResponse = {
        ok: true,
        status: 200,
        body: {
          getReader: jest.fn().mockReturnValue({
            read: jest.fn().mockResolvedValue({ done: true, value: undefined }),
            releaseLock: jest.fn()
          })
        }
      };

      mockFetch.mockResolvedValue(mockResponse);
      await transport.connect();

      mockFetch.mockResolvedValue({
        ok: true,
        status: 200
      });

      const data = new ArrayBuffer(8);
      await transport.sendBinary(data);
      
      expect(mockFetch).toHaveBeenCalledWith(
        "ws://localhost:8080",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            "Content-Type": "application/octet-stream",
            "Authorization": "Bearer test-token",
            "X-HAIP-Binary": "true"
          }),
          body: expect.any(String) // base64 encoded data
        })
      );
    });

    test("should process streaming data", async () => {
      const mockReader = {
        read: jest.fn()
          .mockResolvedValueOnce({ done: false, value: new TextEncoder().encode("data: {\"id\":\"test\"}\n\n") })
          .mockResolvedValueOnce({ done: false, value: new TextEncoder().encode("event: haip-message\n") })
          .mockResolvedValueOnce({ done: true, value: undefined }),
        releaseLock: jest.fn()
      };

      const mockResponse = {
        ok: true,
        status: 200,
        body: {
          getReader: jest.fn().mockReturnValue(mockReader)
        }
      };

      mockFetch.mockResolvedValue(mockResponse);

      const messagePromise = new Promise<HAIPMessage>((resolve) => {
        transport.onMessage((message) => resolve(message));
      });

      await transport.connect();
      
      const receivedMessage = await messagePromise;
      expect(receivedMessage.id).toBe("test");
    });

    test("should handle stream end", async () => {
      const mockReader = {
        read: jest.fn()
          .mockResolvedValueOnce({ done: false, value: new TextEncoder().encode("data: [DONE]\n\n") })
          .mockResolvedValueOnce({ done: true, value: undefined }),
        releaseLock: jest.fn()
      };

      const mockResponse = {
        ok: true,
        status: 200,
        body: {
          getReader: jest.fn().mockReturnValue(mockReader)
        }
      };

      mockFetch.mockResolvedValue(mockResponse);

      const disconnectPromise = new Promise<string>((resolve) => {
        transport.onDisconnect((reason) => resolve(reason));
      });

      await transport.connect();
      
      const reason = await disconnectPromise;
      expect(reason).toBe("Stream ended");
    });

    test("should handle stream errors", async () => {
      const mockReader = {
        read: jest.fn().mockRejectedValue(new Error("Stream error")),
        releaseLock: jest.fn()
      };

      const mockResponse = {
        ok: true,
        status: 200,
        body: {
          getReader: jest.fn().mockReturnValue(mockReader)
        }
      };

      mockFetch.mockResolvedValue(mockResponse);

      const errorPromise = new Promise<Error>((resolve) => {
        transport.onError((error) => resolve(error));
      });

      await transport.connect();
      
      const error = await errorPromise;
      expect(error.message).toBe("Stream error");
    });

    test("should handle abort signal", async () => {
      const mockReader = {
        read: jest.fn().mockRejectedValue({ name: "AbortError" }),
        releaseLock: jest.fn()
      };

      const mockResponse = {
        ok: true,
        status: 200,
        body: {
          getReader: jest.fn().mockReturnValue(mockReader)
        }
      };

      mockFetch.mockResolvedValue(mockResponse);

      await transport.connect();
      await transport.disconnect();
      
      // Should not throw an error for AbortError
      expect(mockReader.releaseLock).toHaveBeenCalled();
    });
  });

  describe("Transport Error Handling", () => {
    test("should handle network errors", async () => {
      mockFetch.mockRejectedValue(new Error("Network error"));

      config.type = "sse";
      const transport = new SSETransport(config);

      const errorPromise = new Promise<Error>((resolve) => {
        transport.onError((error) => resolve(error));
      });

      await expect(transport.connect()).rejects.toThrow("Network error");
      
      const error = await errorPromise;
      expect(error.message).toBe("Network error");
    });

    test("should handle reconnection attempts", async () => {
      const transport = new WebSocketTransport(config.url, config.token, config.options);
      
      // Mock WebSocket to fail connection
      const WebSocket = require("ws");
      const mockWs = new MockNodeWebSocket("ws://localhost:8080");
      WebSocket.mockImplementation(() => {
        setTimeout(() => mockWs.simulateError(new Error("Connection failed")), 10);
        return mockWs;
      });

      const errorPromise = new Promise<Error>((resolve) => {
        transport.onError((error) => resolve(error));
      });

      await expect(transport.connect()).rejects.toThrow("Connection failed");
      
      const error = await errorPromise;
      expect(error.message).toBe("Connection failed");
    });
  });
}); 
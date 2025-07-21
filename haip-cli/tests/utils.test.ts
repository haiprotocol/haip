import { HAIPCLIUtils } from "../src/utils";

describe("HAIPCLIUtils", () => {
  describe("generateId", () => {
    it("should generate unique IDs", () => {
      const id1 = HAIPCLIUtils.generateId();
      const id2 = HAIPCLIUtils.generateId();
      
      expect(id1).toBeDefined();
      expect(id2).toBeDefined();
      expect(id1).not.toBe(id2);
      expect(typeof id1).toBe("string");
    });
  });

  describe("generateSequence", () => {
    it("should generate sequence numbers", () => {
      const seq1 = HAIPCLIUtils.generateSequence();
      const seq2 = HAIPCLIUtils.generateSequence();
      
      expect(seq1).toBeDefined();
      expect(seq2).toBeDefined();
      expect(typeof seq1).toBe("string");
      expect(parseInt(seq1)).toBeGreaterThan(0);
    });
  });

  describe("formatTimestamp", () => {
    it("should format timestamps correctly", () => {
      const timestamp = HAIPCLIUtils.formatTimestamp();
      const date = new Date(timestamp);
      
      expect(timestamp).toBeDefined();
      expect(date.getTime()).toBeGreaterThan(0);
      expect(timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });
  });

  describe("validateToken", () => {
    it("should validate JWT tokens", () => {
      const validToken = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
      const invalidToken = "invalid.token.here";
      
      expect(HAIPCLIUtils.validateToken(validToken)).toBe(true);
      expect(HAIPCLIUtils.validateToken(invalidToken)).toBe(false);
    });
  });

  describe("createHandshakeMessage", () => {
    it("should create valid handshake messages", () => {
      const message = HAIPCLIUtils.createHandshakeMessage("test-session");
      
      expect(message).toBeDefined();
      expect(message.type).toBe("HAI");
      expect(message.channel).toBe("SYSTEM");
      expect(message.payload.haip_version).toBe("1.1.2");
      expect(message.payload.accept_major).toEqual([1]);
      expect(message.payload.accept_events).toBeDefined();
      expect(message.payload.capabilities).toBeDefined();
    });

    it("should create handshake messages without session", () => {
      const message = HAIPCLIUtils.createHandshakeMessage();
      
      expect(message).toBeDefined();
      expect(message.session).toBeUndefined();
    });
  });

  describe("createTextMessage", () => {
    it("should create valid text messages", () => {
      const message = HAIPCLIUtils.createTextMessage("USER", "Hello, world!", "user", "run-123");
      
      expect(message).toBeDefined();
      expect(message.type).toBe("TEXT_MESSAGE_START");
      expect(message.channel).toBe("USER");
      expect(message.payload.text).toBe("Hello, world!");
      expect(message.payload.author).toBe("user");
      expect(message.payload.run_id).toBe("run-123");
    });
  });

  describe("formatBytes", () => {
    it("should format bytes correctly", () => {
      expect(HAIPCLIUtils.formatBytes(0)).toBe("0 B");
      expect(HAIPCLIUtils.formatBytes(1024)).toBe("1 KB");
      expect(HAIPCLIUtils.formatBytes(1024 * 1024)).toBe("1 MB");
      expect(HAIPCLIUtils.formatBytes(1024 * 1024 * 1024)).toBe("1 GB");
    });
  });

  describe("parseUrl", () => {
    it("should parse URLs correctly", () => {
      const result = HAIPCLIUtils.parseUrl("ws://localhost:8080/haip");
      
      expect(result.protocol).toBe("ws:");
      expect(result.host).toBe("localhost");
      expect(result.port).toBe(8080);
      expect(result.path).toBe("/haip");
    });

    it("should handle WebSocket Secure URLs", () => {
      const result = HAIPCLIUtils.parseUrl("wss://example.com:443/haip");
      
      expect(result.protocol).toBe("wss:");
      expect(result.host).toBe("example.com");
      expect(result.port).toBe(443);
      expect(result.path).toBe("/haip");
    });

    it("should throw error for invalid URLs", () => {
      expect(() => HAIPCLIUtils.parseUrl("invalid-url")).toThrow("Invalid URL");
    });
  });

  describe("sleep", () => {
    it("should sleep for specified time", async () => {
      const start = Date.now();
      await HAIPCLIUtils.sleep(100);
      const end = Date.now();
      
      expect(end - start).toBeGreaterThanOrEqual(100);
    });
  });

  describe("retry", () => {
    it("should retry failed operations", async () => {
      let attempts = 0;
      const fn = jest.fn().mockImplementation(() => {
        attempts++;
        if (attempts < 3) {
          throw new Error("Failed");
        }
        return "success";
      });

      const result = await HAIPCLIUtils.retry(fn, 3, 10);
      
      expect(result).toBe("success");
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it("should fail after max attempts", async () => {
      const fn = jest.fn().mockRejectedValue(new Error("Always fails"));

      await expect(HAIPCLIUtils.retry(fn, 2, 10)).rejects.toThrow("Always fails");
      expect(fn).toHaveBeenCalledTimes(2);
    });
  });
}); 
import { EventEmitter } from 'events';

// Increase max listeners for tests
EventEmitter.defaultMaxListeners = 20;

// Track used ports to avoid conflicts
const usedPorts = new Set<number>();

// Declare global types
declare global {
  var testUtils: {
    generateTestToken: () => string;
    waitForEvent: (emitter: EventEmitter, event: string, timeout?: number) => Promise<any>;
    waitForCondition: (condition: () => boolean, timeout?: number) => Promise<void>;
    getAvailablePort: () => number;
    cleanupPort: (port: number) => void;
  };
}

// Global test utilities
global.testUtils = {
  generateTestToken: () => {
    const header = { alg: 'HS256', typ: 'JWT' };
    const payload = {
      userId: 'test-user',
      exp: Math.floor(Date.now() / 1000) + (24 * 60 * 60),
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
    const signature = Buffer.from('test-secret-key').toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '');
    
    return `${encodedHeader}.${encodedPayload}.${signature}`;
  },

  waitForEvent: (emitter: EventEmitter, event: string, timeout = 5000): Promise<any> => {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Timeout waiting for event: ${event}`));
      }, timeout);

      emitter.once(event, (...args) => {
        clearTimeout(timer);
        resolve(args.length === 1 ? args[0] : args);
      });
    });
  },

  waitForCondition: (condition: () => boolean, timeout = 5000): Promise<void> => {
    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      const check = () => {
        if (condition()) {
          resolve();
        } else if (Date.now() - startTime > timeout) {
          reject(new Error('Condition timeout'));
        } else {
          setTimeout(check, 10);
        }
      };
      check();
    });
  },

  getAvailablePort: (): number => {
    let port: number;
    do {
      port = Math.floor(Math.random() * 1000) + 9000;
    } while (usedPorts.has(port));
    usedPorts.add(port);
    return port;
  },

  cleanupPort: (port: number): void => {
    usedPorts.delete(port);
  }
};

// Mock console methods to reduce noise in tests
const originalConsole = { ...console };
beforeAll(() => {
  console.log = jest.fn();
  console.error = jest.fn();
  console.warn = jest.fn();
});

afterAll(() => {
  console.log = originalConsole.log;
  console.error = originalConsole.error;
  console.warn = originalConsole.warn;
  usedPorts.clear();
});

// Global cleanup after each test
afterEach(() => {
  // Give time for cleanup
  return new Promise(resolve => setTimeout(resolve, 100));
}); 
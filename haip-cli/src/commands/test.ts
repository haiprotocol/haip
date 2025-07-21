import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { HAIPConnection } from "../connection";
import { HAIPCLIConfig, HAIPCLITestOptions } from "../types";
import { HAIPCLIUtils } from "../utils";

export function createTestCommand(): Command {
  return new Command("test")
    .description("Test HAIP server connectivity and performance")
    .option("-u, --url <url>", "Server URL", "ws://localhost:8080")
    .option("-t, --transport <type>", "Transport type", "websocket")
    .option("--token <token>", "JWT authentication token")
    .option("--message-count <count>", "Number of test messages to send", "100")
    .option("--message-size <bytes>", "Size of test messages in bytes", "1024")
    .option("--delay <ms>", "Delay between messages in milliseconds", "100")
    .option("--timeout <ms>", "Test timeout in milliseconds", "30000")
    .option("--validate-responses", "Validate server responses", false)
    .option("-v, --verbose", "Enable verbose output")
    .action(async (options: any) => {
      const spinner = ora("Running HAIP server tests...").start();

      try {
        const config: HAIPCLIConfig = {
          url: options.url,
          token: options.token,
          transport: options.transport,
          verbose: options.verbose
        };

        const testOptions: HAIPCLITestOptions = {
          messageCount: parseInt(options.messageCount),
          messageSize: parseInt(options.messageSize),
          delay: parseInt(options.delay),
          timeout: parseInt(options.timeout),
          validateResponses: options.validateResponses
        };

        const results = await runTests(config, testOptions, spinner);
        displayTestResults(results);

      } catch (error) {
        spinner.fail(`Test failed: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      }
    });
}

interface TestResults {
  connectionTime: number;
  messagesSent: number;
  messagesReceived: number;
  bytesSent: number;
  bytesReceived: number;
  errors: number;
  latency: {
    min: number;
    max: number;
    avg: number;
  };
  throughput: {
    messagesPerSecond: number;
    bytesPerSecond: number;
  };
  success: boolean;
}

async function runTests(
  config: HAIPCLIConfig, 
  options: HAIPCLITestOptions, 
  spinner: any
): Promise<TestResults> {
  const connection = new HAIPConnection(config);
  const startTime = Date.now();
  const latencies: number[] = [];
  let messagesSent = 0;
  let messagesReceived = 0;
  let bytesSent = 0;
  let bytesReceived = 0;
  let errors = 0;

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      connection.disconnect();
      reject(new Error("Test timeout"));
    }, options.timeout);

    connection.on("connected", async () => {
      spinner.text = "Sending test messages...";
      
      try {
        const messageCount = options.messageCount || 100;
        const messageSize = options.messageSize || 1024;
        const delay = options.delay || 100;
        
        for (let i = 0; i < messageCount; i++) {
          const testMessage = createTestMessage(i, messageSize);
          
          connection.sendMessage(testMessage);
          messagesSent++;
          bytesSent += JSON.stringify(testMessage).length;

          if (delay > 0) {
            await HAIPCLIUtils.sleep(delay);
          }
        }

        spinner.text = "Waiting for responses...";
        
        setTimeout(() => {
          clearTimeout(timeout);
          connection.disconnect();
          
          const endTime = Date.now();
          const totalTime = endTime - startTime;
          
          const results: TestResults = {
            connectionTime: totalTime,
            messagesSent,
            messagesReceived,
            bytesSent,
            bytesReceived,
            errors,
            latency: calculateLatency(latencies),
            throughput: calculateThroughput(messagesSent, bytesSent, totalTime),
            success: errors === 0 && messagesReceived >= messagesSent * 0.9
          };
          
          resolve(results);
        }, 2000);

      } catch (error) {
        clearTimeout(timeout);
        connection.disconnect();
        reject(error);
      }
    });

    connection.on("message", (message: any) => {
      messagesReceived++;
      bytesReceived += JSON.stringify(message).length;
      
      if (options.validateResponses) {
        if (!validateResponse(message)) {
          errors++;
        }
      }
    });

    connection.on("error", (error: Error) => {
      errors++;
      if (config.verbose) {
        console.error(chalk.red(`Error: ${error.message}`));
      }
    });

    connection.on("disconnected", () => {
      clearTimeout(timeout);
    });

    connection.connect().catch(reject);
  });
}

function createTestMessage(index: number, size: number): any {
  const payload = {
    test: true,
    index,
    timestamp: Date.now(),
    data: "x".repeat(Math.max(0, size - 100))
  };

  return {
    id: HAIPCLIUtils.generateId(),
    seq: HAIPCLIUtils.generateSequence(),
    ts: HAIPCLIUtils.formatTimestamp(),
    channel: "SYSTEM",
    type: "TEXT_MESSAGE_START",
    payload
  };
}

function validateResponse(message: any): boolean {
  return message && 
         message.id && 
         message.type && 
         message.payload &&
         typeof message.ts === "string";
}

function calculateLatency(latencies: number[]): { min: number; max: number; avg: number } {
  if (latencies.length === 0) {
    return { min: 0, max: 0, avg: 0 };
  }

  const min = Math.min(...latencies);
  const max = Math.max(...latencies);
  const avg = latencies.reduce((sum, latency) => sum + latency, 0) / latencies.length;

  return { min, max, avg };
}

function calculateThroughput(messages: number, bytes: number, timeMs: number): { messagesPerSecond: number; bytesPerSecond: number } {
  const timeSeconds = timeMs / 1000;
  
  return {
    messagesPerSecond: messages / timeSeconds,
    bytesPerSecond: bytes / timeSeconds
  };
}

function displayTestResults(results: TestResults): void {
  console.log(chalk.bold("\nHAIP Server Test Results"));
  console.log(chalk.gray("─".repeat(50)));

  console.log(chalk.cyan("Connection:"));
  console.log(`  Duration: ${chalk.white(results.connectionTime)}ms`);
  console.log(`  Success: ${results.success ? chalk.green("✓") : chalk.red("✗")}`);

  console.log(chalk.cyan("\nMessages:"));
  console.log(`  Sent: ${chalk.white(results.messagesSent)}`);
  console.log(`  Received: ${chalk.white(results.messagesReceived)}`);
  console.log(`  Errors: ${chalk.white(results.errors)}`);

  console.log(chalk.cyan("\nData Transfer:"));
  console.log(`  Sent: ${chalk.white(HAIPCLIUtils.formatBytes(results.bytesSent))}`);
  console.log(`  Received: ${chalk.white(HAIPCLIUtils.formatBytes(results.bytesReceived))}`);

  console.log(chalk.cyan("\nLatency:"));
  console.log(`  Min: ${chalk.white(results.latency.min)}ms`);
  console.log(`  Max: ${chalk.white(results.latency.max)}ms`);
  console.log(`  Avg: ${chalk.white(results.latency.avg.toFixed(2))}ms`);

  console.log(chalk.cyan("\nThroughput:"));
  console.log(`  Messages/sec: ${chalk.white(results.throughput.messagesPerSecond.toFixed(2))}`);
  console.log(`  Bytes/sec: ${chalk.white(HAIPCLIUtils.formatBytes(results.throughput.bytesPerSecond))}`);

  console.log(chalk.gray("\n─".repeat(50)));
  
  if (results.success) {
    console.log(chalk.green("✓ All tests passed!"));
  } else {
    console.log(chalk.red("✗ Some tests failed"));
    process.exit(1);
  }
} 
import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { HAIPConnection } from "../connection";
import { HAIPCLIConfig } from "../types";
import { HAIPCLIUtils } from "../utils";

export function createConnectCommand(): Command {
  const command = new Command("connect")
    .description("Connect to a HAIP server")
    .argument("<url>", "Server URL (e.g., ws://localhost:8080)")
    .option("-t, --transport <type>", "Transport type (websocket, sse, http-streaming)", "websocket")
    .option("--token <token>", "JWT authentication token")
    .option("--timeout <ms>", "Connection timeout in milliseconds", "10000")
    .option("--reconnect-attempts <count>", "Maximum reconnection attempts", "3")
    .option("--reconnect-delay <ms>", "Base reconnection delay in milliseconds", "1000")
    .option("-v, --verbose", "Enable verbose output")
    .action(async (url: string, options: any) => {
      const spinner = ora("Connecting to HAIP server...").start();

      try {
        const config: HAIPCLIConfig = {
          url,
          token: options.token,
          transport: options.transport,
          verbose: options.verbose,
          timeout: parseInt(options.timeout),
          reconnectAttempts: parseInt(options.reconnectAttempts),
          reconnectDelay: parseInt(options.reconnectDelay)
        };

        if (config.token && !HAIPCLIUtils.validateToken(config.token)) {
          spinner.fail("Invalid JWT token");
          process.exit(1);
        }

        const connection = new HAIPConnection(config);

        connection.on("connected", () => {
          spinner.succeed(`Connected to ${chalk.cyan(url)} via ${chalk.green(config.transport)}`);
          
          if (config.verbose) {
            console.log(chalk.gray("Connection details:"));
            console.log(chalk.gray(`  URL: ${config.url}`));
            console.log(chalk.gray(`  Transport: ${config.transport}`));
            console.log(chalk.gray(`  Session ID: ${connection.getSessionId() || "None"}`));
          }
        });

        connection.on("disconnected", (reason: string) => {
          console.log(chalk.yellow(`Disconnected: ${reason}`));
        });

        connection.on("error", (error: Error) => {
          console.error(chalk.red(`Connection error: ${error.message}`));
        });

        connection.on("message", (message: any) => {
          if (config.verbose) {
            console.log(chalk.gray("Received message:"));
            console.log(HAIPCLIUtils.formatMessage(message));
          }
        });

        await connection.connect();

        const state = connection.getConnectionState();
        console.log(chalk.green("✓ Connection established successfully"));

        if (config.verbose) {
          console.log(chalk.gray("\nConnection state:"));
          console.log(chalk.gray(`  Connected: ${state.connected}`));
          console.log(chalk.gray(`  Transport: ${state.transport}`));
          console.log(chalk.gray(`  Last Activity: ${state.lastActivity.toISOString()}`));
          console.log(chalk.gray(`  Reconnect Attempts: ${state.reconnectAttempts}`));
        }

        process.on("SIGINT", async () => {
          console.log(chalk.yellow("\nDisconnecting..."));
          await connection.disconnect();
          process.exit(0);
        });

        process.on("SIGTERM", async () => {
          console.log(chalk.yellow("\nDisconnecting..."));
          await connection.disconnect();
          process.exit(0);
        });

      } catch (error) {
        spinner.fail(`Failed to connect: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      }
    });

  return command;
} 
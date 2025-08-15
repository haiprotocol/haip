import { Command } from "commander";
import ora from "ora";
import { createHAIPClient } from "@haip/sdk";
import * as readline from "readline";

export function createChatCommand(): Command {
    const command = new Command("chat")
        .description("Message a HAIP server")
        .option("--tool <tool>, -t <tool>", "Tool name (e.g., echo, calculator)", "echo")
        .option("--url <url>", "Server URL (e.g., ws://localhost:8080)", "ws://localhost:8080")
        /*.option(
            "-t, --transport <type>",
            "Transport type (websocket, sse, http-streaming)",
            "websocket"
        )
        .option("--token <token>", "JWT authentication token")
        .option("--timeout <ms>", "Connection timeout in milliseconds", "10000")*/
        .option("--token <token>", "Authentication token")
        .option("--reconnect-attempts <count>", "Maximum reconnection attempts", "3")
        .option("--reconnect-delay <ms>", "Base reconnection delay in milliseconds", "1000")
        .option("-v, --verbose", "Enable verbose output")
        .action(async (options: any) => {
            const spinner = ora("Connecting to HAIP server...").start();

            try {
                const client = createHAIPClient({
                    url: options.url,
                    reconnectAttempts: options.reconnectAttempts,
                    reconnectDelay: options.reconnectDelay,
                });

                client.authenticate(() => {
                    return {
                        token: options.token || "Bearer TOKEN",
                    };
                });

                await client.connect();

                console.log(options);
                const transaction = await client.startTransaction(options.tool, {});
                spinner.succeed("Transaction started...");

                transaction.on("message", (message: any) => {
                    console.log("🤖 Agent:", message.payload);
                });

                process.on("SIGINT", async () => {
                    //await transaction.close();
                    process.exit(0);
                });

                process.on("SIGTERM", async () => {
                    //await transaction.close();
                    process.exit(0);
                });

                const rl = readline.createInterface({
                    input: process.stdin,
                    output: process.stdout,
                    prompt: "You: ",
                });

                rl.prompt();

                rl.on("line", line => {
                    transaction.sendTextMessage(line.trim());
                    rl.prompt();
                });

                rl.on("close", () => {
                    process.exit(0);
                });
            } catch (error) {
                spinner.fail(
                    `Failed to connect: ${error instanceof Error ? error.message : String(error)}`
                );
                process.exit(1);
            }
            return;
        });

    return command;
}

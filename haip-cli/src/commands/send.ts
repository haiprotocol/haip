import { Command } from "commander";
import chalk from "chalk";
import { HAIPConnection } from "../connection";
import { HAIPCLIConfig } from "haip";
import { HAIPCLIUtils } from "../utils";

export function createSendCommand(): Command {
    const command = new Command("send")
        .description("Send messages to a HAIP server")
        .addCommand(createSendTextCommand())
        .addCommand(createSendToolCommand())
        .addCommand(createSendRunCommand());

    return command;
}

function createSendTextCommand(): Command {
    return new Command("text")
        .description("Send a text message")
        .argument("<message>", "Message content")
        .option("-u, --url <url>", "Server URL", "ws://localhost:8080")
        .option("-t, --transport <type>", "Transport type", "websocket")
        .option("--token <token>", "JWT authentication token")
        .option("-c, --channel <channel>", "Message channel", "USER")
        .option("--author <author>", "Message author")
        .option("--run-id <id>", "Run ID")
        .option("--thread-id <id>", "Thread ID")
        .option("-v, --verbose", "Enable verbose output")
        .action(async (message: string, options: any) => {
            try {
                const config: HAIPCLIConfig = {
                    url: options.url,
                    token: options.token,
                    transport: options.transport,
                    verbose: options.verbose,
                };

                const connection = new HAIPConnection(config);

                connection.on("connected", async () => {
                    try {
                        const textMessage = HAIPCLIUtils.createTextMessage(
                            options.channel,
                            message,
                            options.author,
                            options.runId
                        );

                        if (options.threadId) {
                            textMessage.payload.thread_id = options.threadId;
                        }

                        connection.sendMessage(textMessage);

                        console.log(chalk.green("✓ Message sent successfully"));
                        console.log(chalk.gray(`  Channel: ${options.channel}`));
                        console.log(chalk.gray(`  Content: ${message}`));
                        console.log(chalk.gray(`  Message ID: ${textMessage.id}`));

                        if (options.verbose) {
                            console.log(chalk.gray("\nMessage details:"));
                            console.log(HAIPCLIUtils.formatMessage(textMessage));
                        }

                        await connection.disconnect();
                        process.exit(0);
                    } catch (error) {
                        console.error(
                            chalk.red(
                                `Failed to send message: ${error instanceof Error ? error.message : String(error)}`
                            )
                        );
                        await connection.disconnect();
                        process.exit(1);
                    }
                });

                connection.on("error", (error: Error) => {
                    console.error(chalk.red(`Connection error: ${error.message}`));
                    process.exit(1);
                });

                await connection.connect();
            } catch (error) {
                console.error(
                    chalk.red(
                        `Failed to connect: ${error instanceof Error ? error.message : String(error)}`
                    )
                );
                process.exit(1);
            }
        });
}

function createSendToolCommand(): Command {
    return new Command("tool")
        .description("Call a tool")
        .argument("<tool>", "Tool name")
        .argument("[params...]", "Tool parameters (key=value format)")
        .option("-u, --url <url>", "Server URL", "ws://localhost:8080")
        .option("-t, --transport <type>", "Transport type", "websocket")
        .option("--token <token>", "JWT authentication token")
        .option("-c, --channel <channel>", "Message channel", "AGENT")
        .option("--run-id <id>", "Run ID")
        .option("--thread-id <id>", "Thread ID")
        .option("-v, --verbose", "Enable verbose output")
        .action(async (tool: string, params: string[], options: any) => {
            try {
                const config: HAIPCLIConfig = {
                    url: options.url,
                    token: options.token,
                    transport: options.transport,
                    verbose: options.verbose,
                };

                const toolParams: Record<string, any> = {};

                for (const param of params) {
                    const [key, value] = param.split("=");
                    if (key && value) {
                        toolParams[key] = value;
                    }
                }

                const connection = new HAIPConnection(config);

                connection.on("connected", async () => {
                    try {
                        const toolMessage = HAIPCLIUtils.createToolCallMessage(
                            options.channel,
                            tool,
                            toolParams,
                            options.runId
                        );

                        if (options.threadId) {
                            toolMessage.payload.thread_id = options.threadId;
                        }

                        connection.sendMessage(toolMessage);

                        console.log(chalk.green("✓ Tool call sent successfully"));
                        console.log(chalk.gray(`  Tool: ${tool}`));
                        console.log(chalk.gray(`  Channel: ${options.channel}`));
                        console.log(chalk.gray(`  Parameters: ${JSON.stringify(toolParams)}`));
                        console.log(chalk.gray(`  Call ID: ${toolMessage.id}`));

                        if (options.verbose) {
                            console.log(chalk.gray("\nTool call details:"));
                            console.log(HAIPCLIUtils.formatMessage(toolMessage));
                        }

                        await connection.disconnect();
                        process.exit(0);
                    } catch (error) {
                        console.error(
                            chalk.red(
                                `Failed to send tool call: ${error instanceof Error ? error.message : String(error)}`
                            )
                        );
                        await connection.disconnect();
                        process.exit(1);
                    }
                });

                connection.on("error", (error: Error) => {
                    console.error(chalk.red(`Connection error: ${error.message}`));
                    process.exit(1);
                });

                await connection.connect();
            } catch (error) {
                console.error(
                    chalk.red(
                        `Failed to connect: ${error instanceof Error ? error.message : String(error)}`
                    )
                );
                process.exit(1);
            }
        });
}

function createSendRunCommand(): Command {
    return new Command("run")
        .description("Start a new run")
        .option("-u, --url <url>", "Server URL", "ws://localhost:8080")
        .option("-t, --transport <type>", "Transport type", "websocket")
        .option("--token <token>", "JWT authentication token")
        .option("--thread-id <id>", "Thread ID")
        .option("--metadata <json>", "Run metadata (JSON string)")
        .option("-v, --verbose", "Enable verbose output")
        .action(async (options: any) => {
            try {
                const config: HAIPCLIConfig = {
                    url: options.url,
                    token: options.token,
                    transport: options.transport,
                    verbose: options.verbose,
                };

                let metadata: Record<string, any> = {};
                if (options.metadata) {
                    try {
                        metadata = JSON.parse(options.metadata);
                    } catch (error) {
                        console.error(chalk.red("Invalid metadata JSON format"));
                        process.exit(1);
                    }
                }

                const connection = new HAIPConnection(config);

                connection.on("connected", async () => {
                    try {
                        const runMessage = HAIPCLIUtils.createRunStartMessage(
                            options.threadId,
                            metadata
                        );
                        connection.sendMessage(runMessage);

                        console.log(chalk.green("✓ Run started successfully"));
                        console.log(chalk.gray(`  Run ID: ${runMessage.id}`));
                        if (options.threadId) {
                            console.log(chalk.gray(`  Thread ID: ${options.threadId}`));
                        }
                        if (Object.keys(metadata).length > 0) {
                            console.log(chalk.gray(`  Metadata: ${JSON.stringify(metadata)}`));
                        }

                        if (options.verbose) {
                            console.log(chalk.gray("\nRun start details:"));
                            console.log(HAIPCLIUtils.formatMessage(runMessage));
                        }

                        await connection.disconnect();
                        process.exit(0);
                    } catch (error) {
                        console.error(
                            chalk.red(
                                `Failed to start run: ${error instanceof Error ? error.message : String(error)}`
                            )
                        );
                        await connection.disconnect();
                        process.exit(1);
                    }
                });

                connection.on("error", (error: Error) => {
                    console.error(chalk.red(`Connection error: ${error.message}`));
                    process.exit(1);
                });

                await connection.connect();
            } catch (error) {
                console.error(
                    chalk.red(
                        `Failed to connect: ${error instanceof Error ? error.message : String(error)}`
                    )
                );
                process.exit(1);
            }
        });
}

import { Command } from "commander";
import chalk from "chalk";
import { HAIPConnection } from "../connection";
import { HAIPCLIConfig, HAIPCLIMonitorOptions } from "haip";

export function createMonitorCommand(): Command {
    return new Command("monitor")
        .description("Monitor HAIP server events")
        .option("-u, --url <url>", "Server URL", "ws://localhost:8080")
        .option("-t, --transport <type>", "Transport type", "websocket")
        .option("--token <token>", "JWT authentication token")
        .option("--show-timestamps", "Show message timestamps", true)
        .option("--show-metadata", "Show message metadata", false)
        .option("--filter-types <types>", "Filter by message types (comma-separated)")
        .option("--filter-channels <channels>", "Filter by channels (comma-separated)")
        .option("--max-lines <count>", "Maximum lines to display", "1000")
        .option("--follow", "Follow new messages", false)
        .option("-v, --verbose", "Enable verbose output")
        .action(async (options: any) => {
            try {
                const config: HAIPCLIConfig = {
                    url: options.url,
                    token: options.token,
                    transport: options.transport,
                    verbose: options.verbose,
                };

                const monitorOptions: HAIPCLIMonitorOptions = {
                    showTimestamps: options.showTimestamps,
                    showMetadata: options.showMetadata,
                    filterTypes: options.filterTypes ? options.filterTypes.split(",") : undefined,
                    filterChannels: options.filterChannels
                        ? options.filterChannels.split(",")
                        : undefined,
                    maxLines: parseInt(options.maxLines),
                    follow: options.follow,
                };

                const connection = new HAIPConnection(config);
                let messageCount = 0;

                connection.on("connected", () => {
                    console.log(chalk.green(`✓ Monitoring ${config.url} via ${config.transport}`));
                    console.log(chalk.gray("Press Ctrl+C to stop monitoring\n"));
                });

                connection.on("disconnected", (reason: string) => {
                    console.log(chalk.yellow(`\nDisconnected: ${reason}`));
                    if (!options.follow) {
                        process.exit(0);
                    }
                });

                connection.on("error", (error: Error) => {
                    console.error(chalk.red(`Connection error: ${error.message}`));
                    if (!options.follow) {
                        process.exit(1);
                    }
                });

                connection.on("message", (message: any) => {
                    messageCount++;

                    if (monitorOptions.maxLines && messageCount > monitorOptions.maxLines) {
                        if (!options.follow) {
                            console.log(
                                chalk.yellow(
                                    `\nReached maximum lines (${monitorOptions.maxLines}). Stopping.`
                                )
                            );
                            connection.disconnect().then(() => process.exit(0));
                            return;
                        }
                    }

                    if (shouldDisplayMessage(message, monitorOptions)) {
                        displayMessage(message, monitorOptions);
                    }
                });

                connection.on("ping", () => {
                    if (options.verbose) {
                        console.log(chalk.gray("PING"));
                    }
                });

                connection.on("pong", () => {
                    if (options.verbose) {
                        console.log(chalk.gray("PONG"));
                    }
                });

                await connection.connect();

                process.on("SIGINT", async () => {
                    console.log(chalk.yellow("\nStopping monitor..."));
                    await connection.disconnect();
                    process.exit(0);
                });

                process.on("SIGTERM", async () => {
                    console.log(chalk.yellow("\nStopping monitor..."));
                    await connection.disconnect();
                    process.exit(0);
                });
            } catch (error) {
                console.error(
                    chalk.red(
                        `Failed to start monitoring: ${error instanceof Error ? error.message : String(error)}`
                    )
                );
                process.exit(1);
            }
        });
}

function shouldDisplayMessage(message: any, options: HAIPCLIMonitorOptions): boolean {
    if (options.filterTypes && !options.filterTypes.includes(message.type)) {
        return false;
    }

    if (options.filterChannels && !options.filterChannels.includes(message.channel)) {
        return false;
    }

    return true;
}

function displayMessage(message: any, options: HAIPCLIMonitorOptions): void {
    const timestamp = options.showTimestamps
        ? chalk.gray(`[${new Date(parseInt(message.ts)).toISOString()}] `)
        : "";

    const channel = chalk.blue(message.channel);
    const type = chalk.green(message.type);
    const id = chalk.cyan(message.id);

    let output = `${timestamp}${channel} ${type} ${id}`;

    if (options.showMetadata) {
        const metadata = {
            session: message.session,
            seq: message.seq,
            bin_len: message.bin_len,
            bin_mime: message.bin_mime,
        };

        const metadataStr = Object.entries(metadata)
            .filter(([_, value]) => value !== undefined)
            .map(([key, value]) => `${key}=${value}`)
            .join(" ");

        if (metadataStr) {
            output += ` ${chalk.gray(metadataStr)}`;
        }
    }

    console.log(output);

    if (message.payload && Object.keys(message.payload).length > 0) {
        const payloadStr = JSON.stringify(message.payload, null, 2);
        const lines = payloadStr.split("\n");

        for (const line of lines) {
            console.log(chalk.gray(`  ${line}`));
        }
    }

    console.log();
}

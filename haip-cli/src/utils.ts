import { v4 as uuidv4 } from "uuid";
import chalk from "chalk";
import { HAIPMessage, HAIPCLIOutput, HAIPCLIStats, HAIPChannel } from "haip";

export class HAIPCLIUtils {
    static generateId(): string {
        return uuidv4();
    }

    static generateSequence(): string {
        return Date.now().toString();
    }

    static formatTimestamp(date: Date = new Date()): string {
        return date.toISOString();
    }

    static formatMessage(message: HAIPMessage): string {
        const timestamp = new Date(parseInt(message.ts)).toISOString();
        const channel = chalk.blue(message.channel);
        const type = chalk.green(message.type);
        const payload = JSON.stringify(message.payload, null, 2);

        return `${timestamp} [${channel}] ${type}\n${payload}`;
    }

    static formatOutput(output: HAIPCLIOutput): string {
        const timestamp = output.timestamp.toISOString();
        const type = this.getTypeColour(output.type);
        const message = output.message;

        let formatted = `${timestamp} ${type} ${message}`;

        if (output.data) {
            formatted += `\n${JSON.stringify(output.data, null, 2)}`;
        }

        return formatted;
    }

    static getTypeColour(type: HAIPCLIOutput["type"]): string {
        switch (type) {
            case "info":
                return chalk.blue("INFO");
            case "success":
                return chalk.green("SUCCESS");
            case "warning":
                return chalk.yellow("WARNING");
            case "error":
                return chalk.red("ERROR");
            case "debug":
                return chalk.gray("DEBUG");
            default:
                return chalk.white("INFO");
        }
    }

    static formatStats(stats: HAIPCLIStats): string {
        const connectionTime = Math.floor((Date.now() - stats.connectionTime) / 1000);

        return `
${chalk.bold("HAIP CLI Statistics")}
${chalk.gray("─".repeat(40))}
Messages Sent:     ${chalk.cyan(stats.messagesSent)}
Messages Received: ${chalk.cyan(stats.messagesReceived)}
Bytes Sent:        ${chalk.cyan(this.formatBytes(stats.bytesSent))}
Bytes Received:    ${chalk.cyan(this.formatBytes(stats.bytesReceived))}
Connection Time:   ${chalk.cyan(connectionTime)}s
Reconnect Attempts: ${chalk.cyan(stats.reconnectAttempts)}
Errors:           ${chalk.red(stats.errors)}
`;
    }

    static formatBytes(bytes: number): string {
        if (bytes === 0) return "0 B";

        const k = 1024;
        const sizes = ["B", "KB", "MB", "GB"];
        const i = Math.floor(Math.log(bytes) / Math.log(k));

        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
    }

    static parseUrl(url: string): { protocol: string; host: string; port: number; path: string } {
        try {
            const urlObj = new URL(url);
            return {
                protocol: urlObj.protocol,
                host: urlObj.hostname,
                port: parseInt(urlObj.port) || (urlObj.protocol === "wss:" ? 443 : 80),
                path: urlObj.pathname,
            };
        } catch (error) {
            throw new Error(`Invalid URL: ${url}`);
        }
    }

    static validateToken(token: string): boolean {
        try {
            const parts = token.split(".");
            if (parts.length !== 3) {
                return false;
            }

            const payload = JSON.parse(Buffer.from(parts[1] || "", "base64").toString());
            const now = Math.floor(Date.now() / 1000);

            if (payload.exp && payload.exp < now) {
                return false;
            }

            return true;
        } catch {
            return false;
        }
    }

    static createHandshakeMessage(sessionId?: string): HAIPMessage {
        const message: HAIPMessage = {
            id: this.generateId(),
            session: sessionId || "null",
            transaction: null,
            seq: this.generateSequence(),
            ts: this.formatTimestamp(),
            channel: "SYSTEM",
            type: "HAI",
            payload: {
                haip_version: "1.1.2",
                accept_major: [1],
                accept_events: [
                    "HAI",
                    "RUN_STARTED",
                    "RUN_FINISHED",
                    "RUN_CANCEL",
                    "RUN_ERROR",
                    "PING",
                    "PONG",
                    "REPLAY_REQUEST",
                    "MESSAGE_START",
                    "MESSAGE_PART",
                    "MESSAGE_END",
                    "AUDIO_CHUNK",
                    "TOOL_CALL",
                    "TOOL_UPDATE",
                    "TOOL_DONE",
                    "TOOL_CANCEL",
                    "TOOL_LIST",
                    "TOOL_SCHEMA",
                    "ERROR",
                    "FLOW_UPDATE",
                    "PAUSE_CHANNEL",
                    "RESUME_CHANNEL",
                ],
                capabilities: {
                    binary_frames: true,
                    flow_control: {
                        initial_credit_messages: 32,
                        initial_credit_bytes: 262144,
                    },
                },
            },
        };

        if (sessionId) {
            message.session = sessionId;
        }

        return message;
    }

    static createTextMessage(
        channel: HAIPChannel,
        text: string,
        author?: string,
        runId?: string,
        sessionId?: string
    ): HAIPMessage {
        return {
            id: this.generateId(),
            session: sessionId || "null",
            transaction: null,
            seq: this.generateSequence(),
            ts: this.formatTimestamp(),
            channel,
            type: "MESSAGE_START",
            payload: {
                text,
                author,
                run_id: runId,
            },
        };
    }

    /*

    static createRunStartMessage(threadId?: string, metadata?: Record<string, any>): HAIPMessage {
        return {
            id: this.generateId(),
            seq: this.generateSequence(),
            ts: this.formatTimestamp(),
            channel: "SYSTEM",
            type: "RUN_STARTED",
            payload: {
                thread_id: threadId,
                metadata,
            },
        };
    }

    static createToolCallMessage(
        channel: string,
        tool: string,
        params: Record<string, any>,
        runId?: string
    ): HAIPMessage {
        /*return {
            id: this.generateId(),
            seq: this.generateSequence(),
            ts: this.formatTimestamp(),
            channel,
            type: "TOOL_CALL",
            payload: {
                tool,
                params,
                run_id: runId,
            },
        };
    }*/

    static createPingMessage(): HAIPMessage {
        return {
            id: this.generateId(),
            session: "null",
            transaction: null,
            seq: this.generateSequence(),
            ts: this.formatTimestamp(),
            channel: "SYSTEM",
            type: "PING",
            payload: {},
        };
    }

    static sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    static retry<T>(
        fn: () => Promise<T>,
        maxAttempts: number = 3,
        delay: number = 1000
    ): Promise<T> {
        return new Promise((resolve, reject) => {
            let attempts = 0;

            const attempt = async () => {
                try {
                    attempts++;
                    const result = await fn();
                    resolve(result);
                } catch (error) {
                    if (attempts >= maxAttempts) {
                        reject(error);
                    } else {
                        setTimeout(attempt, delay * attempts);
                    }
                }
            };

            attempt();
        });
    }

    static debounce<T extends (...args: any[]) => any>(
        func: T,
        wait: number
    ): (...args: Parameters<T>) => void {
        let timeout: NodeJS.Timeout;

        return (...args: Parameters<T>) => {
            clearTimeout(timeout);
            timeout = setTimeout(() => func(...args), wait);
        };
    }

    static throttle<T extends (...args: any[]) => any>(
        func: T,
        limit: number
    ): (...args: Parameters<T>) => void {
        let inThrottle: boolean;

        return (...args: Parameters<T>) => {
            if (!inThrottle) {
                func(...args);
                inThrottle = true;
                setTimeout(() => (inThrottle = false), limit);
            }
        };
    }
}

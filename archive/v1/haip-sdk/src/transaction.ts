import EventEmitter from "events";
import {
    HAIPConnectionConfig,
    HAIPMessage,
    HAIPMessageOptions,
    HAIPTransaction,
    HAIPTransactionData,
} from "haip";

export class HaipTransaction extends EventEmitter implements HAIPTransaction {
    private state: HAIPTransactionData;

    constructor(id: string, toolName: string, toolParams?: Record<string, any>) {
        super();
        // On construction we are setting a temporary ID.
        // This ID will be replaced with the actual transaction ID once the transaction starts.
        this.state = {
            id: id,
            status: "pending",
            toolName: toolName,
            replayWindow: [],
            toolParams: toolParams || {},
        };
    }

    get id(): string {
        return this.state.id;
    }

    get toolName(): string {
        return this.state.toolName;
    }

    // Allow reseting the ID when we have the actual transaction ID.
    setId(id: string): void {
        if (this.state.status === "pending") {
            this.state.id = id;
            this.state.status = "started";
            this.emit("started");
        } else {
            throw new Error("Cannot reset ID after transaction has started.");
        }
    }

    handleMessage(message: HAIPMessage): void {
        if (message.type === "MESSAGE") {
            this.emit("message", message);
        }
    }

    sendTextMessage(text: string, options?: HAIPMessageOptions) {
        this.emit("sendTextMessage", {
            text: text,
            options: options || {},
        });
    }

    async close(): Promise<void> {
        this.emit("close");
    }

    private updateReplayWindow(message: HAIPMessage, windowSize = 1000, windowTime = 300000): void {
        this.state.replayWindow.push(message);

        const now = Date.now();

        for (const msg of this.state.replayWindow) {
            const messageTime = parseInt(msg.ts);
            if (this.state.replayWindow.length > windowSize || now - messageTime > windowTime) {
                this.state.replayWindow.shift();
            }
        }
    }

    addToReplayWindow(message: HAIPMessage, config?: HAIPConnectionConfig): void {
        this.updateReplayWindow(message, config?.replayWindowSize, config?.replayWindowSize);
    }

    *getReplayWindow(fromSeq?: string, toSeq?: string): Generator<HAIPMessage, void, unknown> {
        for (const msg of this.state.replayWindow.values()) {
            yield msg;
        }
    }
}

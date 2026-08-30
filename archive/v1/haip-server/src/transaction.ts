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
        this.state = {
            id: id,
            status: "started",
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

    handleMessage(message: HAIPMessage): void {}

    sendTextMessage(text: string, options?: HAIPMessageOptions) {}

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

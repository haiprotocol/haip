import { createHAIPClient } from "../src/index";

async function main() {
    // Create client
    const client = createHAIPClient({
        url: "ws://localhost:8080", //,
        //transport: "websocket",
        //,
        //token: ""
    });

    client.authenticate(() => {
        // You should send an auth token/creds here. This can be any object.
        // You need to re-call this if your token changes.
        return {
            token: "Bearer TOKEN",
        };
    });

    try {
        // Connect to server
        await client.connect();

        const transaction = await client.startTransaction("echo", {
            //metadata: { example: 'some data' }
        });

        transaction.on("message", (message: any) => {
            console.log("🤖 Agent:", message.payload.text);
        });

        console.log("✅ Sending to transaction:", "Hello! Can you echo this?");
        transaction.sendTextMessage("Hello! Can you echo this?");
    } catch (error) {
        console.error("Error:", error);
        await client.disconnect();
    }
}

main();

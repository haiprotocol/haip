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

        transaction.sendTextMessage("Hello! Can you echo this?");
    } catch (error) {
        console.error("Error:", error);
        await client.disconnect();
    }
}

main();

/*
  // Set up event handlers
  client.on('connect', () => {
    console.log('✅ Connected to HAIP server');
  });

  client.on('disconnect', (reason) => {
    console.log('❌ Disconnected:', reason);
  });

  client.on('message', (message) => {
    if (message.type === 'TEXT_MESSAGE_START') {
      console.log('🤖 Agent:', message.payload.text);
    }
  });

  client.on('error', (error) => {
    console.error('💥 Error:', error);
  });

  try {
    // Connect to server
    await client.connect();

    // Start a run
    const runId = await client.startRun('quickstart-thread', {
      metadata: { example: 'quickstart' }
    });

    // Send a message
    const messageId = await client.sendTextMessage(
      'USER',
      'Hello! Can you help me with a question?',
      'user',
      runId
    );

    console.log('📤 Message sent:', messageId);

    // Wait a bit for response
    await new Promise(resolve => setTimeout(resolve, 5000));

    // Finish the run
    await client.finishRun(runId, 'OK', 'Quick start completed');

    // Disconnect
    await client.disconnect();
    console.log('👋 Disconnected');

  } catch (error) {
    console.error('Failed:', error);
  }
}

main();

*/

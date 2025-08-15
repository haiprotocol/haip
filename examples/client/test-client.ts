import { createHAIPClient } from "@haip/sdk";

async function main() {
  const client = createHAIPClient({
    url: "ws://localhost:8080",
  });

  client.authenticate(() => {
    // You should send a token here.
    return {
      token: "Bearer TOKEN",
    };
  });

  try {
    await client.connect();

    const transaction = await client.startTransaction("echo", {});

    transaction.on("message", (message: any) => {
      console.log("🤖 Agent:", message.payload);
    });

    console.log("✅ Sending to transaction:", "Hello! Can you echo this?");
    transaction.sendTextMessage("Hello! Can you echo this?");
  } catch (error) {
    console.error("Error:", error);
    await client.disconnect();
  }
}

main();

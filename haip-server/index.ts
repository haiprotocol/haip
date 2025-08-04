import { HAIPServer } from './src/server';


const config = {
  port: 8080,
  host: '0.0.0.0',
  jwtSecret: 'your-secret-key',
  maxConnections: 1000,
};

const server = new HAIPServer(config);
server.start();

server.registerTool({
    name: "ExampleTool",
    description: "Echo back the input",
    inputSchema: {
        type: "object",
        properties: {
            message: { type: "string" },
        },
        required: ["message"],
    },
    outputSchema: {
        type: "object",
        properties: {
            echoed: { type: "string" },
        },
    },
});

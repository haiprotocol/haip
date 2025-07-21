import { HAIPServer } from "./server";

const defaultConfig = {
    port: parseInt(process.env["PORT"] || "8080"),
    host: process.env["HOST"] || "0.0.0.0",
    jwtSecret: process.env["JWT_SECRET"] || "your-secret-key-change-in-production",
    jwtExpiresIn: process.env["JWT_EXPIRES_IN"] || "24h",
    maxConnections: parseInt(process.env["MAX_CONNECTIONS"] || "1000"),
    heartbeatInterval: parseInt(process.env["HEARTBEAT_INTERVAL"] || "30000"),
    heartbeatTimeout: parseInt(process.env["HEARTBEAT_TIMEOUT"] || "5000"),
    enableCORS: process.env["ENABLE_CORS"] !== "false",
    enableCompression: process.env["ENABLE_COMPRESSION"] !== "false",
    enableLogging: process.env["ENABLE_LOGGING"] !== "false",
};

const server = new HAIPServer(defaultConfig);

process.on("SIGINT", () => {
    console.log("Received SIGINT, shutting down gracefully...");
    server.stop();
    process.exit(0);
});

process.on("SIGTERM", () => {
    console.log("Received SIGTERM, shutting down gracefully...");
    server.stop();
    process.exit(0);
});

server.start();

export { HAIPServer };
export default server;

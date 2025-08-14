import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import fetch from "node-fetch";
import { HAIPCLIHealthCheck } from "haip";

export function createHealthCommand(): Command {
    return new Command("health")
        .description("Check HAIP server health")
        .option("-u, --url <url>", "Server URL", "http://localhost:8080")
        .option("--timeout <ms>", "Request timeout in milliseconds", "5000")
        .option("--format <format>", "Output format (text, json)", "text")
        .action(async (options: any) => {
            const spinner = ora("Checking server health...").start();

            try {
                const healthUrl = `${options.url}/health`;
                const response = await fetch(healthUrl, {
                    timeout: parseInt(options.timeout),
                });

                if (!response.ok) {
                    spinner.fail(`Health check failed: HTTP ${response.status}`);
                    process.exit(1);
                }

                const healthData: HAIPCLIHealthCheck = await response.json();
                spinner.succeed("Health check completed");

                if (options.format === "json") {
                    console.log(JSON.stringify(healthData, null, 2));
                } else {
                    displayHealthResults(healthData);
                }
            } catch (error) {
                spinner.fail(
                    `Health check failed: ${error instanceof Error ? error.message : String(error)}`
                );
                process.exit(1);
            }
        });
}

function displayHealthResults(health: HAIPCLIHealthCheck): void {
    console.log(chalk.bold("\nHAIP Server Health Status"));
    console.log(chalk.gray("─".repeat(40)));

    const statusIcon =
        health.status === "ok"
            ? chalk.green("✓")
            : health.status === "degraded"
              ? chalk.yellow("⚠")
              : chalk.red("✗");

    console.log(`Status: ${statusIcon} ${chalk.white(health.status.toUpperCase())}`);
    console.log(`Uptime: ${chalk.cyan(formatUptime(health.uptime))}`);

    console.log(chalk.cyan("\nConnections:"));
    console.log(`  Active: ${chalk.white(health.activeConnections)}`);
    console.log(`  Total: ${chalk.white(health.totalConnections)}`);

    console.log(chalk.cyan("\nErrors & Warnings:"));
    console.log(`  Errors: ${chalk.white(health.errors ?? "None")}`);
    console.log(`  Warnings: ${chalk.white(health.warnings ?? "None")}`);

    if (health.lastError) {
        console.log(`  Last Error: ${chalk.red(health.lastError)}`);
    }

    if (health.lastWarning) {
        console.log(`  Last Warning: ${chalk.yellow(health.lastWarning)}`);
    }

    console.log(chalk.gray("\n─".repeat(2)));

    if (health.status === "ok") {
        console.log(chalk.green("✓ Server is healthy"));
    } else if (health.status === "degraded") {
        console.log(chalk.yellow("⚠ Server is degraded"));
        process.exit(1);
    } else {
        console.log(chalk.red("✗ Server is unhealthy"));
        process.exit(1);
    }
}

function formatUptime(seconds: number): string {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;

    const parts = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);
    parts.push(`${secs}s`);

    return parts.join(" ");
}

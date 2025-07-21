#!/usr/bin/env node

import { Command } from "commander";
import chalk from "chalk";
import figlet from "figlet";
import { createConnectCommand } from "./commands/connect";
import { createSendCommand } from "./commands/send";
import { createMonitorCommand } from "./commands/monitor";
import { createTestCommand } from "./commands/test";
import { createHealthCommand } from "./commands/health";

const program = new Command();

program
  .name("haip")
  .description("Command-line interface for the Human-Agent Interaction Protocol (HAIP)")
  .version("1.0.0")
  .addHelpText("before", () => {
    return chalk.cyan(
      figlet.textSync("HAIP CLI", {
        font: "Standard",
        horizontalLayout: "default",
        verticalLayout: "default"
      })
    );
  });

program.addCommand(createConnectCommand());
program.addCommand(createSendCommand());
program.addCommand(createMonitorCommand());
program.addCommand(createTestCommand());
program.addCommand(createHealthCommand());

program.addCommand(
  new Command("version")
    .description("Show version information")
    .action(() => {
      console.log(chalk.cyan("HAIP CLI v1.0.0"));
      console.log(chalk.gray("Human-Agent Interaction Protocol Command Line Interface"));
      console.log(chalk.gray("https://github.com/haiprotocol/haip-cli"));
    })
);

program.addCommand(
  new Command("info")
    .description("Show system information")
    .action(() => {
      console.log(chalk.bold("HAIP CLI System Information"));
      console.log(chalk.gray("─".repeat(40)));
      console.log(`Node.js: ${chalk.cyan(process.version)}`);
      console.log(`Platform: ${chalk.cyan(process.platform)}`);
      console.log(`Architecture: ${chalk.cyan(process.arch)}`);
      console.log(`HAIP Version: ${chalk.cyan("1.1.2")}`);
      console.log(`CLI Version: ${chalk.cyan("1.0.0")}`);
    })
);

program.addCommand(
  new Command("examples")
    .description("Show usage examples")
    .action(() => {
      console.log(chalk.bold("HAIP CLI Usage Examples"));
      console.log(chalk.gray("─".repeat(50)));

      console.log(chalk.cyan("\n1. Connect to a server:"));
      console.log(chalk.gray("  haip connect ws://localhost:8080"));
      console.log(chalk.gray("  haip connect http://localhost:8080 --transport sse"));

      console.log(chalk.cyan("\n2. Send a text message:"));
      console.log(chalk.gray("  haip send text 'Hello, HAIP!'"));
      console.log(chalk.gray("  haip send text 'Hello' --channel AGENT --author bot"));

      console.log(chalk.cyan("\n3. Call a tool:"));
      console.log(chalk.gray("  haip send tool echo message='Hello World'"));
      console.log(chalk.gray("  haip send tool calculator expression='2+2'"));

      console.log(chalk.cyan("\n4. Start a run:"));
      console.log(chalk.gray("  haip send run --thread-id my-thread"));
      console.log(chalk.gray("  haip send run --metadata '{\"user\":\"alice\"}'"));

      console.log(chalk.cyan("\n5. Monitor server events:"));
      console.log(chalk.gray("  haip monitor"));
      console.log(chalk.gray("  haip monitor --filter-types TEXT_MESSAGE_START,TOOL_CALL"));
      console.log(chalk.gray("  haip monitor --follow"));

      console.log(chalk.cyan("\n6. Test server performance:"));
      console.log(chalk.gray("  haip test"));
      console.log(chalk.gray("  haip test --message-count 1000 --delay 10"));

      console.log(chalk.cyan("\n7. Check server health:"));
      console.log(chalk.gray("  haip health"));
      console.log(chalk.gray("  haip health --format json"));

      console.log(chalk.gray("\n─".repeat(50)));
      console.log(chalk.yellow("For more information, visit: https://haiprotocol.com"));
    })
);

program.parse(); 
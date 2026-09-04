#!/usr/bin/env node

const { spawn } = require("child_process");
const path = require("path");

console.log("🧪 Testing HAIP CLI...\n");

const cliPath = path.join(__dirname, "dist", "index.js");

function runCommand(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [cliPath, ...args], {
      stdio: "pipe",
      cwd: __dirname
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`Command failed with code ${code}: ${stderr}`));
      }
    });
  });
}

async function testCLI() {
  try {
    console.log("1. Testing version command...");
    const versionOutput = await runCommand(["version"]);
    console.log("✅ Version command works:");
    console.log(versionOutput);

    console.log("\n2. Testing info command...");
    const infoOutput = await runCommand(["info"]);
    console.log("✅ Info command works:");
    console.log(infoOutput);

    console.log("\n3. Testing help command...");
    const helpOutput = await runCommand(["--help"]);
    console.log("✅ Help command works (showing first few lines):");
    console.log(helpOutput.split("\n").slice(0, 20).join("\n"));

    console.log("\n4. Testing send command help...");
    const sendHelpOutput = await runCommand(["send", "--help"]);
    console.log("✅ Send command help works:");
    console.log(sendHelpOutput.split("\n").slice(0, 15).join("\n"));

    console.log("\n5. Testing monitor command help...");
    const monitorHelpOutput = await runCommand(["monitor", "--help"]);
    console.log("✅ Monitor command help works:");
    console.log(monitorHelpOutput.split("\n").slice(0, 15).join("\n"));

    console.log("\n6. Testing test command help...");
    const testHelpOutput = await runCommand(["test", "--help"]);
    console.log("✅ Test command help works:");
    console.log(testHelpOutput.split("\n").slice(0, 15).join("\n"));

    console.log("\n7. Testing health command help...");
    const healthHelpOutput = await runCommand(["health", "--help"]);
    console.log("✅ Health command help works:");
    console.log(healthHelpOutput.split("\n").slice(0, 15).join("\n"));

    console.log("\n🎉 All CLI tests passed!");
    console.log("\nThe HAIP CLI is working correctly and ready for use.");
    console.log("\nTo use it globally, run: npm link");
    console.log("Then you can use: haip --help");

  } catch (error) {
    console.error("❌ Test failed:", error.message);
    process.exit(1);
  }
}

testCLI(); 
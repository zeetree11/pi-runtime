import { appendFileSync, readFileSync } from "node:fs";

const control = "/tmp/pi-rt-fake.json";

function settings() {
  try {
    return JSON.parse(readFileSync(control, "utf8"));
  } catch {
    return { mode: "settle", delay: 0, log: "" };
  }
}

let buffer = "";
process.stdin.on("end", () => process.exit(0));
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (message.type !== "prompt") continue;
    const { mode, delay, log } = settings();
    if (log) appendFileSync(log, `${Date.now()} ${String(message.message).slice(0, 24)}\n`);
    if (mode === "exit-before-ack") process.exit(0);
    process.stdout.write(JSON.stringify({ type: "response", id: message.id, success: true, data: {} }) + "\n");
    if (mode === "exit-after-ack") process.exit(0);
    if (mode === "hang") continue;
    const wait = mode === "delay-settle" ? Number(delay ?? 1500) : 0;
    setTimeout(() => {
      process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\n");
    }, wait);
  }
});

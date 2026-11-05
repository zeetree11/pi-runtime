import { writeFileSync } from "node:fs";
import path from "node:path";
import { PiRpc } from "../src/rpc.ts";

let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` ${extra}`}`);
  ok ? pass++ : fail++;
};

const fake = path.resolve("tests/fixtures/fake-pi.mjs");
const control = "/tmp/pi-rt-fake.json";
const unhandled = [];
process.on("unhandledRejection", (error) => unhandled.push(error));

function rpc() {
  const client = new PiRpc({ cliPath: fake, cwd: process.cwd(), args: [], env: process.env });
  client.start();
  return client;
}

// Abort after the prompt is acked must reject the settle waiter, not wait out the wall clock.
{
  writeFileSync(control, JSON.stringify({ mode: "hang" }));
  const client = rpc();
  const controller = new AbortController();
  const started = Date.now();
  const pending = client.prompt("hello", 30_000, controller.signal);
  setTimeout(() => controller.abort(), 150);
  let message = "";
  try {
    await pending;
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  const elapsed = Date.now() - started;
  check("abort rejects the settle waiter", message === "aborted" && elapsed < 2_000, `${message} ${elapsed}ms`);
  await client.dispose();
}

// Child exit after the ack is the end of the prompt, not a 30 minute wait.
{
  writeFileSync(control, JSON.stringify({ mode: "exit-after-ack" }));
  const client = rpc();
  const started = Date.now();
  let message = "";
  try {
    await client.prompt("hello", 30_000);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  const elapsed = Date.now() - started;
  check("child exit rejects the settle waiter", /pi exited/.test(message) && elapsed < 2_000, `${message} ${elapsed}ms`);
  await client.dispose();
}

// Exit before the ack used to leave the settle timer running, then crash the process.
{
  writeFileSync(control, JSON.stringify({ mode: "exit-before-ack" }));
  const client = rpc();
  let message = "";
  try {
    await client.prompt("hello", 1_500);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  check("exit before ack still throws", /pi exited/.test(message), message);
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  check("settle timeout is not an unhandled rejection", unhandled.length === 0, unhandled.map(String).join(";"));
  await client.dispose();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

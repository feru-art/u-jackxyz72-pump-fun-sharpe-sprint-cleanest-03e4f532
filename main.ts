// Entrypoint for the pump.fun Sharpe sprint (agent-fun/replay/v2).
// Protocol: newline-delimited JSON on stdin (hello, batch..., done);
// exactly one reply per batch on stdout, echoing the batch seq.
// The strategy (vendor/strategy.ts, V5 hybrid parameters) is deterministic:
// input batches always produce byte-identical replies, as the harness
// requires when it executes the entry twice.

import { createInterface } from "node:readline";
import { SharpeBot, VERSIONS } from "./vendor/strategy.ts";

const bot = new SharpeBot(VERSIONS.V5);
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

function handle(line: string): void {
  const text = line.trim();
  if (!text) return;
  let msg: any;
  try {
    msg = JSON.parse(text);
  } catch {
    return; // a malformed line never produces output
  }
  switch (msg.type) {
    case "hello":
      bot.onHello(msg);
      break;
    case "batch": {
      const orders = bot.onBatch(msg);
      const reply = JSON.stringify({ type: "reply", seq: msg.seq, orders });
      process.stdout.write(reply + "\n");
      break;
    }
    case "done":
      rl.close();
      break;
    default:
      break;
  }
}

rl.on("line", handle);

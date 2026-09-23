// Terminal input for the wizard: a visible line, a hidden secret, a numbered choice.
import { createInterface } from "node:readline/promises";

const CTRL_C = "\u0003";
const DEL = "\u007f";

export const isInteractive = (): boolean => Boolean(process.stdin.isTTY && process.stdout.isTTY);

export async function ask(question: string, fallback?: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (
      await rl.question(fallback ? `${question} [${fallback}] ` : `${question} `)
    ).trim();
    return answer || fallback || "";
  } finally {
    rl.close();
  }
}

export async function confirm(question: string, fallback = false): Promise<boolean> {
  const answer = (await ask(`${question} (${fallback ? "Y/n" : "y/N"})`)).toLowerCase();
  if (answer === "") return fallback;
  return answer === "y" || answer === "yes";
}

/** Reads a line with echo off (raw mode), so the secret never lands in the terminal. */
export function askSecret(question: string): Promise<string> {
  process.stdout.write(`${question} `);
  const { stdin } = process;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let buf = "";
    const done = (err?: Error) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
      process.stdout.write("\n");
      if (err) reject(err);
      else resolve(buf.trim());
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === CTRL_C) return done(new Error("cancelled"));
        if (ch === "\r" || ch === "\n") return done();
        if (ch === DEL || ch === "\b") buf = buf.slice(0, -1);
        else if (ch >= " ") buf += ch;
      }
    };
    stdin.on("data", onData);
  });
}

/** Prints numbered options and returns the chosen index. */
export async function choose(title: string, options: string[]): Promise<number> {
  console.log(title);
  options.forEach((o, i) => console.log(`  ${String(i + 1).padStart(2)}. ${o}`));
  for (;;) {
    const n = Number(await ask(`choice [1-${options.length}]:`));
    if (Number.isInteger(n) && n >= 1 && n <= options.length) return n - 1;
  }
}

/**
 * Prints an argon2 hash for AUTH_PASSWORD_HASH. Reads the password from stdin
 * so it never lands in shell history.
 *
 *   yarn workspace @scalidraw/server hash-password
 */
import readline from "node:readline";

import { hashPassword } from "./auth/password";

const readPassword = (prompt: string) =>
  new Promise<string>((resolve) => {
    const isTTY = process.stdin.isTTY === true;
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stderr,
      terminal: isTTY,
    });

    if (isTTY) {
      // readline echoes by default; swallow everything after the prompt so the
      // password does not end up on screen (or in a scrollback buffer).
      let muted = false;
      const instance = rl as unknown as {
        _writeToOutput: (chunk: string) => void;
      };
      instance._writeToOutput = (chunk: string) => {
        if (!muted) {
          process.stderr.write(chunk);
        }
      };
      rl.question(prompt, (answer) => {
        rl.close();
        process.stderr.write("\n");
        resolve(answer.trim());
      });
      muted = true;
      return;
    }

    rl.question("", (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });

const main = async () => {
  const password = await readPassword("Password: ");

  if (password.length < 12) {
    process.stderr.write(
      "Refusing: use at least 12 characters — this is reachable from the internet.\n",
    );
    process.exit(1);
  }

  process.stderr.write("\nAdd this to server/.env:\n\n");
  process.stdout.write(`AUTH_PASSWORD_HASH=${await hashPassword(password)}\n`);
};

void main();

// Bootstrap CLI: creates (or, with --reset, re-passwords) a PraxelOps operator account.
//
//   node --experimental-strip-types scripts/create-operator.ts <username> [--reset]
//
// The password is read from PRAXELOPS_OPERATOR_PASSWORD, or prompted for (echo off) on a TTY.
// Accounts are stored in the SQLite database <data dir>/praxelops.db (PRAXELOPS_DATA_DIR, default ./.peos/data).
// node:sqlite is experimental in Node 24 and prints an ExperimentalWarning (add --no-warnings to hide it).
//
// NOTE: relative imports with explicit .ts extensions only; plain node cannot resolve "@/" aliases.
import {
  createOperator,
  getOperatorsFilePath,
  MIN_PASSWORD_LENGTH,
  OperatorExistsError,
  PasswordSchema,
  UsernameSchema,
} from "../src/lib/security/operators.ts";

function usage(): never {
  process.stderr.write(
    "Usage: node --experimental-strip-types scripts/create-operator.ts <username> [--reset]\n" +
      "  Password: set PRAXELOPS_OPERATOR_PASSWORD, or enter it at the prompt (TTY only).\n" +
      "  --reset   replace the password of an existing operator\n"
  );
  process.exit(2);
}

/** Reads one line from the TTY without echoing it. */
function promptHidden(label: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stderr.write(label);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    let value = "";
    const finish = (err?: Error) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
      process.stderr.write("\n");
      if (err) reject(err);
      else resolve(value);
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n" || ch === "\u0004") {
          finish();
          return;
        }
        if (ch === "\u0003") {
          finish(new Error("Aborted"));
          return;
        }
        if (ch === "\u007f" || ch === "\b") {
          value = value.slice(0, -1);
        } else {
          value += ch;
        }
      }
    };
    stdin.on("data", onData);
  });
}

async function readPassword(): Promise<string> {
  const fromEnv = process.env.PRAXELOPS_OPERATOR_PASSWORD;
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;

  if (!process.stdin.isTTY) {
    throw new Error("No password provided: set PRAXELOPS_OPERATOR_PASSWORD (stdin is not a terminal)");
  }
  const first = await promptHidden(`Password (min ${MIN_PASSWORD_LENGTH} chars): `);
  const second = await promptHidden("Confirm password: ");
  if (first !== second) throw new Error("Passwords do not match");
  return first;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const reset = args.includes("--reset");
  const positional = args.filter((a) => !a.startsWith("--"));
  if (positional.length !== 1 || args.some((a) => a.startsWith("--") && a !== "--reset")) usage();

  const usernameCheck = UsernameSchema.safeParse(positional[0]);
  if (!usernameCheck.success) {
    throw new Error(usernameCheck.error.issues[0]?.message ?? "Invalid username");
  }

  const password = await readPassword();
  const passwordCheck = PasswordSchema.safeParse(password);
  if (!passwordCheck.success) {
    throw new Error(passwordCheck.error.issues[0]?.message ?? "Invalid password");
  }

  const { operator, created } = await createOperator(usernameCheck.data, passwordCheck.data, { reset });
  process.stdout.write(
    `${created ? "Created" : "Reset password for"} operator '${operator.username}' (${operator.id}) in ${getOperatorsFilePath()}\n`
  );
}

main().catch((err: unknown) => {
  if (err instanceof OperatorExistsError) {
    process.stderr.write(`${err.message}\n`);
  } else {
    process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
  }
  process.exit(1);
});

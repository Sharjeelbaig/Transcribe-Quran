import { spawn } from "node:child_process";

export interface RunProcessOptions {
  cwd?: string;
  quiet?: boolean;
}

export async function runProcess(
  command: string,
  args: string[],
  options: RunProcessOptions = {},
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: options.quiet ? ["ignore", "ignore", "pipe"] : "inherit",
    });
    let stderr = "";
    if (options.quiet && child.stderr) {
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
    }
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} failed (${signal ?? `exit ${code}`})${stderr ? `\n${stderr}` : ""}`));
    });
  });
}

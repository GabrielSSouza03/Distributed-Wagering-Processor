import type { Subprocess } from "bun";
import { APP_DATABASE_URL } from "./db.js";
import { AWS_ENDPOINT_URL } from "./queues.js";

const projectRoot = new URL("../..", import.meta.url).pathname;

export interface AppProcessOptions {
  port: number;
  roles: string;
  env?: Record<string, string>;
}

/** A real `src/main.ts` process, so multi-instance and crash scenarios share nothing in memory. */
export class AppProcess {
  readonly baseUrl: string;
  private child: Subprocess | undefined;

  constructor(private readonly options: AppProcessOptions) {
    this.baseUrl = `http://127.0.0.1:${String(options.port)}`;
  }

  async start(): Promise<this> {
    if (await this.isResponding()) {
      throw new Error(
        `Port ${String(this.options.port)} is already served by another process (orphan from a previous run?)`,
      );
    }
    const output = process.env.TEST_APP_LOGS === "true" ? "inherit" : "ignore";
    this.child = Bun.spawn(["bun", "run", "src/main.ts"], {
      cwd: projectRoot,
      env: {
        ...process.env,
        PORT: String(this.options.port),
        APP_ROLES: this.options.roles,
        DATABASE_URL: APP_DATABASE_URL,
        AWS_ENDPOINT_URL,
        AWS_REGION: "us-east-1",
        AWS_ACCESS_KEY_ID: "local",
        AWS_SECRET_ACCESS_KEY: "local",
        LOG_LEVEL: "warn",
        ...this.options.env,
      },
      stdout: output,
      stderr: output,
    });
    try {
      await this.waitUntilReady();
    } catch (error) {
      await this.kill();
      throw error;
    }
    return this;
  }

  /** Simulates a crash: no shutdown hooks, no in-flight completion. */
  async kill(): Promise<void> {
    if (!this.child) return;
    this.child.kill("SIGKILL");
    await this.child.exited;
    this.child = undefined;
  }

  async stop(): Promise<void> {
    if (!this.child) return;
    const child = this.child;
    child.kill("SIGTERM");
    const exited = await Promise.race([
      child.exited.then(() => true),
      Bun.sleep(10_000).then(() => false),
    ]);
    if (!exited) child.kill("SIGKILL");
    await child.exited;
    this.child = undefined;
  }

  private async waitUntilReady(timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.child?.exitCode !== null) {
        throw new Error(`App on port ${String(this.options.port)} exited during startup`);
      }
      try {
        const response = await fetch(`${this.baseUrl}/health/ready`);
        if (response.status === 200) return;
      } catch {
        // Not listening yet.
      }
      await Bun.sleep(150);
    }
    throw new Error(`App on port ${String(this.options.port)} did not become ready`);
  }

  private async isResponding(): Promise<boolean> {
    try {
      await fetch(`${this.baseUrl}/health/live`, { signal: AbortSignal.timeout(500) });
      return true;
    } catch {
      return false;
    }
  }
}

/** All-or-nothing: if any process fails to start, the ones that did start are stopped. */
export async function startApps(options: readonly AppProcessOptions[]): Promise<AppProcess[]> {
  const apps = options.map((option) => new AppProcess(option));
  const results = await Promise.allSettled(apps.map(async (app) => app.start()));
  const failure = results.find((result) => result.status === "rejected");
  if (failure) {
    await Promise.all(apps.map(async (app) => app.stop()));
    throw failure.reason;
  }
  return apps;
}

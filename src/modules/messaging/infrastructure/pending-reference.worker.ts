import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from "@nestjs/common";
import { ReprocessPendingReference } from "../../wagering/application/reprocess-pending-reference.js";

@Injectable()
export class PendingReferenceWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(PendingReferenceWorker.name);
  private stopped = false;

  constructor(private readonly reprocess: ReprocessPendingReference) {}

  onApplicationBootstrap(): void {
    if (!roles().has("scheduler")) return;
    void this.run();
  }

  onApplicationShutdown(): void {
    this.stopped = true;
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      try {
        const count = await this.reprocess.runBatch();
        if (count === 0) await Bun.sleep(500);
      } catch (error) {
        this.logger.error({ error }, "Pending-reference batch failed");
        await Bun.sleep(1_000);
      }
    }
  }
}

function roles(): Set<string> {
  return new Set((process.env.APP_ROLES ?? "api").split(",").map((role) => role.trim()));
}

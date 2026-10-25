import { Controller, Get, ServiceUnavailableException } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { MikroORM } from "@mikro-orm/postgresql";
import { SqsService } from "./infrastructure/sqs/sqs.service.js";

@ApiTags("health")
@Controller("health")
export class HealthController {
  constructor(
    private readonly orm: MikroORM,
    private readonly sqs: SqsService,
  ) {}

  @Get("live")
  @ApiOperation({ summary: "Liveness probe" })
  live(): { status: "ok" } {
    return { status: "ok" };
  }

  @Get("ready")
  @ApiOperation({ summary: "Readiness probe (PostgreSQL and SQS)" })
  async ready(): Promise<{ status: "ok"; dependencies: { postgres: "up"; sqs: "up" } }> {
    try {
      await this.orm.em.getConnection().execute("select 1");
      await this.sqs.ensureQueue("wager-transactions.fifo");
      return { status: "ok", dependencies: { postgres: "up", sqs: "up" } };
    } catch {
      throw new ServiceUnavailableException({
        type: "https://wagering.local/problems/not-ready",
        title: "Service is not ready",
        status: 503,
      });
    }
  }
}

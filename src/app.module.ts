import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { MikroOrmModule } from "@mikro-orm/nestjs";
import { LoggerModule } from "nestjs-pino";
import mikroOrmConfig from "../mikro-orm.config.js";
import { HealthController } from "./health.controller.js";
import { FinancialModule } from "./modules/financial.module.js";
import { ProviderIdentityGuard } from "./modules/identity/provider-identity.guard.js";
import {
  NoopProviderIdentity,
  PROVIDER_IDENTITY,
} from "./modules/identity/provider-identity.port.js";

@Module({
  imports: [
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.LOG_LEVEL ?? "info",
        redact: {
          paths: [
            "req.headers.authorization",
            "req.headers.cookie",
            "req.body.money",
            "req.body.initialBalance",
          ],
          censor: "[REDACTED]",
        },
        genReqId: (request, response) => {
          const supplied = request.headers["x-correlation-id"];
          const correlationId =
            typeof supplied === "string" && supplied.length <= 128 ? supplied : crypto.randomUUID();
          response.setHeader("x-correlation-id", correlationId);
          return correlationId;
        },
      },
    }),
    MikroOrmModule.forRoot({
      ...mikroOrmConfig,
      registerRequestContext: false,
    }),
    FinancialModule,
  ],
  controllers: [HealthController],
  providers: [
    { provide: PROVIDER_IDENTITY, useClass: NoopProviderIdentity },
    { provide: APP_GUARD, useClass: ProviderIdentityGuard },
  ],
})
export class AppModule {}

import "./infrastructure/telemetry.js";
import "reflect-metadata";
import { HttpAdapterHost, NestFactory } from "@nestjs/core";
import { Logger } from "nestjs-pino";
import { AppModule } from "./app.module.js";
import { telemetrySdk } from "./infrastructure/telemetry.js";
import { ProblemDetailsFilter } from "./problem-details.filter.js";

const app = await NestFactory.create(AppModule, { bufferLogs: true });
app.useLogger(app.get(Logger));
app.useGlobalFilters(new ProblemDetailsFilter(app.get(HttpAdapterHost)));
app.enableShutdownHooks(["SIGTERM", "SIGINT"]);
app.enableCors({ origin: false });

const port = Number.parseInt(process.env.PORT ?? "3000", 10);
await app.listen(port, "0.0.0.0");

const shutdownTelemetry = async (): Promise<void> => {
  await telemetrySdk?.shutdown();
};

process.once("beforeExit", () => {
  void shutdownTelemetry();
});

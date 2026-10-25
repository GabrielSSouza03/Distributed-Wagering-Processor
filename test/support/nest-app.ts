import type { INestApplication } from "@nestjs/common";
import { HttpAdapterHost, NestFactory } from "@nestjs/core";
import { AppModule } from "../../src/app.module.js";
import { ProblemDetailsFilter } from "../../src/problem-details.filter.js";
import { APP_DATABASE_URL } from "./db.js";
import { AWS_ENDPOINT_URL } from "./queues.js";

/** In-process API wired like `src/main.ts`, including the HTTP error mapping. */
export async function startInProcessApi(port: number): Promise<INestApplication> {
  process.env.APP_ROLES = "api";
  process.env.DATABASE_URL = APP_DATABASE_URL;
  process.env.AWS_ENDPOINT_URL = AWS_ENDPOINT_URL;
  const app = await NestFactory.create(AppModule, { logger: false });
  app.useGlobalFilters(new ProblemDetailsFilter(app.get(HttpAdapterHost)));
  await app.listen(port, "127.0.0.1");
  return app;
}

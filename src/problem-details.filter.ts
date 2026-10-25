import {
  ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from "@nestjs/common";
import { HttpAdapterHost } from "@nestjs/core";
import { z } from "zod";
import { DomainError } from "./shared/domain/errors.js";
import { ApplicationError } from "./modules/wagering/application/errors.js";

interface DatabaseError {
  code?: string;
}

@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemDetailsFilter.name);

  constructor(private readonly adapterHost: HttpAdapterHost) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const { httpAdapter } = this.adapterHost;
    const context = host.switchToHttp();
    const response = context.getResponse<unknown>();
    const request = context.getRequest<{ url: string }>();
    const { status, title, detail, code } = classify(exception);
    if (status >= 500) this.logger.error({ exception, path: request.url });
    httpAdapter.reply(
      response,
      {
        type: `https://wagering.local/problems/${code.toLowerCase().replaceAll("_", "-")}`,
        title,
        status,
        detail,
        instance: request.url,
        code,
      },
      status,
    );
  }
}

function classify(exception: unknown): {
  status: number;
  title: string;
  detail: string;
  code: string;
} {
  if (exception instanceof z.ZodError) {
    return {
      status: 400,
      title: "Invalid request",
      detail: exception.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; "),
      code: "INVALID_REQUEST",
    };
  }
  if (exception instanceof ApplicationError) {
    const status =
      exception.code === "WALLET_NOT_FOUND"
        ? 404
        : exception.code === "IDEMPOTENCY_CONFLICT"
          ? 409
          : 422;
    return {
      status,
      title: "Request could not be processed",
      detail: exception.message,
      code: exception.code,
    };
  }
  if (exception instanceof DomainError) {
    return {
      status: 422,
      title: "Business rule rejected the request",
      detail: exception.message,
      code: exception.name
        .replace(/Error$/, "")
        .replace(/([a-z])([A-Z])/g, "$1_$2")
        .toUpperCase(),
    };
  }
  if (exception instanceof HttpException) {
    return {
      status: exception.getStatus(),
      title: exception.name,
      detail: exception.message,
      code: `HTTP_${String(exception.getStatus())}`,
    };
  }
  const databaseCode = (exception as DatabaseError | undefined)?.code;
  if (databaseCode === "23505") {
    return {
      status: 409,
      title: "Conflict",
      detail: "A resource with the same unique identity already exists",
      code: "UNIQUE_CONFLICT",
    };
  }
  if (databaseCode === "55P03" || databaseCode === "40001" || databaseCode === "40P01") {
    return {
      status: 503,
      title: "Temporary database contention",
      detail: "Retry the request with the same idempotency key",
      code: "TRANSIENT_DATABASE_FAILURE",
    };
  }
  return {
    status: HttpStatus.INTERNAL_SERVER_ERROR,
    title: "Internal server error",
    detail: "The request could not be completed",
    code: "INTERNAL_ERROR",
  };
}

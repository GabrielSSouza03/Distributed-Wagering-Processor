import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import { PROVIDER_IDENTITY, type ProviderIdentityPort } from "./provider-identity.port.js";
import { Inject } from "@nestjs/common";

@Injectable()
export class ProviderIdentityGuard implements CanActivate {
  constructor(@Inject(PROVIDER_IDENTITY) private readonly identity: ProviderIdentityPort) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<{
      url: string;
      headers: Record<string, string | undefined>;
    }>();
    if (request.url.startsWith("/health")) return true;
    request.headers["x-provider-subject"] =
      (await this.identity.resolve(request.headers.authorization))?.subject ?? "anonymous";
    return true;
  }
}

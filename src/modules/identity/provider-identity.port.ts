export const PROVIDER_IDENTITY = Symbol("PROVIDER_IDENTITY");

export interface ProviderIdentity {
  subject: string;
}

export interface ProviderIdentityPort {
  resolve(authorization?: string): Promise<ProviderIdentity | undefined>;
}

export class NoopProviderIdentity implements ProviderIdentityPort {
  resolve(authorization?: string): Promise<ProviderIdentity | undefined> {
    if (!authorization) return Promise.resolve({ subject: "anonymous" });
    return Promise.resolve({ subject: authorization.slice(0, 64) });
  }
}

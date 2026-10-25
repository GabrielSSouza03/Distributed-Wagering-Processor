export const CLOCK = Symbol("CLOCK");
export const ID_GENERATOR = Symbol("ID_GENERATOR");

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  next(): string;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

export class UuidGenerator implements IdGenerator {
  next(): string {
    return crypto.randomUUID();
  }
}

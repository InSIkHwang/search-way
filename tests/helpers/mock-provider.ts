import type {
  FlightProvider,
  ProviderId,
  ProviderSearchInput,
  Quote,
} from "../../src/providers/types.js";

export interface PendingCall {
  input: ProviderSearchInput;
  resolve(quote: Quote): void;
  reject(error: unknown): void;
}

export class ControllableProvider implements FlightProvider {
  readonly calls: ProviderSearchInput[] = [];
  readonly pending: PendingCall[] = [];

  constructor(readonly id: ProviderId) {}

  findDirectRoundTrip(input: ProviderSearchInput): Promise<Quote> {
    this.calls.push(structuredClone(input));
    return new Promise<Quote>((resolve, reject) => {
      this.pending.push({ input: structuredClone(input), resolve, reject });
    });
  }

  resolveNext(price: number, currency = "KRW"): void {
    const call = this.pending.shift();
    if (!call) throw new Error(`No pending ${this.id} call`);
    call.resolve({
      price,
      currency,
      url: `https://${this.id}.example/${call.input.departureDate}`,
      scrapedAt: "2026-07-14T00:00:00.000Z",
    });
  }

  rejectNext(message: string): void {
    const call = this.pending.shift();
    if (!call) throw new Error(`No pending ${this.id} call`);
    call.reject(new Error(message));
  }
}

export class ImmediateProvider implements FlightProvider {
  readonly calls: ProviderSearchInput[] = [];

  constructor(
    readonly id: ProviderId,
    private readonly result: (input: ProviderSearchInput) => Quote | Error,
  ) {}

  async findDirectRoundTrip(input: ProviderSearchInput): Promise<Quote> {
    this.calls.push(structuredClone(input));
    const value = this.result(input);
    if (value instanceof Error) throw value;
    return value;
  }
}

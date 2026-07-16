export type ProviderFailureCode =
  | "provider_timeout"
  | "provider_blocked"
  | "no_direct_flight"
  | "provider_error";

type ProviderFailureOptions = ErrorOptions & {
  status?: number;
  retryAfter?: string;
};

export class ProviderFailure extends Error {
  readonly status?: number;
  readonly retryAfter?: string;

  constructor(
    readonly code: ProviderFailureCode,
    message: string,
    options: ProviderFailureOptions = {},
  ) {
    super(message, options);
    this.name = "ProviderFailure";
    if (options.status !== undefined) {
      this.status = options.status;
    }
    if (options.retryAfter !== undefined) {
      this.retryAfter = options.retryAfter;
    }
  }
}

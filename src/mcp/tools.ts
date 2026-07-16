import { z } from "zod";
import type { DatePair, FlexibleSearchRequest } from "../domain/types.js";
import { JobNotFoundError } from "../jobs/store.js";
import type { SearchJob } from "../jobs/types.js";
import type { StartSearchResult } from "../orchestrator/index.js";
import { serializeSearchJob } from "./serialization.js";
import {
  jobIdInputSchema,
  startFlexibleSearchInputSchema,
} from "./validation.js";

export type JsonObject = Record<string, unknown>;

export type ToolResult =
  | { ok: true; value: JsonObject }
  | {
      ok: false;
      error: {
        code:
          | "INVALID_INPUT"
          | "EMPTY_DATE_PAIRS"
          | "JOB_NOT_FOUND"
          | "INTERNAL_ERROR";
        message: string;
      };
    };

export interface McpCore {
  enumerateDatePairs(request: FlexibleSearchRequest): DatePair[];
  start(request: FlexibleSearchRequest): Promise<StartSearchResult>;
  getStatus(jobId: string): Promise<SearchJob>;
  cancel(jobId: string): Promise<SearchJob>;
  waitForIdle(jobId: string): Promise<void>;
  recoverInterrupted(): Promise<number>;
}

export interface McpTools {
  start(input: unknown): Promise<ToolResult>;
  getStatus(input: unknown): Promise<ToolResult>;
  cancel(input: unknown): Promise<ToolResult>;
}

function invalidInput(error: z.ZodError): ToolResult {
  return {
    ok: false,
    error: {
      code: "INVALID_INPUT",
      message: error.issues
        .map((issue) => {
          const path = issue.path.length > 0 ? issue.path.join(".") : "input";
          return `${path}: ${issue.message}`;
        })
        .join("; "),
    },
  };
}

function internalError(message = "Unable to start search"): ToolResult {
  return {
    ok: false,
    error: {
      code: "INTERNAL_ERROR",
      message,
    },
  };
}

function mapCoreError(error: unknown): ToolResult {
  if (error instanceof JobNotFoundError) {
    const jobId = error.message.replace(/^Job not found:\s*/, "");
    return {
      ok: false,
      error: {
        code: "JOB_NOT_FOUND",
        message: `Unknown job_id: ${jobId}`,
      },
    };
  }
  return internalError("Internal MCP error");
}

export function createMcpTools(core: McpCore): McpTools {
  return {
    async start(input: unknown): Promise<ToolResult> {
      const parsed = startFlexibleSearchInputSchema.safeParse(input);
      if (!parsed.success) {
        return invalidInput(parsed.error);
      }

      const request = parsed.data;
      const pairs = core.enumerateDatePairs(request);
      if (pairs.length === 0) {
        return {
          ok: false,
          error: {
            code: "EMPTY_DATE_PAIRS",
            message: "No date pairs match the search conditions",
          },
        };
      }

      try {
        const started = await core.start(request);
        if (started.status !== "queued" || started.totalPairs !== pairs.length) {
          return internalError("Orchestrator start result mismatch");
        }
        return {
          ok: true,
          value: {
            job_id: started.jobId,
            total_pairs: started.totalPairs,
            status: started.status,
          },
        };
      } catch {
        return internalError();
      }
    },

    async getStatus(input: unknown): Promise<ToolResult> {
      const parsed = jobIdInputSchema.safeParse(input);
      if (!parsed.success) {
        return invalidInput(parsed.error);
      }

      try {
        const job = await core.getStatus(parsed.data.jobId);
        return {
          ok: true,
          value: serializeSearchJob(job) as JsonObject,
        };
      } catch (error) {
        return mapCoreError(error);
      }
    },

    async cancel(input: unknown): Promise<ToolResult> {
      const parsed = jobIdInputSchema.safeParse(input);
      if (!parsed.success) {
        return invalidInput(parsed.error);
      }

      try {
        const job = await core.cancel(parsed.data.jobId);
        return {
          ok: true,
          value: {
            job_id: job.jobId,
            status: job.status,
          },
        };
      } catch (error) {
        return mapCoreError(error);
      }
    },
  };
}

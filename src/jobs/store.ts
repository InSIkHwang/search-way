/// <reference types="node" />
import { randomUUID } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import type { SearchJob } from "./types.js";

const JOB_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export class JobNotFoundError extends Error {
  constructor(jobId: string) {
    super(`Job not found: ${jobId}`);
    this.name = "JobNotFoundError";
  }
}

export class JobStoreError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "JobStoreError";
  }
}

export interface JobStoreFilesystem {
  mkdir(path: string, options: { recursive: boolean }): Promise<void>;
  readdir(path: string): Promise<string[]>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
  writeFile(path: string, data: string, encoding: "utf8"): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  unlink(path: string): Promise<void>;
}

const defaultFilesystem: JobStoreFilesystem = {
  mkdir: async (path, options) => {
    await mkdir(path, options);
  },
  readdir,
  readFile,
  writeFile,
  rename,
  unlink,
};

export class JsonJobStore {
  private readonly chains = new Map<string, Promise<void>>();

  constructor(
    private readonly directory: string,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly filesystem: JobStoreFilesystem = defaultFilesystem,
  ) {}

  async create(job: SearchJob): Promise<void> {
    return this.enqueue(job.jobId, async () => {
      await this.writeAtomic(structuredClone(job));
    });
  }

  async get(jobId: string): Promise<SearchJob> {
    this.assertValidJobId(jobId);
    try {
      const raw = await this.filesystem.readFile(this.pathFor(jobId), "utf8");
      return structuredClone(JSON.parse(raw) as SearchJob);
    } catch (error) {
      throw this.wrapError("Failed to read job", error);
    }
  }

  async update(
    jobId: string,
    mutate: (job: SearchJob) => SearchJob,
  ): Promise<SearchJob> {
    return this.enqueue(jobId, async () => {
      const current = await this.get(jobId);
      const next = structuredClone(mutate(structuredClone(current)));
      await this.writeAtomic(next);
      return structuredClone(next);
    });
  }

  async markInterrupted(): Promise<number> {
    await this.filesystem.mkdir(this.directory, { recursive: true });
    const entries = await this.filesystem.readdir(this.directory);
    let count = 0;
    for (const entry of entries) {
      if (!entry.endsWith(".json")) {
        continue;
      }
      const jobId = entry.slice(0, -".json".length);
      try {
        const job = await this.get(jobId);
        if (job.status === "queued" || job.status === "running") {
          await this.update(jobId, (current) => ({
            ...current,
            status: "failed",
            failureReason: "interrupted",
            updatedAt: this.now(),
          }));
          count += 1;
        }
      } catch (error) {
        throw this.wrapError(`Failed to recover job ${jobId}`, error);
      }
    }
    return count;
  }

  private assertValidJobId(jobId: string): void {
    if (!JOB_ID_PATTERN.test(jobId)) {
      throw new Error("Invalid job id");
    }
  }

  private pathFor(jobId: string): string {
    this.assertValidJobId(jobId);
    return join(this.directory, `${jobId}.json`);
  }

  private wrapError(message: string, error: unknown): JobStoreError {
    if (error instanceof JobStoreError) {
      return error;
    }
    return new JobStoreError(message, {
      cause: error instanceof Error ? error : undefined,
    });
  }

  private async writeAtomic(job: SearchJob): Promise<void> {
    await this.filesystem.mkdir(this.directory, { recursive: true });
    const target = this.pathFor(job.jobId);
    const temporary = join(this.directory, `${job.jobId}.${randomUUID()}.tmp`);
    try {
      await this.filesystem.writeFile(
        temporary,
        `${JSON.stringify(job, null, 2)}\n`,
        "utf8",
      );
      try {
        await this.filesystem.rename(temporary, target);
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          (error as NodeJS.ErrnoException).code === "EPERM" &&
          process.platform === "win32"
        ) {
          await this.filesystem.unlink(target).catch(() => undefined);
          await this.filesystem.rename(temporary, target);
        } else {
          throw error;
        }
      }
    } catch (error) {
      await this.filesystem.unlink(temporary).catch(() => undefined);
      throw this.wrapError("Failed to write job", error);
    }
  }

  private enqueue<T>(jobId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(jobId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.chains.set(
      jobId,
      current.then(
        () => undefined,
        () => undefined,
      ),
    );
    return current;
  }
}

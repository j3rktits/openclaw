import fs from "node:fs";
import path from "node:path";

export type OpsJobQueueItem = {
  id: string;
  ts: string;
  request: string;
  host: "llm-test" | "dead";
  cwd: string | null;
  commands: string[];
  timeoutSec: number;
  maxLines: number;
  replyTo: { channel: "telegram"; chatId: string };
};

const DEFAULT_QUEUE_DIR = "/var/lib/openclaw";
const DEFAULT_JOBS_PATH = `${DEFAULT_QUEUE_DIR}/jobs.jsonl`;

export function resolveJobsPath(): string {
  return process.env.JOBS_PATH?.trim() || DEFAULT_JOBS_PATH;
}

export async function appendJobToQueue(job: OpsJobQueueItem): Promise<void> {
  const jobsPath = resolveJobsPath();
  const dir = path.dirname(jobsPath);
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o777 });
  const line = `${JSON.stringify(job)}\n`;
  await fs.promises.appendFile(jobsPath, line, { encoding: "utf8", mode: 0o666 });
}


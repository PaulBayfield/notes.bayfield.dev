// Recurring housekeeping, run by one instance at a time: each run takes a Postgres advisory lock, so
// with several instances only one does the work and the others skip that round.

import { sql } from "./db.ts";

interface Job {
  name: string;
  everyMs: number;
  run: () => Promise<void>;
}

const jobs: Job[] = [];

export function schedule(name: string, everyMs: number, run: () => Promise<void>) {
  jobs.push({ name, everyMs, run });
}

/** A stable lock number per job name. */
const lockId = (name: string) => [...name].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) | 0, 4242050);

async function runOnce(job: Job) {
  await sql.begin(async (tx) => {
    const [{ locked }] = await tx<{ locked: boolean }[]>`SELECT pg_try_advisory_xact_lock(${lockId(job.name)}) AS locked`;
    if (!locked) return;
    await job.run();
  });
}

export function startJobs() {
  for (const job of jobs) {
    const tick = () => void runOnce(job).catch((e) => console.warn(`Job ${job.name} failed:`, e));
    // A first run a little after startup, then on schedule.
    setTimeout(tick, 30_000 + Math.random() * 30_000).unref();
    setInterval(tick, job.everyMs).unref();
  }
}

export type PlannedOpsJob = {
  host: "llm-test" | "dead";
  cwd?: string | null;
  commands: string[];
  timeoutSec: number;
  maxLines: number;
};

const FOOTGUN_PATTERNS: Array<{ re: RegExp; why: string }> = [
  { re: /\brm\s+-rf\s+\/\b/i, why: "rm -rf /" },
  { re: /\bmkfs(\.|)\b/i, why: "mkfs" },
  { re: /\bdd\s+if=.*\s+of=\/dev\//i, why: "dd to /dev/*" },
  { re: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, why: "fork bomb" },
];

function isNonEmptySingleLine(s: unknown): s is string {
  if (typeof s !== "string") return false;
  const t = s.trim();
  if (!t) return false;
  return !/[\r\n]/.test(t);
}

export function validatePlannedOpsJob(
  raw: unknown,
): { ok: true; job: PlannedOpsJob } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object") {
    return { ok: false, error: "planner returned non-object" };
  }
  const obj = raw as any;
  const host = obj.host;
  if (host !== "llm-test" && host !== "dead") {
    return { ok: false, error: `invalid host: ${String(host)}` };
  }

  const cwd = obj.cwd;
  if (!(cwd === null || cwd === undefined || typeof cwd === "string")) {
    return { ok: false, error: "cwd must be string or null" };
  }

  const commands = obj.commands;
  if (!Array.isArray(commands) || commands.length < 1 || commands.length > 6) {
    return { ok: false, error: "commands must be a list of 1..6 strings" };
  }
  for (const cmd of commands) {
    if (!isNonEmptySingleLine(cmd)) {
      return { ok: false, error: "commands must be non-empty, single-line strings" };
    }
    if (/^\s*ssh\b/i.test(cmd)) {
      return { ok: false, error: "do not embed ssh in commands; choose host=dead instead" };
    }
    for (const p of FOOTGUN_PATTERNS) {
      if (p.re.test(cmd)) {
        return { ok: false, error: `denied command (${p.why})` };
      }
    }
  }

  const timeoutSec = Number(obj.timeoutSec);
  if (!Number.isFinite(timeoutSec) || timeoutSec < 5 || timeoutSec > 300) {
    return { ok: false, error: "timeoutSec must be 5..300" };
  }

  const maxLines = Number(obj.maxLines);
  if (!Number.isFinite(maxLines) || maxLines < 50 || maxLines > 1000) {
    return { ok: false, error: "maxLines must be 50..1000" };
  }

  return {
    ok: true,
    job: {
      host,
      cwd: cwd ?? null,
      commands: commands.map((c) => String(c).trim()),
      timeoutSec,
      maxLines,
    },
  };
}


import type { DiffLine, FileChange, ProposedChange, RunScript, ScriptApproval, ScriptStep } from "./agent-run-types";

export const SAMPLE_TASK = "Add rate limiting to the public API";
export const SAMPLE_MODEL_NAME = "Claude Sonnet 5.5";

/** Builds a new file: every line is an addition, numbered from 1. */
function added(path: string, source: string[]): FileChange {
  return { path, status: "added", lines: source.map((text, i) => ({ type: "add", new: i + 1, text })) };
}

/** Builds a hunk from marked lines: "+ " added, "- " removed, "  " unchanged. Numbers follow the old and new file from `start`. */
function hunk(path: string, start: number, marked: string[]): FileChange {
  let old = start, next = start;
  const lines = marked.map<DiffLine>(line => {
    const text = line.slice(2);
    if (line.startsWith("+")) return { type: "add", new: next++, text };
    if (line.startsWith("-")) return { type: "del", old: old++, text };
    return { type: "ctx", old: old++, new: next++, text };
  });
  return { path, status: "modified", lines };
}

const limiter = (limit: string, skipHealth: boolean) => added("src/middleware/rate-limit.ts", [
  "import type { RequestHandler } from \"express\";",
  "import { redis } from \"../lib/redis\";",
  "",
  "const WINDOW = 60; // seconds",
  `const LIMIT = ${limit};`,
  "",
  "export const rateLimit: RequestHandler = async (req, res, next) => {",
  ...(skipHealth ? ["  if (req.path === \"/health\") return next();"] : []),
  "  const key = `rate:${req.apiKey ?? req.ip}`;",
  "  const count = await redis.incr(key);",
  "  if (count === 1) await redis.expire(key, WINDOW);",
  "  res.set(\"RateLimit-Remaining\", String(Math.max(0, LIMIT - count)));",
  "  if (count <= LIMIT) return next();",
  "  res.set(\"Retry-After\", String(WINDOW));",
  "  res.status(429).json({ error: \"Too many requests\" });",
  "};",
]);

const routes = hunk("src/api/routes.ts", 1, [
  "  import { Router } from \"express\";",
  "  import { requireApiKey } from \"../middleware/auth\";",
  "+ import { rateLimit } from \"../middleware/rate-limit\";",
  "  import { orders } from \"./orders\";",
  "  import { products } from \"./products\";",
  "  ",
  "  export const api = Router();",
  "  ",
  "- api.use(requireApiKey);",
  "+ api.use(requireApiKey, rateLimit);",
  "  api.use(\"/orders\", orders);",
  "  api.use(\"/products\", products);",
]);

const firstChange: ProposedChange = {
  id: "rate-limit",
  summary: "Add a Redis rate limiter, 60 requests a minute per API key, and put it in front of every API route.",
  files: [limiter("60", false), routes],
  outcome: "Every /api route now goes through a Redis rate limiter: 60 requests a minute per API key, falling back to the IP. Responses carry RateLimit-Remaining, and a client over the limit gets a 429 with Retry-After. Types check and all 12 API tests pass.",
};

const revisedChange: ProposedChange = {
  id: "rate-limit-revised",
  summary: "Read the limit from RATE_LIMIT with a default of 120 a minute, and let health checks through.",
  files: [limiter("Number(process.env.RATE_LIMIT ?? 120)", true), routes],
  outcome: "Every /api route except /health now goes through a Redis rate limiter: 120 requests a minute per API key by default, set with RATE_LIMIT. Responses carry RateLimit-Remaining, and a client over the limit gets a 429 with Retry-After. Types check and all 12 API tests pass.",
};

const afterApproval: ScriptStep[] = [
  {
    id: "write", mark: "edit", verb: "Writing", doneVerb: "Wrote", target: "src/middleware/rate-limit.ts", ms: 900,
    io: { input: "write_file src/middleware/rate-limit.ts", output: ["Created the file"] },
  },
  {
    id: "wire", mark: "edit", verb: "Editing", doneVerb: "Edited", target: "src/api/routes.ts", ms: 700,
    io: { input: "edit_file src/api/routes.ts", output: ["Applied 1 hunk, +2 −1"] },
  },
  {
    id: "types", mark: "typescript", verb: "Checking types", doneVerb: "Checked types", doneTarget: "no errors", ms: 1100,
    io: { input: "$ npx tsc --noEmit", output: ["Found 0 errors."] },
  },
  {
    id: "tests", mark: "npm", verb: "Running tests", doneVerb: "Ran tests", doneTarget: "12 passed", ms: 2600, total: 12,
    io: {
      input: "$ npm test -- src/api",
      output: [
        "✓ orders › lists orders for the key's account",
        "✓ products › paginates with a cursor",
        "✓ rate-limit › allows requests under the limit",
        "✓ rate-limit › returns 429 with Retry-After",
        "Tests  12 passed (12)",
      ],
    },
  },
  {
    id: "summary", mark: "think", verb: "Writing the summary", doneVerb: "Wrote the summary", ms: 700,
    text: "The limiter is in, types check and the API suite passes, including two new rate limit tests.",
  },
];

const approval: ScriptApproval = {
  id: "review", mark: "review", verb: "Preparing", target: "changes", doneVerb: "Approved", doneTarget: "changes to 2 files", ms: 800,
  change: firstChange,
  revise: {
    steps: [{
      id: "revise", mark: "think", verb: "Revising the change", doneVerb: "Revised the change", ms: 1300,
      text: "Taking the note on board: the limit should be easy to change per environment, and load balancer health checks should never be limited.",
    }],
    approval: { id: "review-2", mark: "review", verb: "Preparing", target: "revised changes", doneVerb: "Approved", doneTarget: "revised changes to 2 files", ms: 700, change: revisedChange },
  },
};

export const sampleScript: RunScript = {
  steps: [
    {
      id: "plan", mark: "think", verb: "Planning the change", doneVerb: "Planned the change", ms: 1200,
      text: "The public API has no rate limiting yet. I'll check how the routes are mounted, look for existing middleware, and see whether Redis is available so a limit holds across every instance.",
    },
    {
      id: "routes", mark: "read", verb: "Reading", doneVerb: "Read", target: "src/api/routes.ts", ms: 900,
      io: { input: "read_file src/api/routes.ts", output: ["import { Router } from \"express\";", "…", "export const api = Router();", "api.use(requireApiKey);", "api.use(\"/orders\", orders);"] },
    },
    {
      id: "search", mark: "search", verb: "Searching for", doneVerb: "Searched for", target: "rate limit middleware", ms: 1000,
      io: { input: "grep -rni \"rate.\\?limit\" src", output: ["No matches"] },
    },
    {
      id: "package", mark: "read", verb: "Reading", doneVerb: "Read", target: "package.json", ms: 700,
      io: { input: "read_file package.json", output: ["\"express\": \"^5.1.0\",", "\"ioredis\": \"^5.4.1\",", "\"zod\": \"^4.1.5\""] },
    },
    {
      id: "redis", mark: "read", verb: "Reading", doneVerb: "Read", target: "src/lib/redis.ts", ms: 700,
      io: { input: "read_file src/lib/redis.ts", output: ["import Redis from \"ioredis\";", "export const redis = new Redis(process.env.REDIS_URL!);"] },
    },
    {
      id: "auth", mark: "search", verb: "Searching for", doneVerb: "Searched for", target: "the API key on requests", ms: 900,
      io: { input: "grep -rn \"req.apiKey\" src", output: ["src/middleware/auth.ts:14:  req.apiKey = key.id;", "src/types/express.d.ts:6:    apiKey?: string;"] },
    },
    approval,
    ...afterApproval,
  ],
  result: { summary: firstChange.outcome ?? "", tests: { passed: 12, total: 12 }, checks: ["No type errors"] },
  pullRequest: { number: 482 },
};

const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const STATE_DIR = path.join(ROOT, ".agent-loop");
const STATE_FILE = path.join(STATE_DIR, "state.json");
const NOTES_FILE = path.join(STATE_DIR, "notes.md");

const DEFAULT_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const MAX_OUTPUT_CHARS = 8000;
const isWindows = process.platform === "win32";
const npmBin = isWindows ? "npm.cmd" : "npm";

const CHECKS = {
  status: { command: "git", args: ["status", "--short"] },
  test: { command: npmBin, args: ["test"] },
  files: {
    command: "node",
    args: [
      "-e",
      "const fs=require('fs'); const walk=(d)=>fs.readdirSync(d,{withFileTypes:true}).flatMap(e=>{const p=require('path').join(d,e.name); return e.isDirectory()&&!['.git','node_modules','.agent-loop'].includes(e.name)?walk(p):e.isFile()?[p]:[]}); console.log(walk('.').map(p=>p.replace(/^\\.\\\\?/, '')).join('\\n'))",
    ],
  },
};

function parseArgs() {
  const args = new Map();
  for (const arg of process.argv.slice(2)) {
    const [key, value] = arg.replace(/^--/, "").split("=");
    args.set(key, value || "true");
  }

  return {
    cycles: Math.max(1, Math.min(20, Number(args.get("cycles") || 3))),
    model: args.get("model") || DEFAULT_MODEL,
    dryRun: args.get("dry-run") !== "false",
  };
}

function ensureStateDir() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    return fallback;
  }
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function appendNote(markdown) {
  const stamped = `\n## ${new Date().toISOString()}\n\n${markdown.trim()}\n`;
  fs.appendFileSync(NOTES_FILE, stamped);
}

function run(command, args, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const useCmd = isWindows && command.endsWith(".cmd");
    const file = useCmd ? "cmd.exe" : command;
    const finalArgs = useCmd ? ["/d", "/s", "/c", command, ...args] : args;

    execFile(file, finalArgs, { cwd: ROOT, timeout: timeoutMs, windowsHide: true }, (error, stdout, stderr) => {
      resolve({
        command: [command, ...args].join(" "),
        ok: !error,
        code: error?.code ?? 0,
        stdout: String(stdout || "").slice(-MAX_OUTPUT_CHARS),
        stderr: String(stderr || "").slice(-MAX_OUTPUT_CHARS),
      });
    });
  });
}

async function observe() {
  const [status, tests, files] = await Promise.all([
    run(CHECKS.status.command, CHECKS.status.args, 10000),
    run(CHECKS.test.command, CHECKS.test.args, 30000),
    run(CHECKS.files.command, CHECKS.files.args, 10000),
  ]);

  return {
    at: new Date().toISOString(),
    project: "office-signage",
    checks: { status, tests, files },
  };
}

function heuristicDecision(observation) {
  const statusText = observation.checks.status.stdout.trim();
  const testOk = observation.checks.tests.ok;

  if (!testOk) {
    return {
      thought: "The project check is failing. Capture the failure so a human or coding agent can fix it next.",
      actions: [
        {
          type: "note",
          body: `Test check failed.\n\nCommand: \`${observation.checks.tests.command}\`\n\n\`\`\`\n${observation.checks.tests.stderr || observation.checks.tests.stdout}\n\`\`\``,
        },
      ],
    };
  }

  return {
    thought: "The project is syntactically healthy. Record the repo state and stop unless the next run has a concrete change to evaluate.",
    actions: [
      {
        type: "note",
        body: `Health check passed.\n\nGit status:\n\n\`\`\`\n${statusText || "clean"}\n\`\`\``,
      },
      { type: "stop", reason: "No failing check or pending agent task was detected." },
    ],
  };
}

async function askModel(model, observation, history) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return heuristicDecision(observation);

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content:
            "You are a bounded repo agent loop for a local Node digital-signage project. Return strict JSON with keys thought and actions. Allowed actions: {\"type\":\"check\",\"name\":\"status|test|files\"}, {\"type\":\"note\",\"body\":\"markdown\"}, {\"type\":\"stop\",\"reason\":\"text\"}. Do not request arbitrary shell commands.",
        },
        {
          role: "user",
          content: JSON.stringify({ observation, recentHistory: history.cycles?.slice(-5) || [] }),
        },
      ],
      response_format: { type: "json_object" },
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenAI request failed with ${response.status}`);
  }

  const data = await response.json();
  return JSON.parse(data.choices?.[0]?.message?.content || "{}");
}

async function executeActions(actions, dryRun) {
  const results = [];

  for (const action of Array.isArray(actions) ? actions : []) {
    if (action.type === "check" && CHECKS[action.name]) {
      const check = CHECKS[action.name];
      results.push({ action, result: await run(check.command, check.args) });
      continue;
    }

    if (action.type === "note") {
      if (!dryRun) appendNote(action.body || "");
      results.push({ action, result: { ok: true, dryRun } });
      continue;
    }

    if (action.type === "stop") {
      results.push({ action, result: { ok: true, stop: true } });
      break;
    }

    results.push({ action, result: { ok: false, error: "Unsupported action" } });
  }

  return results;
}

async function main() {
  const options = parseArgs();
  ensureStateDir();

  const history = readJson(STATE_FILE, { cycles: [] });
  let shouldStop = false;

  for (let index = 0; index < options.cycles && !shouldStop; index += 1) {
    const observation = await observe();
    const decision = await askModel(options.model, observation, history);
    const results = await executeActions(decision.actions, options.dryRun);

    shouldStop = results.some((entry) => entry.result?.stop);
    history.cycles = [
      ...(history.cycles || []),
      {
        at: observation.at,
        thought: decision.thought || "",
        dryRun: options.dryRun,
        actions: results,
      },
    ].slice(-50);

    writeJson(STATE_FILE, history);
    console.log(JSON.stringify(history.cycles[history.cycles.length - 1], null, 2));
  }
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});

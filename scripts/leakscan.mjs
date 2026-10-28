// Scan tracked files and history for shapes that look like secrets.
//
// Deliberately checks *shapes*, not specific values: a scanner that hardcodes one person's
// open_id would itself leak it. Run before every push, and in CI if you add one.
//
//   node scripts/leakscan.mjs
import { execSync } from "node:child_process";

const PATTERNS = [
  // 0.0.0.0 and 255.255.255.255 are bind/broadcast addresses, not hosts: documentation about
  // listening on all interfaces should not look like a leaked server address.
  // Every reserved range is excluded, not just the RFC1918 trio: a blocklist for SSRF legitimately
  // contains link-local (169.254.x, cloud metadata) and CGNAT (100.64/10) addresses, and flagging
  // those as "leaked public IP" punishes exactly the code that is doing the right thing.
  {
    name: "公网 IPv4",
    re: /\b(?!0\.0\.0\.0\b|255\.255\.255\.255\b|10\.|127\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)(?:\d{1,3}\.){3}\d{1,3}\b/,
  },
  { name: "飞书 open_id", re: /\bou_[0-9a-f]{16,}\b/ },
  { name: "飞书 app_id", re: /\bcli_[a-z0-9]{10,}\b/ },
  { name: "飞书 app_secret", re: /\b[A-Za-z0-9]{16,}\b(?=.*app_secret)|app_secret\s*[=:]\s*\S{8,}/i },
  { name: "OpenAI key", re: /\bsk-[A-Za-z0-9_-]{16,}\b/ },
  { name: "GitHub token", re: /\bgh[pousr]_[A-Za-z0-9]{16,}\b/ },
  { name: "AWS key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "私钥块", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "赋值式密码", re: /(?:password|passwd|pwd)\s*[=:]\s*\S{6,}/i },
];

// Files that legitimately contain credential-shaped strings: the test fixtures are fake values
// written *on purpose* to exercise the detector, and examples use placeholders.
const ALLOWED_PATHS = /^(eval\/|tests\/|docs\/|README\.md$|deploy\/env\.example$|config\.example\.json$|scripts\/leakscan\.mjs$)/;

// A match is tolerated when it is obviously a placeholder or a fixture. `passw0rd!2024` is a
// documentation example that once appeared in a comment; it was never a real credential.
const PLACEHOLDER = /(x{6,}|example|placeholder|replace-me|should-not-leak|super-secret|fake|dummy|hunter2|passw0rd!2024|\*\*\*)/i;

const looksReal = (match) => match && !PLACEHOLDER.test(match);

const sh = (cmd) => {
  try {
    return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return "";
  }
};

let findings = 0;
const report = (scope, pattern, where, sample) => {
  findings++;
  const hint = sample ? ` (${sample.slice(0, 12)}…)` : "";
  console.log(`  [${scope}] ${pattern} -> ${where}${hint}`);
};

const scan = (scope, content, where) => {
  for (const { name, re } of PATTERNS) {
    const match = content.match(re);
    if (match && looksReal(match[0])) report(scope, name, where, match[0]);
  }
};

const files = sh("git ls-files").split("\n").filter(Boolean);
for (const file of files) {
  if (ALLOWED_PATHS.test(file)) continue;
  scan("工作区", sh(`git show :${file}`), file);
}

for (const commit of sh('git log --format="%H"').split("\n").filter(Boolean)) {
  // Diff non-fixture files only: a fixture's fake key should not flag the commit that added it.
  const changed = sh(`git show --name-only --format= --no-color ${commit}`)
    .split("\n")
    .filter(Boolean)
    .filter((file) => !ALLOWED_PATHS.test(file));
  for (const file of changed) {
    scan("历史", sh(`git show --format= --no-color ${commit} -- ${JSON.stringify(file)}`), `${commit.slice(0, 7)}:${file}`);
  }
}

if (findings === 0) {
  console.log("干净：工作区与历史里没有发现疑似密钥/地址。");
  process.exit(0);
}
console.log(`\n共 ${findings} 处命中。确认是否误报；真实密钥请先撤销再清理历史。`);
process.exit(1);

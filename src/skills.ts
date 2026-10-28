import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Agent Skills discovery, from our side.
 *
 * pi discovers `SKILL.md` files itself and advertises them in the prompt; what it does not give
 * us is a way to answer "which skills does this deployment actually have, and are they the ones I
 * meant to ship". Without that, a typo in the frontmatter or a directory mounted to the wrong
 * place looks exactly like a skill the model chose not to use.
 *
 * Discovery paths follow the Agent Skills convention pi implements:
 *   - user level:    `<home>/.agents/skills/<name>/SKILL.md`
 *   - project level: `<cwd>/.agents/skills/<name>/SKILL.md`, up to the repo root
 *
 * The scanner is deliberately dumb: it reads frontmatter, never executes anything. A skill is
 * documentation plus optional scripts; loading one must not be able to change state.
 */
export type Skill = {
  name: string;
  description: string;
  path: string;
  /** Where it was found: user directory or project directory. */
  scope: "user" | "project";
  bytes: number;
};

/** Minimal frontmatter reader: `---` fence, `key: value` pairs, nothing else. */
export function parseFrontmatter(text: string): Record<string, string> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(text ?? ""));
  if (!match) return {};
  const fields: Record<string, string> = {};
  let key = "";
  for (const line of match[1].split(/\r?\n/)) {
    const pair = /^([A-Za-z_-][\w-]*):\s*(.*)$/.exec(line);
    if (pair) {
      key = pair[1];
      fields[key] = pair[2].trim();
      continue;
    }
    // Continuation lines of a multi-line value (YAML block scalars are common for descriptions).
    if (key && /^\s+\S/.test(line)) fields[key] = `${fields[key]} ${line.trim()}`.trim();
  }
  return fields;
}

/** Scan a skills root for `<name>/SKILL.md` directories, recursively but shallowly. */
export function scanSkills(root: string, scope: "user" | "project" = "user"): Skill[] {
  const found: Skill[] = [];
  const visit = (dir: string, depth: number): void => {
    if (depth > 3) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.startsWith(".")) continue;
      const full = path.join(dir, entry);
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (!stat.isDirectory()) continue;
      const manifest = path.join(full, "SKILL.md");
      try {
        const text = readFileSync(manifest, "utf8");
        const meta = parseFrontmatter(text);
        found.push({
          name: (meta.name ?? entry).slice(0, 64),
          description: (meta.description ?? "").slice(0, 200),
          path: manifest,
          scope,
          bytes: Buffer.byteLength(text),
        });
      } catch {
        visit(full, depth + 1);
      }
    }
  };
  visit(root, 0);
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

/** Both locations pi reads, deduplicated by name (project overrides user). */
export function discoverSkills(options: { home: string; cwd: string; repoRoot?: string }): Skill[] {
  const roots: Array<{ root: string; scope: "user" | "project" }> = [
    { root: path.join(options.home, ".agents", "skills"), scope: "user" },
  ];
  let dir = options.cwd;
  const stop = options.repoRoot ?? options.cwd;
  while (true) {
    roots.push({ root: path.join(dir, ".agents", "skills"), scope: "project" });
    if (dir === stop) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // Later entries overwrite earlier ones: user first, then project directories from the repository
  // root down to the working directory, so the nearest project skill wins a name collision.
  const byName = new Map<string, Skill>();
  const ordered = [roots[0], ...roots.slice(1).reverse()];
  for (const { root, scope } of ordered) {
    for (const skill of scanSkills(root, scope)) byName.set(skill.name, skill);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** What to show the operator: name, scope, size, and whether the description is usable. */
export function formatSkills(skills: Skill[]): string {
  if (skills.length === 0) return "没有发现任何 skill（检查 ~/.agents/skills 与 <workspace>/.agents/skills）";
  const lines = [`发现 ${skills.length} 个 skill：`];
  for (const skill of skills) {
    const warn = skill.description ? "" : "  ⚠️ 没有 description，模型无法判断何时使用";
    lines.push(`- ${skill.name}（${skill.scope}，${skill.bytes} B）${skill.description ? `：${skill.description}` : ""}${warn}`);
  }
  return lines.join("\n");
}

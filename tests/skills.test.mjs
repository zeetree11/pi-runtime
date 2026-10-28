import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { discoverSkills, formatSkills, parseFrontmatter, scanSkills } from "../src/skills.ts";

let pass = 0;
let fail = 0;
function check(name, ok, detail = "") {
  if (ok) {
    pass += 1;
    console.log(`PASS ${name}`);
  } else {
    fail += 1;
    console.log(`FAIL ${name} ${detail}`);
  }
}

// 1) frontmatter parsing
{
  const meta = parseFrontmatter("---\nname: incident-debug\ndescription: 排查 bot 异常\n---\n\n# 正文\n");
  check("name parsed", meta.name === "incident-debug", meta.name);
  check("description parsed", meta.description === "排查 bot 异常", meta.description);
  check("no frontmatter yields empty", Object.keys(parseFrontmatter("# 只有正文")).length === 0);
  const block = parseFrontmatter("---\nname: x\ndescription: 第一行\n  第二行\n---\n");
  check("multi-line description joined", block.description === "第一行 第二行", JSON.stringify(block.description));
}

// 2) scanning a skills root
{
  const root = mkdtempSync(path.join(tmpdir(), "pi-skills-"));
  mkdirSync(path.join(root, "incident-debug"), { recursive: true });
  writeFileSync(path.join(root, "incident-debug", "SKILL.md"), "---\nname: incident-debug\ndescription: 排查\ntype: skill\n---\n# body\n");
  mkdirSync(path.join(root, "nested", "deploy-check"), { recursive: true });
  writeFileSync(path.join(root, "nested", "deploy-check", "SKILL.md"), "---\nname: deploy-check\ndescription: 部署\n---\n# body\n");
  mkdirSync(path.join(root, "not-a-skill"), { recursive: true });
  writeFileSync(path.join(root, "not-a-skill", "README.md"), "no manifest");

  const skills = scanSkills(root, "user");
  check("direct skill found", skills.some((skill) => skill.name === "incident-debug"), JSON.stringify(skills.map((s) => s.name)));
  check("nested skill found", skills.some((skill) => skill.name === "deploy-check"));
  check("directory without SKILL.md ignored", skills.every((skill) => skill.name !== "not-a-skill"));
  check("scope recorded", skills[0]?.scope === "user");
  check("size recorded", (skills[0]?.bytes ?? 0) > 0);
  check("sorted by name", skills.map((s) => s.name).join(",") === [...skills.map((s) => s.name)].sort().join(","));
}

// 3) user vs project discovery, project wins on name clash
{
  const home = mkdtempSync(path.join(tmpdir(), "pi-home-"));
  const repo = mkdtempSync(path.join(tmpdir(), "pi-repo-"));
  mkdirSync(path.join(home, ".agents", "skills", "shared"), { recursive: true });
  writeFileSync(path.join(home, ".agents", "skills", "shared", "SKILL.md"), "---\nname: shared\ndescription: 用户级\n---\n");
  mkdirSync(path.join(repo, ".agents", "skills", "shared"), { recursive: true });
  writeFileSync(path.join(repo, ".agents", "skills", "shared", "SKILL.md"), "---\nname: shared\ndescription: 项目级\n---\n");
  mkdirSync(path.join(repo, ".agents", "skills", "only-project"), { recursive: true });
  writeFileSync(path.join(repo, ".agents", "skills", "only-project", "SKILL.md"), "---\nname: only-project\ndescription: 只有项目级\n---\n");

  const skills = discoverSkills({ home, cwd: repo, repoRoot: repo });
  const shared = skills.find((skill) => skill.name === "shared");
  check("name collision deduplicated", skills.filter((skill) => skill.name === "shared").length === 1);
  check("project scope wins", shared?.description === "项目级", shared?.description);
  check("project-only skill found", skills.some((skill) => skill.name === "only-project"));

  try { rmSync(home, { recursive: true, force: true }); } catch { /* Windows handle */ }
  try { rmSync(repo, { recursive: true, force: true }); } catch { /* Windows handle */ }
}

// 4) operator output flags missing descriptions
{
  const rendered = formatSkills([
    { name: "ok", description: "有描述", path: "/x", scope: "user", bytes: 10 },
    { name: "bad", description: "", path: "/y", scope: "user", bytes: 10 },
  ]);
  check("lists count", rendered.includes("发现 2 个 skill"), rendered);
  check("warns on missing description", rendered.includes("没有 description"), rendered);
  check("empty case has hint", formatSkills([]).includes("没有发现"), formatSkills([]));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

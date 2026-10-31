import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { extractAttachments, softenMention } from "../src/attachments.ts";

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

// 1) the exact failure that motivated this module
{
  const root = mkdtempSync(path.join(tmpdir(), "pi-attach-"));
  const workspace = path.join(root, "workspace");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(workspace, { recursive: true });
  writeFileSync(path.join(workspace, "pelican-bicycle.svg"), "<svg></svg>");

  const reply = "喏，/workspace/pelican-bicycle.svg，6KB 真 SVG，能打开也能改。";
  const found = extractAttachments(reply, { workspace });
  check("finds the svg", found.length === 1, JSON.stringify(found));
  check("resolves under workspace", found[0]?.path === path.join(workspace, "pelican-bicycle.svg"), found[0]?.path);
  check("records size", (found[0]?.bytes ?? 0) > 0);

  const softened = softenMention(reply, found, workspace);
  check("path replaced by attachment label", !softened.includes("/workspace/pelican-bicycle.svg"), softened);
  check("prose stays", softened.includes("真 SVG"), softened);

  // 2) guards
  check("missing file ignored", extractAttachments("看 /workspace/nope.png 吧", { workspace }).length === 0);
  check("disallowed extension ignored", extractAttachments("看 /workspace/a.exe 吧", { workspace }).length === 0);
  check("outside workspace ignored", extractAttachments("看 /etc/passwd 吧", { workspace }).length === 0);
  check("relative name without prefix ignored", extractAttachments("看 README.md 吧", { workspace }).length === 0);
  check("workspace without leading slash accepted", extractAttachments("在 workspace/pelican-bicycle.svg", { workspace }).length === 1);
  check("trailing punctuation trimmed", extractAttachments("文件：/workspace/pelican-bicycle.svg。", { workspace }).length === 1);

  writeFileSync(path.join(workspace, "empty.png"), "");
  check("empty file ignored", extractAttachments("/workspace/empty.png", { workspace }).length === 0);

  writeFileSync(path.join(workspace, "two.png"), "x");
  const many = extractAttachments("/workspace/pelican-bicycle.svg 和 /workspace/two.png", { workspace, max: 1 });
  check("max caps the count", many.length === 1, String(many.length));

  const dup = extractAttachments("/workspace/two.png 还有 /workspace/two.png", { workspace });
  check("duplicate mention sent once", dup.length === 1, String(dup.length));

  check("no mention yields nothing", extractAttachments("今天天气不错", { workspace }).length === 0);

  // 3) bare image names: the model reports a drawing as "就是 polarbear-bike.png"
  writeFileSync(path.join(workspace, "polarbear-bike.png"), "png-bytes");
  const bare = extractAttachments("画了，就是 polarbear-bike.png。", { workspace });
  check("bare image name is delivered", bare.length === 1, JSON.stringify(bare));
  check("bare name resolves in workspace", path.basename(bare[0]?.path ?? "") === "polarbear-bike.png");
  check("bare non-image is not delivered", extractAttachments("参考 README.md 的说明", { workspace }).length === 0);
  check("missing bare image ignored", extractAttachments("画了，就是 nope.png", { workspace }).length === 0);

  try { rmSync(root, { recursive: true, force: true }); } catch { /* Windows handle */ }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

import { existsSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Attachment fallback: if the reply names a workspace file, deliver it.
 *
 * Why this exists: the `send` tool description says "send the file, do not just tell the user the
 * path". The model ignored it — the reply was `喏，/workspace/pelican-bicycle.svg，6KB`. That is the
 * predictable failure of every instruction that depends on the model *choosing* to act: the path
 * is correct, the user still cannot open it.
 *
 * So the runtime reads the reply and, when it points at a real file it is allowed to send, sends
 * it. The model can still send proactively; this only covers the case where it forgot.
 *
 * Deliberately conservative:
 * - only paths under the workspace, only allow-listed extensions;
 * - the file must exist and be non-empty;
 * - a path mentioned twice is sent once;
 * - at most `max` attachments per reply, so a model that lists ten files cannot turn one answer
 *   into ten uploads.
 */
export const ATTACHMENT_EXTS = [
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp",
  ".pdf", ".txt", ".md", ".csv", ".json", ".zip", ".log", ".html", ".svg", ".yaml", ".yml",
];

export type Attachment = { path: string; bytes: number };

/**
 * Find workspace file paths mentioned in a reply.
 *
 * `/workspace/x.png` and `workspace/x.png` are both accepted because models drop the leading
 * slash. Relative names without the `workspace/` prefix are ignored on purpose: `README.md` in
 * prose would otherwise cause an upload.
 */
export function extractAttachments(
  text: string,
  options: { workspace?: string; max?: number } = {},
): Attachment[] {
  const workspace = (options.workspace ?? "/workspace").replace(/\/+$/, "");
  const max = Math.max(1, options.max ?? 2);
  const body = String(text ?? "");
  const found: Attachment[] = [];
  const seen = new Set<string>();

  // Bare image names ("画了，就是 polarbear-bike.png") carry no workspace prefix, and that is how
  // the model actually reports a picture it just made. Images are matched by existence in the
  // workspace root; documents still require the explicit prefix, because prose mentions
  // "README.md" without meaning to send anything.
  const bareImage = /(?<![\w./-])([\w-]{1,60}\.(?:png|jpg|jpeg|gif|webp|bmp|svg))(?![^\s，。、；：！？）)」"'`])/gi;
  for (const match of body.matchAll(bareImage)) {
    if (found.length >= max) break;
    const candidate = path.resolve(workspace, match[1]);
    const rel = path.relative(workspace, candidate);
    if (rel.startsWith("..") || path.isAbsolute(rel)) continue;
    if (seen.has(candidate)) continue;
    let bytes = 0;
    try {
      const stat = statSync(candidate);
      if (!stat.isFile() || stat.size === 0) continue;
      bytes = stat.size;
    } catch {
      continue;
    }
    seen.add(candidate);
    found.push({ path: candidate, bytes });
  }

  // No leading boundary class: the path is often preceded by Chinese punctuation ("喏，/workspace/x"),
  // and enumerating every such character is how the first version missed the real case.
  const pattern = /(?<![\w.-])\/?workspace\/[^\s，。、；：！？）)」"'`]+/g;
  for (const match of body.matchAll(pattern)) {
    if (found.length >= max) break;
    const raw = match[0].replace(/[.,;:]+$/, "");
    if (!ATTACHMENT_EXTS.includes(path.extname(raw).toLowerCase())) continue;

    const relative = raw.replace(/^\/?workspace\/?/, "");
    if (!relative) continue;
    const resolved = path.resolve(workspace, relative);
    const rel = path.relative(workspace, resolved);
    if (rel.startsWith("..") || path.isAbsolute(rel)) continue;
    if (seen.has(resolved)) continue;

    let bytes = 0;
    try {
      const stat = statSync(resolved);
      if (!stat.isFile() || stat.size === 0) continue;
      bytes = stat.size;
    } catch {
      continue; // mentioned but missing — nothing to send
    }

    seen.add(resolved);
    found.push({ path: resolved, bytes });
  }
  return found;
}

/** Strip the bare path from the reply once the file has been delivered by the runtime. */
export function softenMention(text: string, attachments: Attachment[], workspace = "/workspace"): string {
  let out = String(text ?? "");
  for (const attachment of attachments) {
    const relative = path.relative(workspace, attachment.path).replace(/\\/g, "/");
    const escaped = relative.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`(?:/workspace/|workspace/)${escaped}`, "g"), `附件：${path.basename(attachment.path)}`);
  }
  return out;
}

export { existsSync };

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Skill } from "@agent-jig/contracts";

/**
 * Skills are `SKILL.md` files under `.claude/skills/<name>/` — in the repo
 * (project skills) and in `~/.claude/skills/` (user skills). We discover, parse,
 * and write them for the in-app skills browser and creator.
 */

const SKILLS_SUBDIR = join(".claude", "skills");

/** System prompt for the model-assisted skill creator. */
export const SKILL_AUTHOR_SYSTEM = `You author Claude "skills" — reusable instruction files. Produce a complete SKILL.md: YAML frontmatter with \`name\` (short, kebab-case) and \`description\` (one line, when to use it), then a concise Markdown body of instructions. Output ONLY the file contents (starting with \`---\`), no commentary or code fences.`;

/** Parse YAML-ish frontmatter (name/description) and return it plus the body. */
function parseSkill(raw: string): { name?: string; description?: string; body: string } {
  if (!raw.startsWith("---")) return { body: raw };
  const end = raw.indexOf("\n---", 3);
  if (end === -1) return { body: raw };
  const front = raw.slice(3, end);
  const body = raw.slice(end + 4).replace(/^\r?\n/, "");
  const get = (key: string) => {
    const m = front.match(new RegExp(`^${key}\\s*:\\s*(.+)$`, "m"));
    return m?.[1] ? m[1].trim().replace(/^["']|["']$/g, "") : undefined;
  };
  return { name: get("name"), description: get("description"), body };
}

function scan(baseDir: string, scope: Skill["scope"]): Skill[] {
  const root = join(baseDir, SKILLS_SUBDIR);
  if (!existsSync(root)) return [];
  const skills: Skill[] = [];
  let entries: string[];
  try {
    entries = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
  for (const dir of entries) {
    const path = join(root, dir, "SKILL.md");
    if (!existsSync(path)) continue;
    try {
      const parsed = parseSkill(readFileSync(path, "utf8"));
      skills.push({
        name: parsed.name ?? dir,
        description: parsed.description ?? "",
        scope,
        path,
        body: parsed.body,
      });
    } catch {
      // skip unreadable
    }
  }
  return skills;
}

/** All skills visible to a session: project skills first, then user skills. */
export function listSkills(repoPath: string): Skill[] {
  return [...scan(repoPath, "repo"), ...scan(homedir(), "user")];
}

/** Filesystem-safe directory name for a skill. */
function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "skill"
  );
}

/** Write a SKILL.md (creating the dir); returns the absolute path. */
export function saveSkill(
  repoPath: string,
  scope: Skill["scope"],
  name: string,
  body: string,
): string {
  const base = scope === "user" ? homedir() : repoPath;
  const dir = join(base, SKILLS_SUBDIR, slug(name));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "SKILL.md");
  // Ensure frontmatter with the name exists; prepend a minimal one if missing.
  const content = body.startsWith("---")
    ? body
    : `---\nname: ${name}\ndescription: ${name}\n---\n\n${body}`;
  writeFileSync(path, content, "utf8");
  return path;
}

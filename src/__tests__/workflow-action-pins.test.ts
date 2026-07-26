import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const workflows = resolve(process.cwd(), ".gitea", "workflows");

test("all external workflow actions use immutable commit refs", () => {
  const mutable: string[] = [];

  for (const name of readdirSync(workflows).filter((entry) =>
    entry.endsWith(".yml") || entry.endsWith(".yaml")
  )) {
    const source = readFileSync(resolve(workflows, name), "utf8");
    for (const match of source.matchAll(
      /^\s*(?:-\s*)?uses:\s+([^@\s#]+)@([^\s#]+)/gm
    )) {
      const [, action, ref] = match;
      if (!action.startsWith("./") && !/^[0-9a-f]{40}$/.test(ref)) {
        mutable.push(`${name}: ${action}@${ref}`);
      }
    }
  }

  expect(mutable).toEqual([]);
});

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "..", "..");
const retiredTools = [
  "list_channel_adapters",
  "list_channels",
  "add_channel",
  "update_channel",
  "remove_channel",
  "send_channel_message",
  "test_channel",
  "discover_channel_chats",
];

test("native Core channel tools and route client stay retired", () => {
  expect(existsSync(join(root, "src", "tools", "channels.ts"))).toBe(false);

  const index = readFileSync(join(root, "src", "index.ts"), "utf8");
  const readme = readFileSync(join(root, "README.md"), "utf8");
  const contributorGuide = readFileSync(join(root, "CLAUDE.md"), "utf8");

  for (const retired of retiredTools) {
    expect(index).not.toContain(retired);
    expect(readme).not.toContain(`\`${retired}\``);
    expect(contributorGuide).not.toContain(`\`${retired}\``);
  }
  expect(index).not.toContain("registerChannelTools");
  expect(readme).toContain("kind: channel");
  expect(readme).toContain("install_plugin");
});

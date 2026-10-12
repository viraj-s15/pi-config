import { fileURLToPath } from "node:url";
import { createTestLoader } from "./pi-runtime.mjs";

const suites = {
  btw: "../extensions/btw/tests/btw.test.ts",
  "oxo-ui": "../extensions/oxo-ui/tests/rolling-tps.test.ts",
  "paste-fold": "../extensions/paste-fold/tests/paste-fold.test.ts",
  "user-bar": "../extensions/user-bar/tests/user-bar.test.ts",
  "image-paste": ["../extensions/image-paste/tests/attach.test.ts", "../extensions/image-paste/tests/clipboard.test.ts", "../extensions/image-paste/chips.test.mjs", "../extensions/image-paste/oxo-editor.test.mjs"],
  "compact-tools": ["../extensions/compact-tools/tests/summaries.test.ts", "../extensions/compact-tools/tests/renderer.test.ts", "../extensions/compact-tools/tests/tool-groups.test.ts", "../extensions/compact-tools/tests/thinking-label.test.ts"],
  notifications: "../extensions/notifications/tests/notifications.test.ts",
  actions: "../extensions/actions/tests/actions.test.mjs",
  "ask-user": "../extensions/ask-user/tests/ask-user.test.ts",
  "working-verbs": "../extensions/working-verbs/tests/activity.test.ts",
  context: "../extensions/context/tests/context.test.ts",
  checkpoints: "../extensions/checkpoints/tests/checkpoints.test.ts",
  "edit-check": "../extensions/edit-check/tests/edit-check.test.ts",
  subagent: "../extensions/subagent/tests/hub.test.ts",
  "todo-widget": "../extensions/todo-widget/tests/todo-widget.test.ts",
  usage: ["../extensions/usage/tests/codex-auth.test.ts", "../extensions/usage/tests/spend.test.ts", "../extensions/usage/tests/cost-chart.test.ts"],
};
const requested = process.argv.slice(2);
const selected = requested.length ? requested : Object.keys(suites);
if (selected.some(name => !Object.hasOwn(suites, name))) {
  console.error(`Usage: node tests/run.mjs [${Object.keys(suites).join("] [")}]`);
  process.exit(2);
}
const loader = await createTestLoader();
for (const name of new Set(selected)) {
  for (const file of [suites[name]].flat()) await loader.import(fileURLToPath(new URL(file, import.meta.url)));
}

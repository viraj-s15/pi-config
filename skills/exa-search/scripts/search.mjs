import { searchWeb } from "../../../extensions/exa/client.mjs";

const query = process.argv.slice(2).join(" ");
if (!query.trim()) {
  console.error('Usage: node search.mjs "your search query"');
  process.exitCode = 1;
} else {
  try {
    console.log(JSON.stringify(await searchWeb({ query }), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

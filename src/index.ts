import { runCli } from "./cli.ts";

runCli().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

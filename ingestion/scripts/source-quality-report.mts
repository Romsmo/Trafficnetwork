/**
 * Per-source quality report from what the importers recorded in STATE_DIR (src/report/quality.ts):
 * what each source took over, discarded (with the reasons) and merged into another source.
 *
 *   npm run report:quality                      # Markdown for every source found in STATE_DIR
 *   npm run report:quality -- --json            # the same as JSON
 *   npm run report:quality -- --state-dir D:\state --region norway --source nvdb-no
 */
import { collectSourceQuality, renderQualityMarkdown } from "../src/report/quality.js";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const stateDir = arg("--state-dir") ?? process.env.STATE_DIR ?? "./.ingestion-state";
const items = await collectSourceQuality(stateDir, { region: arg("--region"), source: arg("--source") });
if (process.argv.includes("--json")) console.log(JSON.stringify({ generatedAt: new Date().toISOString(), sources: items }, null, 2));
else process.stdout.write(renderQualityMarkdown(items, new Date()));

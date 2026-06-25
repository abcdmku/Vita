import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { createPendingReport, evaluateReport, parseReportJson, type EngineName, type ReportEvaluation, type SpikeReport } from "./report.ts";

interface CliOptions {
  readonly nativePath?: string;
  readonly outPath: string;
  readonly durationMs: number;
}

function parseArgs(argv: readonly string[]): CliOptions {
  let nativePath: string | undefined;
  let outPath = "artifacts/latest-report.json";
  let durationMs = 5000;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) {
      continue;
    }
    if (arg === "--native") {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new Error("--native requires a path");
      }
      nativePath = value;
      index += 1;
    } else if (arg === "--out") {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new Error("--out requires a path");
      }
      outPath = value;
      index += 1;
    } else if (arg === "--duration-ms") {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new Error("--duration-ms requires a number");
      }
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error("--duration-ms must be a positive integer");
      }
      durationMs = parsed;
      index += 1;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  return nativePath === undefined ? { outPath, durationMs } : { nativePath, outPath, durationMs };
}

function runNative(nativePath: string, engine: EngineName, durationMs: number): SpikeReport {
  const appPath = resolve("assets/heavy-app.html");
  const stdout = execFileSync(resolve(nativePath), [`--engine=${engine}`, `--app=${appPath}`, `--duration-ms=${durationMs}`], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  const decoded = parseReportJson(stdout);
  if (!decoded.ok) {
    throw new Error(decoded.error);
  }
  return decoded.value;
}

function mergeReports(reports: readonly SpikeReport[]): SpikeReport {
  const runs = reports.flatMap((report) => report.runs);
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    budgetFps: 60,
    runs,
    notes: reports.flatMap((report) => report.notes)
  };
}

function summaryPathFor(reportPath: string): string {
  const extension = extname(reportPath);
  return extension.length === 0 ? `${reportPath}.summary.md` : `${reportPath.slice(0, -extension.length)}.summary.md`;
}

function formatSummary(report: SpikeReport, evaluation: ReportEvaluation): string {
  const lines: string[] = [
    "# PSD-000 Measurement Summary",
    "",
    `Generated: ${report.generatedAt}`,
    `Budget: ${report.budgetFps}fps`,
    `Verdict: ${evaluation.verdict}`,
    "",
    "| Engine | Status | FPS | No repaint | Shared texture reused | Screenshot |",
    "|---|---:|---:|---:|---:|---|"
  ];

  for (let index = 0; index < evaluation.runs.length; index += 1) {
    const evaluated = evaluation.runs[index];
    const source = report.runs[index];
    if (evaluated === undefined || source === undefined) {
      continue;
    }
    lines.push(
      `| ${evaluated.engine} | ${evaluated.status} | ${evaluated.fps.toFixed(1)} | ${String(evaluated.noRepaintDuringMotion)} | ${String(evaluated.sharedTextureReused)} | ${source.screenshot.path} |`
    );
  }

  lines.push("", "## Frame-Time Histograms", "");
  for (let index = 0; index < evaluation.runs.length; index += 1) {
    const evaluated = evaluation.runs[index];
    if (evaluated === undefined) {
      continue;
    }
    lines.push(`### ${evaluated.engine}`, "");
    lines.push(`p50=${evaluated.frameTime.p50Ms.toFixed(2)}ms p95=${evaluated.frameTime.p95Ms.toFixed(2)}ms p99=${evaluated.frameTime.p99Ms.toFixed(2)}ms`);
    lines.push("");
    lines.push("| Bucket | Frames |");
    lines.push("|---|---:|");
    for (let bucketIndex = 0; bucketIndex < evaluated.frameTime.histogram.length; bucketIndex += 1) {
      const bucket = evaluated.frameTime.histogram[bucketIndex];
      if (bucket === undefined) {
        continue;
      }
      lines.push(`| ${bucket.label} | ${bucket.count} |`);
    }
    if (evaluated.reasons.length > 0) {
      lines.push("", "Reasons:");
      for (let reasonIndex = 0; reasonIndex < evaluated.reasons.length; reasonIndex += 1) {
        const reason = evaluated.reasons[reasonIndex];
        if (reason !== undefined) {
          lines.push(`- ${reason}`);
        }
      }
    }
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  let report: SpikeReport;

  if (options.nativePath === undefined) {
    report = createPendingReport(new Date().toISOString());
  } else {
    const cef = runNative(options.nativePath, "cef", options.durationMs);
    const cefEvaluation = evaluateReport(cef);
    if (cefEvaluation.verdict === "cef") {
      report = cef;
    } else {
      const wpe = runNative(options.nativePath, "wpe", options.durationMs);
      report = mergeReports([cef, wpe]);
    }
  }

  const outputPath = resolve(options.outPath);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  const reread = parseReportJson(readFileSync(outputPath, "utf8"));
  if (!reread.ok) {
    throw new Error(reread.error);
  }
  const evaluation = evaluateReport(reread.value);
  const summaryPath = summaryPathFor(outputPath);
  writeFileSync(summaryPath, formatSummary(reread.value, evaluation), "utf8");
  console.log(`verdict=${evaluation.verdict}`);
  console.log(`summary=${summaryPath}`);
  for (let index = 0; index < evaluation.runs.length; index += 1) {
    const run = evaluation.runs[index];
    if (run === undefined) {
      continue;
    }
    console.log(`${run.engine}: ${run.status}, ${run.fps.toFixed(1)}fps`);
  }
}

main();

import { Issue } from "../gitlabapi";
import { marked } from "marked";

export interface AzureMappingOptions {
  areaPath: string;
  iterationPath: string;
  defaultTags: string;
}

export interface AzureCsvRow {
  ID: string;
  "System Info": string;
  Title: string;
  "Work Item Type": string;
  Tags: string;
  State: string;
  Priority: string;
  Effort: string;
  "Repro Steps": string;
  Description: string;
  "Area Path": string;
  "Iteration Path": string;
}

const EFFORT_REGEX = /(?:### )?Effort(?:\(h\))?[\s\n\r]+(\d+)/i;

function labelsToNames(labels: Issue["labels"]): string[] {
  return (labels || []).map((label) => {
    if (typeof label === "string") {
      return label;
    }
    return label.name || "";
  });
}

const GITLAB_TO_AZURE_STATE: Record<string, string> = {
  approved: "Approved",
  "needs-analysis": "New",
  needsanalysis: "New",
  "needs-triage": "New",
  needstriage: "New",
  package: "Committed",
  tested: "Done",
};

function normalizeStateFromLabels(labels: string[]): string {
  for (const label of labels) {
    const match = label.match(/^status:\s*(.+)$/i);
    if (!match) {
      continue;
    }
    // Normalize: lowercase, collapse spaces to hyphens, strip leading/trailing
    const raw = match[1].trim().toLowerCase().replace(/\s+/g, "-");
    const noHyphen = raw.replace(/-/g, "");
    const azureState = GITLAB_TO_AZURE_STATE[raw] ?? GITLAB_TO_AZURE_STATE[noHyphen];
    if (azureState) {
      return azureState;
    }
  }
  return "New";
}

function normalizePriorityFromLabels(labels: string[]): string {
  const fullText = labels.join(" ");
  const match = fullText.match(/priority:(\d+)/i);
  if (!match) {
    return "";
  }

  const priority = Number.parseInt(match[1] ?? "", 10);
  if (!Number.isFinite(priority)) {
    return "";
  }

  return String(priority + 1);
}

function extractEffort(description: string): string {
  const match = EFFORT_REGEX.exec(description);
  return match?.[1] ?? "0";
}

function isBugTitle(title: string): boolean {
  return title.toLowerCase().includes("bug");
}

function csvEscape(value: string): string {
  const normalized = value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (/[",\n]/.test(normalized)) {
    return `"${normalized.replace(/"/g, '""')}"`;
  }
  return normalized;
}

function markdownToHtml(markdown: string): string {
  const parsed = marked.parse(markdown);
  return typeof parsed === "string" ? parsed : markdown;
}

export function issueToAzureCsvRow(
  issue: Issue,
  descriptionWithEmbeddedMedia: string,
  options: AzureMappingOptions,
): AzureCsvRow {
  const title = `${issue.iid} ${issue.title || "Untitled"}`;
  const isBug = isBugTitle(title);
  const labels = labelsToNames(issue.labels);
  const url = issue.web_url || "";

  const defaultTags = options.defaultTags?.trim();
  const labelTags = labels.join(",");
  const tags = [labelTags, defaultTags].filter((value) => value && value.length > 0).join(",");

  const markdownDescription = `[#${issue.iid}](${url})\n\n${descriptionWithEmbeddedMedia}`;
  const htmlDescription = markdownToHtml(markdownDescription);

  return {
    ID: "",
    "System Info": "",
    Title: title,
    "Work Item Type": isBug ? "Bug" : "Product Backlog Item",
    Tags: tags,
    State: normalizeStateFromLabels(labels),
    Priority: normalizePriorityFromLabels(labels),
    Effort: extractEffort(descriptionWithEmbeddedMedia),
    "Repro Steps": isBug ? htmlDescription : "",
    Description: isBug ? "" : htmlDescription,
    "Area Path": options.areaPath,
    "Iteration Path": options.iterationPath,
  };
}

export function toAzureCsv(rows: AzureCsvRow[]): string {
  const headers: Array<keyof AzureCsvRow> = [
    "ID",
    "System Info",
    "Title",
    "Work Item Type",
    "Tags",
    "State",
    "Priority",
    "Effort",
    "Repro Steps",
    "Description",
    "Area Path",
    "Iteration Path",
  ];

  const lines: string[] = [];
  lines.push(headers.join(","));

  for (const row of rows) {
    const values = headers.map((header) => csvEscape(row[header] || ""));
    lines.push(values.join(","));
  }

  return `${lines.join("\n")}\n`;
}

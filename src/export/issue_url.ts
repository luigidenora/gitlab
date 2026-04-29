export interface ParsedIssueRef {
  originalUrl: string;
  projectPath: string;
  itemType: "issues" | "work_items";
  itemIid: number;
}

export interface IssueUrlParseResult {
  refs: ParsedIssueRef[];
  errors: string[];
}

const ISSUE_URL_REGEX = /https?:\/\/[^\s)]+\/-\/(issues|work_items)\/\d+[^\s)]*/gi;

function normalizeIssueUrl(rawUrl: string): string {
  return rawUrl.trim().replace(/[),.;]+$/, "");
}

function parseIssueUrl(rawUrl: string): ParsedIssueRef | undefined {
  const url = new URL(normalizeIssueUrl(rawUrl));
  const segments = url.pathname.split("/").filter(Boolean);
  const separatorIndex = segments.findIndex((segment) => segment === "-");

  if (separatorIndex <= 0) {
    return undefined;
  }

  const itemType = segments[separatorIndex + 1];
  if (itemType !== "issues" && itemType !== "work_items") {
    return undefined;
  }

  const itemIidRaw = segments[separatorIndex + 2];
  const itemIid = Number.parseInt(itemIidRaw ?? "", 10);

  if (!Number.isFinite(itemIid) || itemIid <= 0) {
    return undefined;
  }

  const projectPath = segments.slice(0, separatorIndex).join("/");
  if (!projectPath) {
    return undefined;
  }

  return {
    originalUrl: url.toString(),
    projectPath,
    itemType,
    itemIid,
  };
}

export function parseIssueUrls(input: string): IssueUrlParseResult {
  const refs: ParsedIssueRef[] = [];
  const errors: string[] = [];
  const dedupe = new Set<string>();

  const matches = input.match(ISSUE_URL_REGEX) ?? [];
  if (matches.length <= 0) {
    return {
      refs: [],
      errors: ["No valid issue/work item URLs found in input text."],
    };
  }

  for (const rawUrl of matches) {
    try {
      const parsed = parseIssueUrl(rawUrl);
      if (!parsed) {
        errors.push(`Unsupported issue/work item URL format: ${rawUrl}`);
        continue;
      }

      const key = `${parsed.projectPath}/${parsed.itemType}#${parsed.itemIid}`;
      if (dedupe.has(key)) {
        continue;
      }

      dedupe.add(key);
      refs.push(parsed);
    } catch {
      errors.push(`Invalid URL: ${rawUrl}`);
    }
  }

  return { refs, errors };
}

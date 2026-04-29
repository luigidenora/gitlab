import {
  Action,
  ActionPanel,
  Clipboard,
  Form,
  getPreferenceValues,
  open,
  popToRoot,
  showToast,
  Toast,
} from "@raycast/api";
import { useState } from "react";
import os from "os";
import path from "path";
import fs from "fs/promises";

import { gitlab } from "./common";
import { issueToAzureCsvRow, toAzureCsv } from "./export/azure_csv";
import { parseIssueUrls } from "./export/issue_url";
import { embedIssueMediaInMarkdown } from "./export/media_embed";
import { getErrorMessage } from "./utils";

interface Preferences {
  exportOutputDir?: string;
}

interface ExportFormValues {
  issueUrlsInput: string;
  areaPath: string;
  iterationPath: string;
  defaultTags: string;
  embedVideos: boolean;
}

interface ExportProgress {
  current: number;
  total: number;
  successCount: number;
  warningCount: number;
  currentLabel: string;
  lastItem?: {
    label: string;
    status: "ok" | "warn";
    message?: string;
  };
}

interface ExportResult {
  outputRowsCount: number;
  warnings: string[];
  outputFile: string;
  outputDir: string;
}

function getOutputDirectory(): string {
  const preferences = getPreferenceValues<Preferences>();
  const configuredPath = preferences.exportOutputDir?.trim();
  if (configuredPath && configuredPath.length > 0) {
    return configuredPath;
  }
  return path.join(os.homedir(), "Downloads");
}

async function runExport(
  values: ExportFormValues,
  onProgress: (progress: ExportProgress) => void,
): Promise<ExportResult> {
  const parseResult = parseIssueUrls(values.issueUrlsInput || "");

  if (parseResult.refs.length <= 0) {
    throw new Error(parseResult.errors.join("\n") || "No issue/work item URLs to process.");
  }

  const outputRows = [];
  const warnings: string[] = [...parseResult.errors];
  let successCount = 0;

  for (let i = 0; i < parseResult.refs.length; i++) {
    const ref = parseResult.refs[i];
    const current = i + 1;
    const currentLabel = `${ref.projectPath}/${ref.itemType}#${ref.itemIid}`;

    onProgress({
      current,
      total: parseResult.refs.length,
      successCount,
      warningCount: warnings.length,
      currentLabel,
    });

    try {
      const project = await gitlab.getProjectByPath(ref.projectPath);
      const issue =
        ref.itemType === "work_items"
          ? await gitlab.getWorkItem(project.id, ref.itemIid)
          : await gitlab.getIssue(project.id, ref.itemIid, {});

      const descriptionWithEmbeddedMedia = await embedIssueMediaInMarkdown(
        issue.description || "",
        issue.web_url,
        gitlab,
        project.id,
        values.embedVideos,
      );

      const row = issueToAzureCsvRow(issue, descriptionWithEmbeddedMedia, {
        areaPath: values.areaPath,
        iterationPath: values.iterationPath,
        defaultTags: values.defaultTags,
      });

      outputRows.push(row);
      successCount++;

      onProgress({
        current,
        total: parseResult.refs.length,
        successCount,
        warningCount: warnings.length,
        currentLabel,
        lastItem: {
          label: currentLabel,
          status: "ok",
        },
      });
    } catch (error) {
      const message = getErrorMessage(error);
      warnings.push(`Issue ${currentLabel}: ${message}`);

      onProgress({
        current,
        total: parseResult.refs.length,
        successCount,
        warningCount: warnings.length,
        currentLabel,
        lastItem: {
          label: currentLabel,
          status: "warn",
          message,
        },
      });
    }
  }

  if (outputRows.length <= 0) {
    throw new Error(warnings.join("\n") || "No rows generated for CSV.");
  }

  const csv = toAzureCsv(outputRows);
  const outputDir = getOutputDirectory();
  await fs.mkdir(outputDir, { recursive: true });

  const fileName = `gitlab-issues-azure-${new Date().toISOString().replace(/[:.]/g, "-")}.csv`;
  const outputFile = path.join(outputDir, fileName);
  await fs.writeFile(outputFile, csv, "utf-8");

  return {
    outputRowsCount: outputRows.length,
    warnings,
    outputFile,
    outputDir,
  };
}

export default function ExportIssuesToAzureCsvCommand() {
  const [isLoading, setIsLoading] = useState(false);
  const [uiError, setUiError] = useState<string>();
  const [uiWarnings, setUiWarnings] = useState<string[]>([]);
  const [progressInfo, setProgressInfo] = useState<ExportProgress>();
  const [progressItems, setProgressItems] = useState<Array<{ label: string; status: "ok" | "warn"; message?: string }>>(
    [],
  );

  const warningPreview = uiWarnings.slice(0, 8).join("\n");

  async function onSubmit(values: ExportFormValues) {
    setIsLoading(true);
    setUiError(undefined);
    setUiWarnings([]);
    setProgressInfo(undefined);
    setProgressItems([]);

    const progressToast = await showToast({
      style: Toast.Style.Animated,
      title: "Exporting Azure Csv",
      message: "Preparing issue list...",
    });

    try {
      const result = await runExport(values, (progress) => {
        setProgressInfo(progress);
        if (progress.lastItem) {
          setProgressItems((prev) => [progress.lastItem!, ...prev].slice(0, 10));
        }
        progressToast.title = `Processing ${progress.current}/${progress.total}`;
        progressToast.message = `${progress.currentLabel} | success: ${progress.successCount}, warnings: ${progress.warningCount}`;
      });

      const warningCount = result.warnings.length;
      progressToast.style = Toast.Style.Success;
      progressToast.title = "Azure Csv Exported";
      progressToast.message = `${result.outputRowsCount} rows saved${warningCount > 0 ? `, ${warningCount} warning(s)` : ""}`;
      progressToast.primaryAction = {
        title: "Open Output Folder",
        onAction: async () => {
          await open(result.outputDir);
        },
      };
      progressToast.secondaryAction = {
        title: "Copy File Path",
        onAction: async () => {
          await Clipboard.copy(result.outputFile);
        },
      };

      await open(result.outputFile);

      if (warningCount > 0) {
        setUiWarnings(result.warnings);
      } else {
        await popToRoot();
      }
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      progressToast.style = Toast.Style.Failure;
      progressToast.title = "Azure Csv Export Failed";
      progressToast.message = errorMessage;
      setUiError(errorMessage);
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <Form
      isLoading={isLoading}
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Export Csv for Azure" onSubmit={onSubmit} />
          {uiError ? <Action.CopyToClipboard title="Copy Last Error" content={uiError} /> : null}
          {uiWarnings.length > 0 ? (
            <Action.CopyToClipboard title="Copy Warnings" content={uiWarnings.join("\n")} />
          ) : null}
        </ActionPanel>
      }
    >
      {uiError ? <Form.Description title="Last Error" text={uiError} /> : null}
      {uiWarnings.length > 0 ? (
        <Form.Description
          title="Warnings"
          text={`${warningPreview}${uiWarnings.length > 8 ? `\n...and ${uiWarnings.length - 8} more` : ""}`}
        />
      ) : null}
      {isLoading ? (
        <>
          <Form.Description
            title="Progress"
            text={`Processing ${progressInfo?.current ?? 0}/${progressInfo?.total ?? 0}\nCurrent: ${progressInfo?.currentLabel ?? "-"}\nSuccess: ${progressInfo?.successCount ?? 0}\nWarnings: ${progressInfo?.warningCount ?? 0}`}
          />
          <Form.Description
            title="Recent Items"
            text={
              progressItems.length > 0
                ? progressItems
                    .map(
                      (item) =>
                        `${item.status === "ok" ? "OK" : "WARN"} | ${item.label}${item.message ? ` | ${item.message}` : ""}`,
                    )
                    .join("\n")
                : "Waiting for first item..."
            }
          />
        </>
      ) : (
        <>
          <Form.TextArea
            id="issueUrlsInput"
            title="Issue/Work Item URLs"
            placeholder="Paste issue/work item URLs in free text (one or more). The command clones GitLab uploads and embeds media in CSV."
            info="Examples: https://gitlab.com/group/project/-/issues/123 or .../-/work_items/123"
          />
          <Form.Separator />
          <Form.TextField id="areaPath" title="Default Area Path" placeholder="MyOrg\\MyArea" storeValue />
          <Form.TextField id="iterationPath" title="Default Iteration Path" placeholder="MyOrg\\Sprint 42" storeValue />
          <Form.TextField id="defaultTags" title="Default Tags" placeholder="migration,gitlab" storeValue />
          <Form.Checkbox id="embedVideos" label="Embed Videos as Base64 when possible" defaultValue={true} storeValue />
        </>
      )}
    </Form>
  );
}

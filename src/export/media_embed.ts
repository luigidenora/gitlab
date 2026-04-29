import type { GitLab } from "../gitlabapi";
import type { Response } from "node-fetch";

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"]);
const VIDEO_EXTENSIONS = new Set(["mp4", "webm", "mov", "m4v", "avi", "ogv"]);

function getIssueBaseUrl(issueUrl: string): string {
  return issueUrl.replace(/\/-\/(issues|work_items)\/\d+.*$/i, "");
}

function getExtension(urlPath: string): string {
  const clean = urlPath.split("?")[0].split("#")[0];
  const ext = clean.split(".").pop();
  return (ext ?? "").toLowerCase();
}

function stripUploadPrefix(relativePath: string): string {
  const clean = relativePath.split("?")[0].split("#")[0];
  return clean.replace(/^\/uploads\//i, "").replace(/^\/+/, "");
}

function escapeHtmlAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function toDataUrl(mimeType: string, payload: Buffer): string {
  return `data:${mimeType};base64,${payload.toString("base64")}`;
}

function isHtmlPayload(mimeType: string, payload: Buffer): boolean {
  if (mimeType.toLowerCase().startsWith("text/html")) {
    return true;
  }

  const head = payload.subarray(0, 600).toString("utf8").toLowerCase();
  return head.includes("<!doctype html") || head.includes("<html");
}

function getImageDimensions(payload: Buffer, mimeType: string): { width: number; height: number } | undefined {
  const mime = mimeType.toLowerCase();

  if (mime === "image/png" && payload.length >= 24) {
    const pngSignature = "89504e470d0a1a0a";
    if (payload.subarray(0, 8).toString("hex") === pngSignature) {
      const width = payload.readUInt32BE(16);
      const height = payload.readUInt32BE(20);
      if (width > 0 && height > 0) {
        return { width, height };
      }
    }
  }

  if (
    (mime === "image/jpeg" || mime === "image/jpg") &&
    payload.length > 4 &&
    payload[0] === 0xff &&
    payload[1] === 0xd8
  ) {
    let offset = 2;
    while (offset + 9 < payload.length) {
      if (payload[offset] !== 0xff) {
        break;
      }

      const marker = payload[offset + 1];
      const size = payload.readUInt16BE(offset + 2);
      const isSOFMarker =
        marker === 0xc0 ||
        marker === 0xc1 ||
        marker === 0xc2 ||
        marker === 0xc3 ||
        marker === 0xc5 ||
        marker === 0xc6 ||
        marker === 0xc7 ||
        marker === 0xc9 ||
        marker === 0xca ||
        marker === 0xcb ||
        marker === 0xcd ||
        marker === 0xce ||
        marker === 0xcf;

      if (isSOFMarker && offset + 8 < payload.length) {
        const height = payload.readUInt16BE(offset + 5);
        const width = payload.readUInt16BE(offset + 7);
        if (width > 0 && height > 0) {
          return { width, height };
        }
      }

      if (size < 2) {
        break;
      }
      offset += 2 + size;
    }
  }

  if (mime === "image/gif" && payload.length >= 10) {
    const header = payload.subarray(0, 6).toString("ascii");
    if (header === "GIF87a" || header === "GIF89a") {
      const width = payload.readUInt16LE(6);
      const height = payload.readUInt16LE(8);
      if (width > 0 && height > 0) {
        return { width, height };
      }
    }
  }

  if (mime === "image/bmp" && payload.length >= 26 && payload.subarray(0, 2).toString("ascii") === "BM") {
    const width = Math.abs(payload.readInt32LE(18));
    const height = Math.abs(payload.readInt32LE(22));
    if (width > 0 && height > 0) {
      return { width, height };
    }
  }

  if (mime === "image/webp" && payload.length >= 30 && payload.subarray(0, 4).toString("ascii") === "RIFF") {
    const webp = payload.subarray(8, 12).toString("ascii");
    if (webp === "WEBP") {
      const chunk = payload.subarray(12, 16).toString("ascii");

      if (chunk === "VP8X" && payload.length >= 30) {
        const widthMinusOne = payload.readUIntLE(24, 3);
        const heightMinusOne = payload.readUIntLE(27, 3);
        return { width: widthMinusOne + 1, height: heightMinusOne + 1 };
      }

      if (chunk === "VP8 " && payload.length >= 30) {
        const width = payload.readUInt16LE(26) & 0x3fff;
        const height = payload.readUInt16LE(28) & 0x3fff;
        if (width > 0 && height > 0) {
          return { width, height };
        }
      }

      if (chunk === "VP8L" && payload.length >= 25) {
        const b0 = payload[21];
        const b1 = payload[22];
        const b2 = payload[23];
        const b3 = payload[24];
        const width = 1 + (((b1 & 0x3f) << 8) | b0);
        const height = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
        if (width > 0 && height > 0) {
          return { width, height };
        }
      }
    }
  }

  return undefined;
}

interface MediaData {
  dataUrl: string;
  mimeType: string;
  dimensions?: {
    width: number;
    height: number;
  };
}

async function readValidMediaResponse(response: Response): Promise<MediaData | undefined> {
  if (!response.ok) {
    return undefined;
  }

  const arrayBuffer = await response.arrayBuffer();
  const payload = Buffer.from(arrayBuffer);
  if (payload.length <= 0) {
    return undefined;
  }

  const mimeType = response.headers.get("content-type")?.split(";")[0].trim() || "application/octet-stream";
  if (isHtmlPayload(mimeType, payload)) {
    return undefined;
  }

  const ext = getExtension(response.url || "");
  const isImage = IMAGE_EXTENSIONS.has(ext) || mimeType.startsWith("image/");
  const isVideo = VIDEO_EXTENSIONS.has(ext) || mimeType.startsWith("video/");
  const isMedia = isImage || isVideo;

  if (!isMedia) {
    return undefined;
  }

  return {
    dataUrl: toDataUrl(mimeType, payload),
    mimeType,
    dimensions: isImage ? getImageDimensions(payload, mimeType) : undefined,
  };
}

async function downloadAsDataUrl(
  gitlab: GitLab,
  fileUrl: string,
  projectId: number,
  relativePath: string,
): Promise<MediaData | undefined> {
  const directResponse = await gitlab.fetchRaw(fileUrl);
  const directMedia = await readValidMediaResponse(directResponse);
  if (directMedia) {
    return directMedia;
  }

  const uploadPath = stripUploadPrefix(relativePath);
  if (!uploadPath) {
    return undefined;
  }

  const fallbackResponse = await gitlab.fetchProjectUpload(projectId, uploadPath);
  return await readValidMediaResponse(fallbackResponse);
}

function toImageHtmlTag(alt: string, dataUrl: string, dimensions?: { width: number; height: number }): string {
  const escapedAlt = escapeHtmlAttr(alt || "image");
  const sizeAttrs = dimensions ? ` width="${dimensions.width}" height="${dimensions.height}"` : "";
  return `<img alt="${escapedAlt}" src="${dataUrl}"${sizeAttrs} />`;
}

export async function embedIssueMediaInMarkdown(
  markdownContent: string,
  issueUrl: string,
  gitlab: GitLab,
  projectId: number,
  embedVideos: boolean,
): Promise<string> {
  let updated = markdownContent || "";
  const issueBaseUrl = getIssueBaseUrl(issueUrl);

  const imageRegex = /!\[([^\]]*)\]\((\/uploads\/[^)\s]+)\)/g;
  const imageMatches = [...updated.matchAll(imageRegex)];

  for (const match of imageMatches) {
    const alt = match[1] || "image";
    const relativePath = match[2];
    const absoluteUrl = `${issueBaseUrl}${relativePath}`;

    try {
      const downloaded = await downloadAsDataUrl(gitlab, absoluteUrl, projectId, relativePath);
      if (!downloaded) {
        updated = updated.replace(match[0], `![${alt}](attachment-unavailable:${relativePath})`);
        continue;
      }

      const isImage = downloaded.mimeType.startsWith("image/") || IMAGE_EXTENSIONS.has(getExtension(relativePath));
      if (!isImage) {
        updated = updated.replace(match[0], `![${alt}](attachment-unavailable:${relativePath})`);
        continue;
      }

      updated = updated.replace(match[0], toImageHtmlTag(alt, downloaded.dataUrl, downloaded.dimensions));
    } catch {
      updated = updated.replace(match[0], `![${alt}](attachment-unavailable:${relativePath})`);
    }
  }

  const linkRegex = /\[([^\]]+)\]\((\/uploads\/[^)\s]+)\)/g;
  const linkMatches = [...updated.matchAll(linkRegex)];

  for (const match of linkMatches) {
    const label = match[1] || "attachment";
    const relativePath = match[2];
    const absoluteUrl = `${issueBaseUrl}${relativePath}`;
    const ext = getExtension(relativePath);

    try {
      const downloaded = await downloadAsDataUrl(gitlab, absoluteUrl, projectId, relativePath);
      if (!downloaded) {
        updated = updated.replace(match[0], `${label} (attachment unavailable)`);
        continue;
      }

      const isImage = IMAGE_EXTENSIONS.has(ext) || downloaded.mimeType.startsWith("image/");
      const isVideo = VIDEO_EXTENSIONS.has(ext) || downloaded.mimeType.startsWith("video/");

      if (isImage) {
        updated = updated.replace(match[0], toImageHtmlTag(label, downloaded.dataUrl, downloaded.dimensions));
        continue;
      }

      if (isVideo && embedVideos) {
        updated = updated.replace(
          match[0],
          `<video controls src="${downloaded.dataUrl}">${escapeHtmlAttr(label)}</video>`,
        );
        continue;
      }

      updated = updated.replace(match[0], `[${label}](${downloaded.dataUrl})`);
    } catch {
      updated = updated.replace(match[0], `${label} (attachment unavailable)`);
    }
  }

  return updated;
}

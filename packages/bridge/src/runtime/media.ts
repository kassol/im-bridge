/**
 * Telegram media turned into prompt content.
 *
 * The plan is built before anything is downloaded, so a prompt that cannot
 * work — an unsupported type, an advertised size over the ceiling, a fifth
 * image — costs no bytes and no Telegram call. What survives planning is a
 * list of file ids plus what each one may cost, which is exactly what the
 * memory budget needs to reserve.
 *
 * Nothing here reaches disk. The bytes exist as a buffer, become a base64
 * string, and are released with the prompt content that carried them.
 */
import type { PromptContentPart, PromptImageMediaType } from "../backends/types.ts";
import { TelegramFileTooLargeError, type TelegramApi } from "../telegram/api.ts";
import type { InboundDocument, InboundMessage, InboundPhotoSize } from "../telegram/updates.ts";

/** The hard ceiling on one image, advertised or streamed. */
export const IMAGE_LIMIT_BYTES = 5 * 1024 * 1024;
/** One prompt carries at most this many images. */
export const MAX_PROMPT_IMAGES = 4;
/** What an image without a caption asks the backend to do. */
export const IMAGE_ANALYSIS_TEXT = "请分析图片内容。";

const SUPPORTED_MEDIA_TYPES: readonly PromptImageMediaType[] = ["image/jpeg", "image/png", "image/webp"];
/** Telegram re-encodes every `photo` to JPEG, so a variant needs no MIME type. */
const PHOTO_MEDIA_TYPE: PromptImageMediaType = "image/jpeg";
const IMAGE_NAME_LIMIT = 255;
/** A separator or a control character would make the name a path or a header. */
const UNSAFE_IMAGE_NAME_PATTERN = /[\\/\u0000-\u001f\u007f]/u;

/** Why an input never reached the backend. Each maps to one short reply. */
export type MediaFailure = "too-many" | "unsupported-type" | "too-large" | "download-failed";

const NOTICES: Record<MediaFailure, string> = {
  "too-many": `一次最多 ${String(MAX_PROMPT_IMAGES)} 张图片。`,
  "unsupported-type": "不支持的图片类型。",
  "too-large": "图片超过 5 MiB。",
  "download-failed": "图片下载失败。",
};

/** The whole input failed. One input produces one of these, never several. */
export class MediaError extends Error {
  readonly failure: MediaFailure;

  constructor(failure: MediaFailure, options?: ErrorOptions) {
    super(`prompt media rejected: ${failure}`, options);
    this.name = "MediaError";
    this.failure = failure;
  }
}

export function mediaNotice(failure: MediaFailure): string {
  return NOTICES[failure];
}

/** One image to fetch. Nothing user-visible travels in here. */
export interface ImageRequest {
  readonly fileId: string;
  readonly mediaType: PromptImageMediaType;
  readonly name?: string;
  /** What this download may cost the memory budget. */
  readonly weightBytes: number;
}

export interface PromptPlan {
  /** The captions, or the fixed request when an image arrived without one. */
  readonly text: string;
  readonly images: readonly ImageRequest[];
  /** What to reserve before downloading: the sum of every image's ceiling. */
  readonly weightBytes: number;
}

/**
 * Plans one atomic input from the messages that make it up — one message, or
 * every member of an album. A rejected member rejects the whole input, which
 * is what makes an album atomic.
 */
export function planPrompt(messages: readonly InboundMessage[]): PromptPlan {
  const images: ImageRequest[] = [];
  const captions: string[] = [];
  for (const message of messages) {
    if (message.text !== undefined && message.text !== "") captions.push(message.text);
    const image = readImage(message);
    if (image !== undefined) images.push(image);
  }
  if (images.length > MAX_PROMPT_IMAGES) throw new MediaError("too-many");
  const text = captions.length > 0 ? captions.join("\n") : images.length > 0 ? IMAGE_ANALYSIS_TEXT : "";
  return {
    text,
    images,
    weightBytes: images.reduce((total, image) => total + image.weightBytes, 0),
  };
}

/**
 * Downloads every planned image, in the order the plan lists them.
 *
 * One failure fails the input: a partially downloaded album would reach the
 * backend as a different prompt from the one the user sent.
 */
export async function downloadImages(
  api: TelegramApi,
  images: readonly ImageRequest[],
  signal?: AbortSignal,
): Promise<PromptContentPart[]> {
  const parts: PromptContentPart[] = [];
  for (const image of images) {
    let bytes: Uint8Array;
    try {
      const filePath = await api.getFile(image.fileId, signal);
      bytes = await api.downloadFile({ filePath, limitBytes: IMAGE_LIMIT_BYTES, signal });
    } catch (error) {
      if (error instanceof TelegramFileTooLargeError) throw new MediaError("too-large", { cause: error });
      throw new MediaError("download-failed", { cause: error });
    }
    parts.push({
      type: "image",
      mediaType: image.mediaType,
      data: Buffer.from(bytes).toString("base64"),
      ...(image.name === undefined ? {} : { name: image.name }),
    });
  }
  return parts;
}

/** A document is explicit about its type, so it decides before a photo does. */
function readImage(message: InboundMessage): ImageRequest | undefined {
  if (message.document !== undefined) return fromDocument(message.document);
  if (message.photo !== undefined) return fromPhoto(message.photo);
  return undefined;
}

/**
 * Picks the variant to fetch.
 *
 * Telegram advertises several sizes of the same photo; the largest one that
 * fits carries the most detail the ceiling allows. The advertised size is only
 * a hint — the streaming limit still applies to whatever actually arrives.
 */
function fromPhoto(sizes: readonly InboundPhotoSize[]): ImageRequest {
  const fitting = sizes.filter((size) => size.fileSize === undefined || size.fileSize <= IMAGE_LIMIT_BYTES);
  const measured = fitting.filter(isMeasured);
  // Telegram lists variants smallest first, so the last one is the largest
  // when no variant advertises a size at all.
  const chosen = measured.length > 0
    ? measured.reduce((best, size) => (size.fileSize > best.fileSize ? size : best))
    : fitting.at(-1);
  if (chosen === undefined) throw new MediaError("too-large");
  return {
    fileId: chosen.fileId,
    mediaType: PHOTO_MEDIA_TYPE,
    weightBytes: chosen.fileSize ?? IMAGE_LIMIT_BYTES,
  };
}

function fromDocument(document: InboundDocument): ImageRequest {
  const mediaType = readMediaType(document.mimeType);
  if (mediaType === undefined) throw new MediaError("unsupported-type");
  if (document.fileSize !== undefined && document.fileSize > IMAGE_LIMIT_BYTES) {
    throw new MediaError("too-large");
  }
  // An unsafe name is dropped rather than refused: the image is still valid,
  // and the name is decoration the backend can do without.
  const name = document.fileName !== undefined && isSafeImageName(document.fileName)
    ? document.fileName
    : undefined;
  return {
    fileId: document.fileId,
    mediaType,
    weightBytes: document.fileSize ?? IMAGE_LIMIT_BYTES,
    ...(name === undefined ? {} : { name }),
  };
}

function readMediaType(mimeType: string | undefined): PromptImageMediaType | undefined {
  if (mimeType === undefined) return undefined;
  const value = mimeType.split(";")[0]?.trim().toLowerCase();
  return SUPPORTED_MEDIA_TYPES.find((supported) => supported === value);
}

/** The same rule the dsh adapter re-applies before it puts a name on the wire. */
function isSafeImageName(name: string): boolean {
  if (name.length === 0 || name.length > IMAGE_NAME_LIMIT) return false;
  if (name === "." || name === "..") return false;
  return !UNSAFE_IMAGE_NAME_PATTERN.test(name);
}

function isMeasured(size: InboundPhotoSize): size is InboundPhotoSize & { fileSize: number } {
  return size.fileSize !== undefined;
}

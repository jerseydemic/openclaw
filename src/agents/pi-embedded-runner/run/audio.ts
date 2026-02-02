import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveUserPath } from "../../../utils.js";
import { loadWebMedia } from "../../../web/media.js";
import { assertSandboxPath } from "../../sandbox-paths.js";
import { log } from "../logger.js";

/**
 * Common audio file extensions for detection.
 */
const AUDIO_EXTENSIONS = new Set([
  ".mp3",
  ".wav",
  ".aac",
  ".flac",
  ".ogg",
  ".opus",
  ".m4a",
  ".mp4", // Note: often video, but treated as audio for analysis if audio-only context
  ".mpeg",
  ".mpga",
  ".webm",
]);

/**
 * Result of detecting an audio reference in text.
 */
export interface DetectedAudioRef {
  /** The raw matched string from the prompt */
  raw: string;
  /** The type of reference (path or url) */
  type: "path" | "url";
  /** The resolved/normalized path or URL */
  resolved: string;
  /** Index of the message this ref was found in (for history audio) */
  messageIndex?: number;
}

export interface AudioContent {
  type: "audio";
  data: string;
  mimeType: string;
}

/**
 * Checks if a file extension indicates an audio file.
 */
function isAudioExtension(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return AUDIO_EXTENSIONS.has(ext);
}

/**
 * Detects audio references in a user prompt.
 *
 * Patterns detected:
 * - Absolute paths: /path/to/audio.mp3
 * - Relative paths: ./audio.mp3, ../music/song.wav
 * - Home paths: ~/Music/recording.ogg
 * - file:// URLs: file:///path/to/audio.mp3
 *
 * @param prompt The user prompt text to scan
 * @returns Array of detected audio references
 */
export function detectAudioReferences(prompt: string): DetectedAudioRef[] {
  const refs: DetectedAudioRef[] = [];
  const seen = new Set<string>();

  // Helper to add a path ref
  const addPathRef = (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed || seen.has(trimmed.toLowerCase())) return;
    if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) return;
    if (!isAudioExtension(trimmed)) return;
    seen.add(trimmed.toLowerCase());
    const resolved = trimmed.startsWith("~") ? resolveUserPath(trimmed) : trimmed;
    refs.push({ raw: trimmed, type: "path", resolved });
  };

  // Pattern for [media attached: path (type) | url]
  const mediaAttachedPattern = /\[media attached(?:\s+\d+\/\d+)?:\s*([^\]]+)\]/gi;
  let match: RegExpExecArray | null;
  while ((match = mediaAttachedPattern.exec(prompt)) !== null) {
    const content = match[1];
    if (/^\d+\s+files?$/i.test(content.trim())) continue;

    const pathMatch = content.match(
      /^\s*(.+?\.(?:mp3|wav|aac|flac|ogg|opus|m4a|mp4|mpeg|mpga|webm))\s*(?:\(|$|\|)/i,
    );
    if (pathMatch?.[1]) {
      addPathRef(pathMatch[1].trim());
    }
  }

  const fileUrlPattern =
    /file:\/\/[^\s<>"'`\]]+\.(?:mp3|wav|aac|flac|ogg|opus|m4a|mp4|mpeg|mpga|webm)/gi;
  while ((match = fileUrlPattern.exec(prompt)) !== null) {
    const raw = match[0];
    if (seen.has(raw.toLowerCase())) continue;
    seen.add(raw.toLowerCase());
    try {
      const resolved = fileURLToPath(raw);
      refs.push({ raw, type: "path", resolved });
    } catch {
      // Skip malformed file:// URLs
    }
  }

  const pathPattern =
    /(?:^|\s|["'`(])((\.\.?\/|[~/])[^\s"'`()[\]]*\.(?:mp3|wav|aac|flac|ogg|opus|m4a|mp4|mpeg|mpga|webm))/gi;
  while ((match = pathPattern.exec(prompt)) !== null) {
    if (match[1]) addPathRef(match[1]);
  }

  return refs;
}

/**
 * Loads audio from a file path or URL and returns it as AudioContent.
 */
export async function loadAudioFromRef(
  ref: DetectedAudioRef,
  workspaceDir: string,
  options?: {
    maxBytes?: number;
    sandboxRoot?: string;
  },
): Promise<AudioContent | null> {
  try {
    let targetPath = ref.resolved;

    if (ref.type === "url") {
      log.debug(`Native audio: rejecting remote URL (local-only): ${ref.resolved}`);
      return null;
    }

    if (ref.type === "path" && !path.isAbsolute(targetPath)) {
      const resolveRoot = options?.sandboxRoot ?? workspaceDir;
      targetPath = path.resolve(resolveRoot, targetPath);
    }

    if (ref.type === "path" && options?.sandboxRoot) {
      try {
        const validated = await assertSandboxPath({
          filePath: targetPath,
          cwd: options.sandboxRoot,
          root: options.sandboxRoot,
        });
        targetPath = validated.resolved;
      } catch (err) {
        log.debug(
          `Native audio: sandbox validation failed for ${ref.resolved}: ${err instanceof Error ? err.message : String(err)}`,
        );
        return null;
      }
    }

    if (ref.type === "path") {
      try {
        await fs.stat(targetPath);
      } catch {
        log.debug(`Native audio: file not found: ${targetPath}`);
        return null;
      }
    }

    const media = await loadWebMedia(targetPath, options?.maxBytes);

    if (media.kind !== "audio" && media.kind !== "video") {
      // accept video/audio
      log.debug(`Native audio: not an audio file: ${targetPath} (got ${media.kind})`);
      return null;
    }

    const mimeType = media.contentType ?? "audio/mp3";
    const data = media.buffer.toString("base64");

    return { type: "audio", data, mimeType };
  } catch (err) {
    log.debug(
      `Native audio: failed to load ${ref.resolved}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

export function modelSupportsAudio(model: { input?: string[] }): boolean {
  // Check if model explicitly claims to support audio (or just multimodal)
  // For Gemini, it usually exposes "image" and "text".
  // If we just check "image" we might be safe for Gemini 1.5 Pro.
  // But ideally we should check "audio" if exposed.
  // We'll assume if it supports "image" it might support "audio" via mutlimodal, OR check for "audio".
  return model.input?.includes("audio") || model.input?.includes("image") || false;
}

export async function detectAndLoadPromptAudio(params: {
  prompt: string;
  workspaceDir: string;
  model: { input?: string[] };
  existingAudio?: AudioContent[];
  historyMessages?: unknown[];
  maxBytes?: number;
  sandboxRoot?: string;
}): Promise<{
  audio: AudioContent[];
  loadedCount: number;
  skippedCount: number;
}> {
  if (!modelSupportsAudio(params.model)) {
    return {
      audio: [],
      loadedCount: 0,
      skippedCount: 0,
    };
  }

  const promptRefs = detectAudioReferences(params.prompt);
  // We assume history scanning for audio is similar to images but let's just do prompt for now.
  // If we wanted full history, we'd scan history messages.

  const allRefs = [...promptRefs];

  if (allRefs.length === 0) {
    return {
      audio: params.existingAudio ?? [],
      loadedCount: 0,
      skippedCount: 0,
    };
  }

  log.debug(`Native audio: detected ${allRefs.length} audio refs`);

  const promptAudio: AudioContent[] = [...(params.existingAudio ?? [])];
  let loadedCount = 0;
  let skippedCount = 0;

  for (const ref of allRefs) {
    const audio = await loadAudioFromRef(ref, params.workspaceDir, {
      maxBytes: params.maxBytes,
      sandboxRoot: params.sandboxRoot,
    });
    if (audio) {
      promptAudio.push(audio);
      loadedCount++;
      log.debug(`Native audio: loaded ${ref.type} ${ref.resolved}`);
    } else {
      skippedCount++;
    }
  }

  return {
    audio: promptAudio,
    loadedCount,
    skippedCount,
  };
}

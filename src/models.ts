/**
 * Cursor model discovery via GetUsableModels gRPC endpoint.
 * Uses the Node h2-bridge for HTTP/2 transport (Bun's node:http2 is broken;
 * shelling out to curl fails in Docker Alpine where curl is absent).
 * Falls back to a hardcoded list if the endpoint is unreachable.
 */
import { resolve as pathResolve } from "node:path";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { z } from "zod";
import {
  GetUsableModelsRequestSchema,
  GetUsableModelsResponseSchema,
} from "./proto/agent_pb";

const CURSOR_BASE_URL = "https://api2.cursor.sh";
const CURSOR_CLIENT_VERSION = "cli-2026.02.13-41ac335";
const GET_USABLE_MODELS_PATH = "/agent.v1.AgentService/GetUsableModels";
const BRIDGE_PATH = pathResolve(import.meta.dir, "h2-bridge.mjs");

const DEFAULT_CONTEXT_WINDOW = 200_000;
const DEFAULT_MAX_TOKENS = 64_000;

// --- Zod schemas for safe parsing of gRPC response ---

const CursorModelDetailsSchema = z.object({
  modelId: z.string(),
  displayName: z.string().optional().catch(undefined),
  displayNameShort: z.string().optional().catch(undefined),
  displayModelId: z.string().optional().catch(undefined),
  aliases: z
    .array(z.unknown())
    .optional()
    .catch([])
    .transform((aliases) =>
      (aliases ?? []).filter(
        (alias: unknown): alias is string => typeof alias === "string",
      ),
    ),
  thinkingDetails: z.unknown().optional(),
});

const CursorDecodedResponseSchema = z.object({
  models: z.array(z.unknown()).optional().catch([]),
});

type CursorModelDetails = z.infer<typeof CursorModelDetailsSchema>;

// --- Normalized model type for OpenCode ---

export interface CursorModel {
  id: string;
  name: string;
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
}

// --- Hardcoded fallback models ---

const FALLBACK_MODELS: CursorModel[] = [
  { id: "composer-2", name: "Composer 2", reasoning: true, contextWindow: 200_000, maxTokens: 64_000 },
  { id: "claude-4-sonnet", name: "Claude 4 Sonnet", reasoning: true, contextWindow: 200_000, maxTokens: 64_000 },
  { id: "claude-3.5-sonnet", name: "Claude 3.5 Sonnet", reasoning: false, contextWindow: 200_000, maxTokens: 8_192 },
  { id: "gpt-4o", name: "GPT-4o", reasoning: false, contextWindow: 128_000, maxTokens: 16_384 },
  { id: "cursor-small", name: "Cursor Small", reasoning: false, contextWindow: 200_000, maxTokens: 64_000 },
  { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", reasoning: true, contextWindow: 1_000_000, maxTokens: 65_536 },
];

export interface CursorModelDiscoveryOptions {
  apiKey: string;
  baseUrl?: string;
  clientVersion?: string;
  timeoutMs?: number;
}

/**
 * Fetch models from Cursor's GetUsableModels gRPC endpoint.
 * Returns null on failure (caller should use fallback list).
 */
export async function fetchCursorUsableModels(
  options: CursorModelDiscoveryOptions,
): Promise<CursorModel[] | null> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  try {
    const requestPayload = create(GetUsableModelsRequestSchema, {});
    const body = toBinary(GetUsableModelsRequestSchema, requestPayload);
    const baseUrl = (options.baseUrl ?? CURSOR_BASE_URL).replace(/\/+$/, "");

    const responseBuffer = await fetchViaHttp2(baseUrl, body, options, timeoutMs);
    if (!responseBuffer) return null;

    const decoded = decodeGetUsableModelsResponse(responseBuffer);
    const parsedDecoded = CursorDecodedResponseSchema.safeParse(decoded);
    if (!parsedDecoded.success) return null;

    return normalizeCursorModels(parsedDecoded.data.models);
  } catch {
    return null;
  }
}

/**
 * Get cursor models: try dynamic discovery, fall back to hardcoded list.
 */
export async function getCursorModels(
  apiKey: string,
): Promise<CursorModel[]> {
  const discovered = await fetchCursorUsableModels({ apiKey });
  return discovered && discovered.length > 0 ? discovered : FALLBACK_MODELS;
}

// --- Internal helpers ---

/** Length-prefix a message: [4-byte BE length][payload] */
function lpEncode(data: Uint8Array): Buffer {
  const buf = Buffer.alloc(4 + data.length);
  buf.writeUInt32BE(data.length, 0);
  buf.set(data, 4);
  return buf;
}

/**
 * Unary GetUsableModels via the Node HTTP/2 bridge (same transport as chat).
 */
async function fetchViaHttp2(
  baseUrl: string,
  body: Uint8Array,
  options: CursorModelDiscoveryOptions,
  timeoutMs: number,
): Promise<Uint8Array | null> {
  try {
    const proc = Bun.spawn(["node", BRIDGE_PATH], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    });

    // GetUsableModels expects raw application/proto (not Connect framing).
    const config = JSON.stringify({
      accessToken: options.apiKey,
      url: baseUrl,
      path: GET_USABLE_MODELS_PATH,
      clientVersion: options.clientVersion ?? CURSOR_CLIENT_VERSION,
      contentType: "application/proto",
    });

    proc.stdin.write(lpEncode(new TextEncoder().encode(config)));
    proc.stdin.write(lpEncode(body));
    proc.stdin.write(lpEncode(new Uint8Array(0)));
    proc.stdin.end();

    const chunks: Buffer[] = [];
    const reader = proc.stdout.getReader();
    let pending = Buffer.alloc(0);

    const readAll = (async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        pending = Buffer.concat([pending, Buffer.from(value)]);
        while (pending.length >= 4) {
          const len = pending.readUInt32BE(0);
          if (pending.length < 4 + len) break;
          chunks.push(Buffer.from(pending.subarray(4, 4 + len)));
          pending = pending.subarray(4 + len);
        }
      }
    })();

    const timedOut = await Promise.race([
      readAll.then(() => false),
      new Promise<boolean>((resolve) =>
        setTimeout(() => resolve(true), timeoutMs),
      ),
    ]);

    if (timedOut) {
      try {
        proc.kill();
      } catch {}
      return null;
    }

    const code = await proc.exited;
    if (code !== 0 && chunks.length === 0) return null;
    if (chunks.length === 0) return null;
    return new Uint8Array(Buffer.concat(chunks));
  } catch {
    return null;
  }
}

function decodeGetUsableModelsResponse(payload: Uint8Array) {
  if (payload.length === 0) return null;

  // Try Connect framing first (5-byte header)
  const framedBody = decodeConnectUnaryBody(payload);
  if (framedBody) {
    try {
      return fromBinary(GetUsableModelsResponseSchema, framedBody);
    } catch {
      return null;
    }
  }

  // Raw protobuf
  try {
    return fromBinary(GetUsableModelsResponseSchema, payload);
  } catch {
    return null;
  }
}

function decodeConnectUnaryBody(payload: Uint8Array): Uint8Array | null {
  if (payload.length < 5) return null;

  let offset = 0;
  while (offset + 5 <= payload.length) {
    const flags = payload[offset]!;
    const view = new DataView(
      payload.buffer,
      payload.byteOffset + offset,
      payload.byteLength - offset,
    );
    const messageLength = view.getUint32(1, false);
    const frameEnd = offset + 5 + messageLength;
    if (frameEnd > payload.length) return null;

    // Compression flag
    if ((flags & 0b0000_0001) !== 0) return null;

    // End-of-stream flag — skip trailer frames
    if (!((flags & 0b0000_0010) !== 0)) {
      return payload.subarray(offset + 5, frameEnd);
    }

    offset = frameEnd;
  }

  return null;
}

function normalizeCursorModels(
  models: readonly unknown[] | undefined,
): CursorModel[] {
  if (!models || models.length === 0) return [];

  const byId = new Map<string, CursorModel>();
  for (const model of models) {
    const normalized = normalizeSingleModel(model);
    if (normalized) byId.set(normalized.id, normalized);
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function normalizeSingleModel(model: unknown): CursorModel | null {
  const parsed = CursorModelDetailsSchema.safeParse(model);
  if (!parsed.success) return null;

  const details = parsed.data;
  const id = details.modelId.trim();
  if (!id) return null;

  return {
    id,
    name: pickDisplayName(details, id),
    reasoning: Boolean(details.thinkingDetails),
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
  };
}

function pickDisplayName(model: CursorModelDetails, fallbackId: string): string {
  const candidates = [
    model.displayName,
    model.displayNameShort,
    model.displayModelId,
    ...model.aliases,
    fallbackId,
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const trimmed = candidate.trim();
    if (trimmed) return trimmed;
  }
  return fallbackId;
}

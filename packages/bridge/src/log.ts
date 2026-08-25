/**
 * Operational logging.
 *
 * The bridge logs to a file that survives restarts, so a log line is the one
 * place where a credential or a user's prompt would quietly persist. Redaction
 * is therefore structural rather than a review habit: `LogFields` enumerates
 * every field that may be written, and there is no field for a token, message
 * text, a caption, a file id, or a protocol payload. Free-form objects are not
 * accepted, so a caller cannot add one.
 *
 * Format is JSON Lines on stdout: one record per line, machine greppable, and
 * cheap for a LaunchAgent to rotate.
 */
export type LogLevel = "info" | "debug";

/**
 * The complete set of loggable fields. Values are stable identifiers, counts,
 * durations, and bounded summaries. Add a field only after checking that it
 * cannot carry user content.
 */
export interface LogFields {
  readonly method?: string;
  readonly retryClass?: string;
  readonly attempt?: number;
  readonly delayMs?: number;
  readonly durationMs?: number;
  readonly errorCode?: number;
  /** Bounded, Telegram- or bridge-authored. Never user content. */
  readonly errorSummary?: string;
  readonly reason?: string;
  /** Menu action a callback asked for. Bridge-authored, never user content. */
  readonly action?: string;
  readonly updateId?: number;
  readonly chatId?: number;
  readonly threadId?: number;
  readonly userId?: number;
  readonly messageId?: number;
  readonly sessionId?: string;
  readonly botId?: number;
  readonly count?: number;
  /** How many images one prompt carried. A count, never the images. */
  readonly imageCount?: number;
}

export interface Logger {
  /** Always written. Reserved for failures an operator must see. */
  error(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  debug(event: string, fields?: LogFields): void;
}

export interface LoggerOptions {
  level: LogLevel;
  /** Defaults to stdout. Tests capture lines here. */
  write?: (line: string) => void;
  now?: () => Date;
}

/** Long enough for an error summary, short enough that nothing large fits. */
const MAX_FIELD_LENGTH = 200;

export function createLogger(options: LoggerOptions): Logger {
  const write = options.write ?? ((line: string) => void process.stdout.write(`${line}\n`));
  const now = options.now ?? (() => new Date());
  const emit = (level: string, event: string, fields: LogFields | undefined): void => {
    const record: Record<string, string | number> = {
      time: now().toISOString(),
      level,
      event: bound(event),
    };
    for (const [key, value] of Object.entries(fields ?? {})) {
      if (value === undefined) continue;
      record[key] = typeof value === "string" ? bound(value) : value;
    }
    write(JSON.stringify(record));
  };
  const verbose = options.level === "debug";
  return {
    error: (event, fields) => emit("error", event, fields),
    info: (event, fields) => emit("info", event, fields),
    debug: (event, fields) => {
      if (verbose) emit("debug", event, fields);
    },
  };
}

function bound(value: string): string {
  return value.length <= MAX_FIELD_LENGTH ? value : value.slice(0, MAX_FIELD_LENGTH);
}

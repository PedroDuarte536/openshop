// Reading import files safely (plan §2.7.3, C4, C13): a hand-written RFC 4180 state machine (linear time, no regular
import { CONFIG } from "../../config.ts";
// expressions on the content), hard limits on size, rows, columns, cell and record length, and no NUL bytes.

const I = CONFIG.import;
export const LIMITS = { bytes: I.maxBytes, rows: I.maxRows, columns: I.maxColumns, cell: I.maxCellLength, record: I.maxLineLength } as const;

export class FileError extends Error {
  constructor(message: string) { super(message); this.name = "FileError"; }
}

export type Encoding = "utf-8" | "windows-1252";

/** Bytes to text: UTF-8 (BOM removed) when valid, otherwise Windows-1252 (what older Excel versions save). */
export function decode(buf: Buffer): { text: string; encoding: Encoding } {
  if (buf.length > LIMITS.bytes) throw new FileError(`The file is larger than ${LIMITS.bytes / 1024 / 1024} MB.`);
  if (buf.includes(0)) throw new FileError("This doesn't look like a text file (it contains NUL bytes). Save it as CSV or JSON.");
  let bytes = buf;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) bytes = bytes.subarray(3);
  try { return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), encoding: "utf-8" }; }
  catch { return { text: new TextDecoder("windows-1252").decode(bytes), encoding: "windows-1252" }; }
}

/** The delimiter of the first line (outside quotes): the most frequent of comma, semicolon and tab. */
export function detectDelimiter(text: string): "," | ";" | "\t" {
  const counts = { ",": 0, ";": 0, "\t": 0 };
  let quoted = false;
  for (let i = 0; i < text.length && i < LIMITS.record; i++) {
    const c = text[i];
    if (c === '"') quoted = !quoted;
    else if (!quoted && (c === "\n" || c === "\r")) break;
    else if (!quoted && c in counts) counts[c as keyof typeof counts]++;
  }
  return counts[";"] > counts[","] && counts[";"] >= counts["\t"] ? ";" : counts["\t"] > counts[","] ? "\t" : ",";
}

/**
 * Parses CSV text into records of cells. Quoted cells may contain the delimiter, quotes ("") and line breaks.
 * Empty lines are skipped. Throws FileError with the line number on an unbalanced quote or a limit.
 */
export function parseCsv(text: string, delimiter: "," | ";" | "\t"): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false, afterQuote = false, line = 1, recordLen = 0, quoteLine = 0;
  const endCell = () => {
    if (cell.length > LIMITS.cell) throw new FileError(`Line ${line}: a cell is longer than ${LIMITS.cell.toLocaleString("en")} characters.`);
    row.push(cell); cell = ""; afterQuote = false;
    if (row.length > LIMITS.columns) throw new FileError(`Line ${line}: more than ${LIMITS.columns} columns.`);
  };
  const endRow = () => {
    endCell();
    if (!(row.length === 1 && row[0] === "")) {
      rows.push(row);
      if (rows.length > LIMITS.rows + 1) throw new FileError(`The file has more than ${LIMITS.rows.toLocaleString("en")} products. Split it into smaller files.`);
    }
    row = []; recordLen = 0;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (++recordLen > LIMITS.record) throw new FileError(`Line ${line}: the line is too long (more than ${LIMITS.record.toLocaleString("en")} characters).`);
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else { quoted = false; afterQuote = true; }
      } else { if (c === "\n") line++; cell += c; }
      continue;
    }
    if (c === '"' && cell === "" && !afterQuote) { quoted = true; quoteLine = line; continue; }
    if (c === delimiter) { endCell(); continue; }
    if (c === "\r") { if (text[i + 1] === "\n") i++; endRow(); line++; continue; }
    if (c === "\n") { endRow(); line++; continue; }
    // Text after a closing quote (e.g. "abc"def) is kept as written, like spreadsheets do.
    cell += c;
  }
  if (quoted) throw new FileError(`Line ${quoteLine}: a quoted cell is never closed (a " is missing).`);
  if (cell !== "" || row.length) endRow();
  return rows;
}

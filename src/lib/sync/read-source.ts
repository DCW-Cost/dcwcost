/**
 * Reading a source file in a test, with line endings normalised.
 *
 * WHY THIS EXISTS. Several guards in this repo assert on the SHAPE of a
 * source file — that the handler declares nothing called `tables`, that the
 * skip pass comes after link resolution, that the trigger awaits its
 * hand-off. They are the only way to pin facts a type checker cannot see.
 *
 * They were all reading files with `readFileSync(..., 'utf8')` and matching
 * patterns containing `\n`. That works while the working tree has LF, which
 * it did because the files had just been written. Git on Windows converts to
 * CRLF on checkout, so on a fresh clone every `\n` in those patterns stops
 * matching:
 *
 *   src.indexOf('/**\n * The tables to sync')   -> -1
 *   src.slice(start, -1)                        -> most of the file
 *
 * and the assertion then matched text from an unrelated function — a test
 * that passed for the wrong reason and would have failed for a reason
 * nobody would connect to line endings.
 *
 * Normalising here rather than in each test means a guard written later
 * cannot reintroduce it by forgetting.
 */
import { readFileSync } from 'node:fs';

/** A source file as LF-only text, whatever the checkout did to it. */
export function readSource(url: URL | string): string {
  return readFileSync(url, 'utf8').replace(/\r\n/g, '\n');
}

/**
 * Source with comments stripped, for guards that must not match their own
 * explanation. A file that documents the bug it prevents will contain the
 * forbidden pattern in prose — `void fetch(...)` is named in the comment
 * above the await that replaced it.
 */
export function readCode(url: URL | string): string {
  return readSource(url)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

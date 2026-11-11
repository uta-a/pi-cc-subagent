import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { cap } from "./runner.ts";

/** Synchronous writes keep shutdown cleanup atomic with result publication. */
export class ResultFiles {
  private files = new Set<string>();
  private closed = false;

  format(text: string, label: string): string {
    if (this.closed || Buffer.byteLength(text) <= 8 * 1024) return cap(text);
    let path: string | undefined;
    try {
      const dir = join(os.tmpdir(), "pi-cc-subagent");
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      // Do not follow a replaced directory or relax its permissions.
      const stat = fs.lstatSync(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.()) throw new Error("Unsafe result directory");
      fs.chmodSync(dir, 0o700);
      const safeLabel = label.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40) || "agent";
      path = join(dir, `${safeLabel}-${Date.now()}-${randomUUID()}.txt`);
      fs.writeFileSync(path, text, { mode: 0o600, flag: "wx" });
      this.files.add(path);
      return `${cap(text, 2 * 1024)}\nFull result (${Math.ceil(Buffer.byteLength(text) / 1024)} KiB) saved to: ${path} — read it only if needed.`;
    } catch {
      // A failed write may have left a partial file.
      if (path) { try { fs.unlinkSync(path); } catch {} }
      return cap(text);
    }
  }

  shutdown(): void {
    this.closed = true;
    for (const path of this.files) { try { fs.unlinkSync(path); } catch {} }
    this.files.clear();
  }
}

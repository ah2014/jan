/**
 * One entry returned by the backend's recursive walk of the configured
 * `allowed_attach_paths.json` roots. The frontend caches the full list and
 * filters it client-side as the user types in the `~` picker.
 */
export type RemoteFileEntry = {
  name: string
  /** Canonical absolute filesystem path — handed back to `readBytes`. */
  path: string
  isDir: boolean
  /** Byte length for files; `0` for directories. */
  size: number
}

/**
 * Raw bytes for a chosen remote file, base64-encoded so the browser can rebuild
 * a `Blob`/`File` identical to an uploaded one and feed it through the existing
 * image/audio attachment pipeline.
 */
export type RemoteFileBytes = {
  base64: string
  /** Original byte length (i.e. pre-base64), useful for size validation. */
  size: number
}

export interface RemoteFilesService {
  /** Return the list of root folders configured in allowed_attach_paths.json. */
  listAllowedPaths(): Promise<string[]>
  /**
   * Recursively walk every configured root and return a flat, deterministic
   * list of files + directories. The result is cached by `useRemoteFiles` and
   * filtered client-side as the user types.
   */
  walk(): Promise<RemoteFileEntry[]>
  /**
   * Read a single file under a configured root. Throws if the path is outside
   * the allow-list — the backend enforces this, so a buggy/hostile caller
   * cannot exfiltrate arbitrary files.
   */
  readBytes(path: string): Promise<RemoteFileBytes>
}

/**
 * Chrome headless-shell manager.
 *
 * Downloads and manages a local Chrome headless-shell binary.
 * Uses the Chrome for Testing API to find the latest stable version.
 *
 * Storage layout:
 *   ~/.bb-browser/
 *     browser/
 *       version          # e.g. "149.0.7827.22"
 *       cdp-port         # written after launch, e.g. "9222"
 *       chrome-headless-shell-<platform>/
 *         chrome-headless-shell   # the binary
 */

import { spawn, execSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, chmodSync, renameSync, readdirSync, statSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";
import path from "node:path";
import os from "node:os";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BROWSER_DIR = path.join(
  process.env.BB_BROWSER_HOME || path.join(os.homedir(), ".bb-browser"),
  "browser",
);

const HEADLESS_SHELL_BASE_URL =
  "https://pinix-blobs-1251447449.cos.ap-beijing.myqcloud.com/releases/headless-shell";

const HEADLESS_SHELL_VERSION = "149.0.7827.22";

const LOG_PREFIX = "[Chrome]";

// ---------------------------------------------------------------------------
// Platform detection
// ---------------------------------------------------------------------------

type Platform = "linux64" | "linux-arm64" | "mac-arm64" | "mac-x64";

function detectPlatform(): Platform | null {
  const arch = os.arch(); // arm64, x64
  const plat = os.platform(); // darwin, linux

  if (plat === "darwin") {
    return arch === "arm64" ? "mac-arm64" : "mac-x64";
  }
  if (plat === "linux") {
    return arch === "arm64" ? "linux-arm64" : "linux64";
  }
  return null;
}

function headlessShellBinaryName(platform: Platform): string {
  // The binary inside the zip is always named "chrome-headless-shell" on all platforms
  return "chrome-headless-shell";
}

function headlessShellDir(platform: Platform): string {
  return path.join(BROWSER_DIR, `chrome-headless-shell-${platform}`);
}

function headlessShellPath(platform: Platform): string {
  return path.join(headlessShellDir(platform), headlessShellBinaryName(platform));
}

// ---------------------------------------------------------------------------
// Version management
// ---------------------------------------------------------------------------

function installedVersion(): string | null {
  try {
    return readFileSync(path.join(BROWSER_DIR, "version"), "utf8").trim();
  } catch {
    return null;
  }
}

function saveVersion(version: string): void {
  mkdirSync(BROWSER_DIR, { recursive: true });
  writeFileSync(path.join(BROWSER_DIR, "version"), version);
}

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

interface DownloadInfo {
  version: string;
  url: string;
  platform: Platform;
}

function getDownloadUrl(platform: Platform): DownloadInfo {
  const url = `${HEADLESS_SHELL_BASE_URL}/chrome-headless-shell-${platform}.zip`;
  return { version: HEADLESS_SHELL_VERSION, url, platform };
}

async function downloadAndExtract(info: DownloadInfo): Promise<string> {
  const zipPath = path.join(BROWSER_DIR, `chrome-headless-shell-${info.platform}.zip`);
  const targetDir = headlessShellDir(info.platform);

  // Clean up previous
  if (existsSync(targetDir)) {
    rmSync(targetDir, { recursive: true, force: true });
  }

  mkdirSync(BROWSER_DIR, { recursive: true });

  console.error(`${LOG_PREFIX} Downloading headless-shell ${info.version} (${info.platform})...`);

  const resp = await fetch(info.url);
  if (!resp.ok || !resp.body) {
    throw new Error(`Download failed: ${resp.status}`);
  }

  // Save zip to disk
  const fileStream = createWriteStream(zipPath);
  // @ts-expect-error ReadableStream vs NodeJS.ReadableStream
  await pipeline(resp.body, fileStream);

  // Extract to a temp dir, then move to target
  const extractDir = targetDir + ".extract";
  if (existsSync(extractDir)) {
    rmSync(extractDir, { recursive: true, force: true });
  }
  mkdirSync(extractDir, { recursive: true });

  console.error(`${LOG_PREFIX} Extracting...`);
  try {
    execSync(`unzip -q -o "${zipPath}" -d "${extractDir}"`, { stdio: "pipe" });
  } catch (error) {
    throw new Error(`Failed to extract zip: ${error instanceof Error ? error.message : String(error)}`);
  }
  rmSync(zipPath, { force: true });

  // Find the headless-shell binary inside extracted contents.
  // Different sources may use different directory structures.
  const binary = findBinaryRecursive(extractDir, "chrome-headless-shell") ??
                 findBinaryRecursive(extractDir, "headless_shell");

  if (!binary) {
    rmSync(extractDir, { recursive: true, force: true });
    throw new Error("chrome-headless-shell binary not found in zip");
  }

  // Move the directory containing the binary to targetDir
  const binaryParent = path.dirname(binary);
  if (existsSync(targetDir)) rmSync(targetDir, { recursive: true, force: true });
  renameSync(binaryParent, targetDir);

  // Clean up extract dir if it's still around
  if (existsSync(extractDir)) rmSync(extractDir, { recursive: true, force: true });

  const finalPath = headlessShellPath(info.platform);
  if (!existsSync(finalPath)) {
    throw new Error(`Binary not at expected path: ${finalPath}`);
  }
  chmodSync(finalPath, 0o755);

  saveVersion(info.version);
  console.error(`${LOG_PREFIX} Installed headless-shell ${info.version}`);

  return finalPath;
}

/** Recursively find a binary by name in a directory tree. */
function findBinaryRecursive(dir: string, name: string): string | null {
  try {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (entry === name) return full;
      try {
        if (statSync(full).isDirectory()) {
          const found = findBinaryRecursive(full, name);
          if (found) return found;
        }
      } catch {}
    }
  } catch {}
  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ChromeManager {
  /** Ensure headless-shell is downloaded. Returns the binary path. */
  ensureBinary(): Promise<string>;

  /** Launch headless-shell on the given port. Returns the child process. */
  launch(port: number, options?: LaunchOptions): ChildProcess;

  /** Wait for CDP to be ready on the given port. */
  waitForCdp(host: string, port: number, timeoutMs?: number): Promise<void>;
}

export interface LaunchOptions {
  windowSize?: string; // e.g. "1920,1080"
  userDataDir?: string;
}

export function createChromeManager(): ChromeManager {
  const platform = detectPlatform();

  return {
    async ensureBinary(): Promise<string> {
      if (!platform) {
        throw new Error(
          `Chrome headless-shell is not available for ${os.platform()}/${os.arch()}. ` +
          `Install Chromium manually and use --no-chrome.`,
        );
      }

      const binary = headlessShellPath(platform);

      if (existsSync(binary)) {
        const version = installedVersion();
        console.error(`${LOG_PREFIX} Using headless-shell ${version ?? "unknown"} at ${binary}`);
        return binary;
      }

      // Download from COS
      const info = getDownloadUrl(platform);
      return downloadAndExtract(info);
    },

    launch(port: number, options?: LaunchOptions): ChildProcess {
      if (!platform) {
        throw new Error(`Cannot launch: no headless-shell for ${os.platform()}/${os.arch()}`);
      }
      const binary = headlessShellPath(platform);
      if (!existsSync(binary)) {
        throw new Error(`Headless-shell binary not found at ${binary}. Run ensureBinary() first.`);
      }

      const userDataDir = options?.userDataDir ?? path.join(
        process.env.BB_BROWSER_HOME || path.join(os.homedir(), ".bb-browser"),
        "chrome-data",
      );
      const windowSize = options?.windowSize ?? "1920,1080";

      mkdirSync(userDataDir, { recursive: true });

      const args = [
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${userDataDir}`,
        `--window-size=${windowSize}`,
        "--no-first-run",
        "--disable-default-apps",
        "--headless=new",
        "--disable-gpu",
        "--no-sandbox",
      ];

      console.error(`${LOG_PREFIX} Launching headless-shell on port ${port}`);

      const child = spawn(binary, args, {
        stdio: ["ignore", "pipe", "pipe"],
        detached: false,
      });

      child.stderr?.on("data", (data: Buffer) => {
        const line = data.toString().trim();
        if (line) console.error(`${LOG_PREFIX} ${line}`);
      });

      child.on("exit", (code, signal) => {
        console.error(`${LOG_PREFIX} Process exited (code=${code}, signal=${signal})`);
      });

      // Write CDP port file for discovery
      const portFile = path.join(BROWSER_DIR, "cdp-port");
      mkdirSync(BROWSER_DIR, { recursive: true });
      writeFileSync(portFile, String(port));

      return child;
    },

    async waitForCdp(host: string, port: number, timeoutMs = 15000): Promise<void> {
      const deadline = Date.now() + timeoutMs;

      while (Date.now() < deadline) {
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 2000);
          try {
            const resp = await fetch(`http://${host}:${port}/json/version`, {
              signal: controller.signal,
            });
            if (resp.ok) {
              const info = (await resp.json()) as { Browser?: string };
              console.error(`${LOG_PREFIX} CDP ready: ${info.Browser ?? "unknown"}`);
              return;
            }
          } finally {
            clearTimeout(timer);
          }
        } catch {
          // Not ready yet
        }
        await new Promise((r) => setTimeout(r, 500));
      }

      throw new Error(`CDP not ready at ${host}:${port} after ${timeoutMs}ms`);
    },
  };
}

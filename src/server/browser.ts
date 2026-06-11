import { spawn } from "node:child_process";

export type OpenBrowser = (url: string) => void | Promise<void>;

export function browserOpenCommand(url: string, platform: NodeJS.Platform = process.platform): {
  command: string;
  args: string[];
} {
  if (platform === "darwin") return { command: "open", args: [url] };
  if (platform === "win32") return { command: "cmd", args: ["/c", "start", "", url] };
  return { command: "xdg-open", args: [url] };
}

export function openBrowserTab(url: string): void {
  if (process.env.REDLINE_NO_BROWSER === "1") return;
  const { command, args } = browserOpenCommand(url);
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
  });
  child.on("error", (error) => {
    console.warn(`Could not open browser for ${url}: ${error.message}`);
  });
  child.unref();
}

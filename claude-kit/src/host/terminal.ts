import { spawn } from "node:child_process";

/** Claude Code in a terminal in `folder`: PowerShell on Windows, Terminal on a Mac, x-terminal-emulator elsewhere. */
export function openTerminal(folder: string, command?: string) {
  if (process.platform === "darwin") {
    const line = `cd '${folder.replace(/'/g, "'\\''")}'${command ? ` && ${command}` : ""}`;
    const apple = line.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    spawn("osascript", ["-e", `tell application "Terminal" to do script "${apple}"`, "-e", 'tell application "Terminal" to activate'], { detached: true, stdio: "ignore" }).unref();
    return;
  }
  if (process.platform === "win32") {
    const inner = `Set-Location -LiteralPath '${folder.replace(/'/g, "''")}'${command ? `; ${command}` : ""}`;
    spawn("cmd.exe", ["/c", "start", "", "powershell", "-NoExit", "-Command", inner], { detached: true, windowsHide: false, stdio: "ignore" }).unref();
    return;
  }
  spawn("x-terminal-emulator", ["-e", "sh", "-c", `cd '${folder.replace(/'/g, "'\\''")}' && ${command ?? "claude"}; exec sh`], { detached: true, stdio: "ignore" }).unref();
}

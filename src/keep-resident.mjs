import os from 'node:os';
import {execFile} from 'node:child_process';

// Keeps the server answering while the rest of the machine runs out of memory.
// When a game took ~20 GB, Windows trimmed the server's whole working
// set to the page file, and every request waited on page-ins for as long as the game ran. A hard
// minimum working set tells the memory manager never to trim this process below `minMB`, so the heap,
// code and stacks the server touches stay in RAM; above-normal CPU priority lets it run between the
// game's threads. Both last for the life of the process and reach no other process: agents it starts
// keep normal priority and ordinary working sets. Windows only; elsewhere this does nothing.
//
// Node has no binding for SetProcessWorkingSetSizeEx, so one PowerShell call compiles a few P/Invoke
// lines and applies it to our pid. Raising a working set above its current size needs
// SeIncreaseWorkingSetPrivilege, which every Windows user holds but has disabled; the call enables it
// in its own token first.
const SCRIPT = String.raw`$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class StudioloResident {
  [StructLayout(LayoutKind.Sequential)] struct LUID { public uint Low; public int High; }
  [StructLayout(LayoutKind.Sequential)] struct TP { public uint Count; public LUID Luid; public uint Attr; }
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr h, uint access, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool LookupPrivilegeValue(string sys, string name, out LUID luid);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool AdjustTokenPrivileges(IntPtr token, bool disableAll, ref TP state, uint len, IntPtr prev, IntPtr ret);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetProcessWorkingSetSizeEx(IntPtr h, UIntPtr min, UIntPtr max, uint flags);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  public static string Apply(int pid, long min, long max) {
    IntPtr token; LUID luid;
    if (OpenProcessToken(GetCurrentProcess(), 0x28, out token)) {
      if (LookupPrivilegeValue(null, "SeIncreaseWorkingSetPrivilege", out luid)) { TP tp = new TP(); tp.Count = 1; tp.Luid = luid; tp.Attr = 2; AdjustTokenPrivileges(token, false, ref tp, 0, IntPtr.Zero, IntPtr.Zero); }
      CloseHandle(token);
    }
    IntPtr h = OpenProcess(0x0500, false, pid);
    if (h == IntPtr.Zero) return "open failed " + Marshal.GetLastWin32Error();
    bool ok = SetProcessWorkingSetSizeEx(h, (UIntPtr)(ulong)min, (UIntPtr)(ulong)max, 1 | 8);
    int error = ok ? 0 : Marshal.GetLastWin32Error();
    CloseHandle(h);
    return ok ? "ok" : "failed " + error;
  }
}
'@
[StudioloResident]::Apply([int]$env:STUDIOLO_PID, [long]$env:STUDIOLO_MIN, [long]$env:STUDIOLO_MAX)`;

const MB = 1024 * 1024;
// 0 or "off" turns it off; a number is the floor in MB. 1024 MB covers the server's usual 0.7–1.5 GB
// resident set mostly, and is 3% of a 32 GB machine.
export function residentFloor(env = process.env) {
  const value = String(env.STUDIO_RESIDENT_MB ?? '').trim().toLowerCase();
  if (value === 'off' || value === '0') return 0;
  const n = Number(value);
  return Number.isFinite(n) && n >= 64 ? Math.round(n) : 1024;
}

export function keepResident({pid = process.pid, minMB = residentFloor(), platform = process.platform, run = execFile, priority = true} = {}) {
  if (platform !== 'win32' || !minMB) return Promise.resolve({applied: false, reason: platform !== 'win32' ? 'not windows' : 'off'});
  // The maximum is soft (flag 8): it only keeps Windows from trimming toward it while memory is plentiful.
  // Above-normal, not high: agents and the user's own programs still get the CPU they ask for.
  let cpu = null;
  if (priority) { try { os.setPriority(pid, os.constants.priority.PRIORITY_ABOVE_NORMAL); cpu = 'above normal'; } catch (e) { cpu = 'unchanged: ' + e.message; } }
  const env = {...process.env, STUDIOLO_PID: String(pid), STUDIOLO_MIN: String(minMB * MB), STUDIOLO_MAX: String((minMB + 4096) * MB)};
  return new Promise(resolve => {
    run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', SCRIPT], {env, windowsHide: true, timeout: 60000}, (error, stdout, stderr) => {
      const answer = String(stdout || '').trim();
      resolve({applied: !error && answer === 'ok', minMB, cpu, detail: error ? (String(stderr || '').trim() || error.message) : answer});
    });
  });
}

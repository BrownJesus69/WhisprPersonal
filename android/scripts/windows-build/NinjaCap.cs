// Caps ninja parallelism for the E:-only Android build copy of the SDK.
// With 32 logical CPUs, ninja's default (~34 clang jobs per CMake task) exhausted RAM + pagefile.
using System;
using System.Diagnostics;
using System.IO;

class NinjaCap {
    static int Main() {
        string jobs = Environment.GetEnvironmentVariable("WHISPR_NINJA_JOBS");
        int n;
        if (!int.TryParse(jobs, out n) || n < 1) n = 6;
        string cmd = Environment.CommandLine;
        string rest;
        if (cmd.StartsWith("\"")) {
            int close = cmd.IndexOf('"', 1);
            rest = close < 0 ? "" : cmd.Substring(close + 1);
        } else {
            int space = cmd.IndexOf(' ');
            rest = space < 0 ? "" : cmd.Substring(space);
        }
        string self = Process.GetCurrentProcess().MainModule.FileName;
        string real = Path.Combine(Path.GetDirectoryName(self), "ninja-real.exe");
        var psi = new ProcessStartInfo(real, "-j " + n + " " + rest.TrimStart());
        psi.UseShellExecute = false;
        using (var p = Process.Start(psi)) {
            p.WaitForExit();
            return p.ExitCode;
        }
    }
}

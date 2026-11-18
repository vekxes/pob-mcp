using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Windows.Forms;

[assembly: AssemblyTitle("PoE Trade")]
[assembly: AssemblyProduct("PoE Trade Companion")]

internal static class TradeLauncher
{
    [STAThread]
    private static int Main()
    {
        try
        {
            string root = Path.GetFullPath(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "..", ".."));
            string script = Path.Combine(root, "apps", "trade-desktop", "Start-Trade.ps1");
            if (!File.Exists(script))
            {
                throw new FileNotFoundException("The PoE Trade checkout moved. Reinstall the desktop shortcut.");
            }

            string powershell = Path.Combine(Environment.SystemDirectory, "WindowsPowerShell", "v1.0", "powershell.exe");
            var launch = new ProcessStartInfo(powershell)
            {
                Arguments = "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File \"" + script + "\" -ShowErrors",
                WorkingDirectory = root,
                UseShellExecute = false,
                CreateNoWindow = true
            };

            using (Process process = Process.Start(launch))
            {
                process.WaitForExit();
                return process.ExitCode;
            }
        }
        catch (Exception error)
        {
            MessageBox.Show(error.Message, "PoE Trade", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }
}

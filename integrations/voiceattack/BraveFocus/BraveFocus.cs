// Windowless on-demand launcher for the user's ordinary Brave profile.
// Build with the included build.ps1. No background service is required.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Microsoft.Win32;

internal static class BraveFocus
{
    private delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr parameter);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr parameter);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr hwnd, uint command);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr hwnd, StringBuilder buffer, int length);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr hwnd, StringBuilder buffer, int length);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr hwnd, int command);
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern bool BringWindowToTop(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern bool AttachThreadInput(uint from, uint to, bool attach);
    [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
    [DllImport("kernel32.dll")] private static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")] private static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
    [DllImport("user32.dll")] private static extern IntPtr GetShellWindow();
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool GetTokenInformation(IntPtr token, int infoClass, out int info, int size, out int returned);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool DuplicateTokenEx(IntPtr token, uint access, IntPtr attributes, int level, int type, out IntPtr copy);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool CreateProcessWithTokenW(IntPtr token, uint flags, string application, StringBuilder command, uint creationFlags, IntPtr environment, string directory, ref StartupInfo startup, out ProcessInformation process);
    [DllImport("dwmapi.dll")] private static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out int value, int size);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct StartupInfo {
        public int cb; public string reserved, desktop, title; public uint x, y, xSize, ySize, xCountChars, yCountChars, fillAttribute, flags;
        public short showWindow, reserved2; public IntPtr reservedPtr, stdInput, stdOutput, stdError;
    }
    [StructLayout(LayoutKind.Sequential)] private struct ProcessInformation { public IntPtr process, thread; public uint processId, threadId; }

    private const uint GwOwner = 4;
    private const int SwRestore = 9;
    private const int DwmwaCloaked = 14;
    private const string MutexName = @"Local\MacropadBraveFocus-v1";
    private static string lastExecutionError;

    internal static string LastExecutionError
    {
        get { return Interlocked.CompareExchange(ref lastExecutionError, null, null); }
    }

    internal sealed class BrowserWindow
    {
        public IntPtr Handle;
        public string Title;
        public bool Minimized;
        public bool Cloaked;
    }

    private static string WindowText(IntPtr hwnd)
    {
        var buffer = new StringBuilder(2048);
        GetWindowText(hwnd, buffer, buffer.Capacity);
        return buffer.ToString();
    }

    private static string WindowClass(IntPtr hwnd)
    {
        var buffer = new StringBuilder(256);
        GetClassName(hwnd, buffer, buffer.Capacity);
        return buffer.ToString();
    }

    private static bool IsBraveProcess(uint pid)
    {
        try { using (var process = Process.GetProcessById((int)pid)) return process.ProcessName.Equals("brave", StringComparison.OrdinalIgnoreCase); }
        catch (ArgumentException) { return false; }
        catch (InvalidOperationException) { return false; }
        catch (System.ComponentModel.Win32Exception) { return false; }
    }

    private static bool LooksLikeBrowserTitle(string title)
    {
        if (String.IsNullOrWhiteSpace(title)) return false;
        if (title.StartsWith("DevTools -", StringComparison.OrdinalIgnoreCase) ||
            title.StartsWith("Developer Tools -", StringComparison.OrdinalIgnoreCase)) return false;
        return title.Equals("Brave", StringComparison.OrdinalIgnoreCase) ||
               title.EndsWith(" - Brave", StringComparison.OrdinalIgnoreCase);
    }

    // EnumWindows walks top-level windows in Windows' current Z order. We do
    // not infer recency from process creation time, titles, or screen position.
    internal static List<BrowserWindow> BrowserWindows()
    {
        var result = new List<BrowserWindow>();
        EnumWindows(delegate(IntPtr hwnd, IntPtr ignored) {
            if (!IsWindowVisible(hwnd) || GetWindow(hwnd, GwOwner) != IntPtr.Zero || WindowClass(hwnd) != "Chrome_WidgetWin_1") return true;
            uint pid;
            GetWindowThreadProcessId(hwnd, out pid);
            if (!IsBraveProcess(pid)) return true;
            string title = WindowText(hwnd);
            if (!LooksLikeBrowserTitle(title)) return true;
            int cloaked;
            bool hiddenOnOtherDesktop = DwmGetWindowAttribute(hwnd, DwmwaCloaked, out cloaked, sizeof(int)) == 0 && cloaked != 0;
            result.Add(new BrowserWindow { Handle = hwnd, Title = title, Minimized = IsIconic(hwnd), Cloaked = hiddenOnOtherDesktop });
            return true;
        }, IntPtr.Zero);
        return result;
    }

    private static string FindBrave()
    {
        foreach (var root in new[] { Registry.CurrentUser, Registry.LocalMachine })
        {
            using (var key = root.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\App Paths\brave.exe"))
            {
                string path = key == null ? null : key.GetValue(null) as string;
                if (!String.IsNullOrEmpty(path) && System.IO.File.Exists(path)) return path;
            }
        }
        string[] candidates = {
            System.IO.Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), @"BraveSoftware\Brave-Browser\Application\brave.exe"),
            System.IO.Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), @"BraveSoftware\Brave-Browser\Application\brave.exe"),
            System.IO.Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), @"BraveSoftware\Brave-Browser\Application\brave.exe")
        };
        foreach (string candidate in candidates) if (System.IO.File.Exists(candidate)) return candidate;
        return null;
    }

    private static bool Focus(IntPtr hwnd)
    {
        if (!IsWindow(hwnd)) return false;
        if (GetForegroundWindow() == hwnd) return true;
        if (IsIconic(hwnd)) ShowWindow(hwnd, SwRestore);
        if (SetForegroundWindow(hwnd) || GetForegroundWindow() == hwnd) return true;
        // Windows may reserve foreground activation for another thread. Attach
        // once to its input queue, request activation, and detach immediately.
        // No synthetic keystrokes, focus-stealing loops, or persistent hooks.
        IntPtr foreground = GetForegroundWindow();
        uint ignored;
        uint foregroundThread = foreground == IntPtr.Zero ? 0 : GetWindowThreadProcessId(foreground, out ignored);
        uint thisThread = GetCurrentThreadId();
        bool attached = foregroundThread != 0 && foregroundThread != thisThread && AttachThreadInput(thisThread, foregroundThread, true);
        try { if (attached) { BringWindowToTop(hwnd); SetForegroundWindow(hwnd); } }
        finally { if (attached) AttachThreadInput(thisThread, foregroundThread, false); }
        return GetForegroundWindow() == hwnd;
    }

    private static bool IsElevated()
    {
        IntPtr token;
        if (!OpenProcessToken(GetCurrentProcess(), 0x0008, out token)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        try {
            int elevated, returned;
            if (!GetTokenInformation(token, 20, out elevated, sizeof(int), out returned))
                throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            return elevated != 0;
        } finally { CloseHandle(token); }
    }

    private static void LaunchBraveNormally(string executable)
    {
        if (!IsElevated()) {
            Process.Start(new ProcessStartInfo(executable) { UseShellExecute = true });
            return;
        }
        // VoiceAttack may be elevated. Launching its child normally would also
        // elevate Brave, so duplicate the ordinary desktop shell's user token.
        // If this is unavailable, fail rather than start the browser elevated.
        uint shellPid;
        GetWindowThreadProcessId(GetShellWindow(), out shellPid);
        IntPtr shell = OpenProcess(0x1000, false, shellPid);
        if (shell == IntPtr.Zero) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        IntPtr source = IntPtr.Zero, primary = IntPtr.Zero;
        try {
            if (!OpenProcessToken(shell, 0x0002 | 0x0008 | 0x0001, out source))
                throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            if (!DuplicateTokenEx(source, 0x0001 | 0x0002 | 0x0008, IntPtr.Zero, 2, 1, out primary))
                throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            var startup = new StartupInfo { cb = Marshal.SizeOf(typeof(StartupInfo)), desktop = @"winsta0\default" };
            ProcessInformation created;
            if (!CreateProcessWithTokenW(primary, 0, executable, new StringBuilder("\"" + executable + "\""), 0,
                    IntPtr.Zero, System.IO.Path.GetDirectoryName(executable), ref startup, out created))
                throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            CloseHandle(created.thread);
            CloseHandle(created.process);
        } finally {
            if (primary != IntPtr.Zero) CloseHandle(primary);
            if (source != IntPtr.Zero) CloseHandle(source);
            CloseHandle(shell);
        }
    }

    private static int Run(bool diagnostic, IntPtr preferred)
    {
        var windows = BrowserWindows();
        if (diagnostic)
        {
            Console.WriteLine("Brave executable: " + (FindBrave() ?? "not found"));
            Console.WriteLine("Foreground handle: " + GetForegroundWindow());
            foreach (var window in windows)
                Console.WriteLine("Window " + window.Handle + " minimized=" + window.Minimized + " cloaked=" + window.Cloaked + " title=" + window.Title);
            return 0;
        }
        // Prefer the current desktop. If a normal browser window exists on a
        // different virtual desktop, attempt it rather than opening a duplicate.
        BrowserWindow target = windows.Find(w => w.Handle == preferred && !w.Cloaked)
            ?? windows.Find(w => !w.Cloaked)
            ?? (windows.Count > 0 ? windows[0] : null);
        if (target != null) return Focus(target.Handle) ? 0 : 2;
        string executable = FindBrave();
        if (executable == null) return 3;
        LaunchBraveNormally(executable);
        // Keep the mutex while the new browser window appears, so rapid repeat
        // presses during startup cannot queue a second launch.
        var deadline = Stopwatch.StartNew();
        while (deadline.ElapsedMilliseconds < 5000)
        {
            Thread.Sleep(100);
            if (BrowserWindows().Count > 0) break;
        }
        return 0;
    }

    internal static int Execute(IntPtr preferred)
    {
        Interlocked.Exchange(ref lastExecutionError, null);
        try
        {
            using (var mutex = new Mutex(false, MutexName))
            {
                bool acquired;
                try { acquired = mutex.WaitOne(0); }
                catch (AbandonedMutexException) { acquired = true; }
                if (!acquired) return 0;
                try { return Run(false, preferred); }
                finally { mutex.ReleaseMutex(); }
            }
        }
        catch (Exception ex)
        {
            // Keep the underlying Windows/.NET error so VoiceAttack can show
            // why the action failed instead of only reporting error 1.
            Interlocked.Exchange(ref lastExecutionError, ex.GetType().Name + ": " + ex.Message);
            return 1;
        }
    }

    [STAThread]
    private static int Main(string[] args)
    {
        if (args.Length == 1 && args[0] == "--diagnose")
        {
            try { return Run(true, IntPtr.Zero); }
            catch { return 1; }
        }
        return Execute(IntPtr.Zero);
    }
}

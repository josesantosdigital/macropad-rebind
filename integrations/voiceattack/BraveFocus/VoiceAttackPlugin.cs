// VoiceAttack plugin: tracks Brave activation inside the existing VA process.
// No additional resident process and no keyboard or content interception.
using System;
using System.Runtime.InteropServices;
using System.Threading;

namespace MacropadBraveFocus
{
    public static class VoiceAttackPlugin
    {
        private const uint EventForeground = 0x0003;
        private const uint EventMinimizeStart = 0x0016;
        private const uint EventMinimizeEnd = 0x0017;
        private const uint WmQuit = 0x0012;
        private const uint WmTimer = 0x0113;
        private delegate void WinEventProc(IntPtr hook, uint eventType, IntPtr hwnd, int objectId, int childId, uint eventThread, uint eventTime);
        [DllImport("user32.dll")] private static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr module, WinEventProc callback, uint process, uint thread, uint flags);
        [DllImport("user32.dll")] private static extern bool UnhookWinEvent(IntPtr hook);
        [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] private static extern bool GetLastInputInfo(ref LastInput info);
        [DllImport("user32.dll")] private static extern int GetMessage(out Message message, IntPtr hwnd, uint min, uint max);
        [DllImport("user32.dll")] private static extern bool PeekMessage(out Message message, IntPtr hwnd, uint min, uint max, uint remove);
        [DllImport("user32.dll")] private static extern bool PostThreadMessage(uint thread, uint message, UIntPtr wParam, IntPtr lParam);
        [DllImport("user32.dll")] private static extern UIntPtr SetTimer(IntPtr hwnd, UIntPtr id, uint interval, IntPtr callback);
        [DllImport("user32.dll")] private static extern bool KillTimer(IntPtr hwnd, UIntPtr id);
        [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
        [StructLayout(LayoutKind.Sequential)] private struct Point { public int X, Y; }
        [StructLayout(LayoutKind.Sequential)] private struct Message { public IntPtr hwnd; public uint message; public UIntPtr wParam; public IntPtr lParam; public uint time; public Point pt; public uint privateValue; }
        [StructLayout(LayoutKind.Sequential)] private struct LastInput { public uint size; public uint time; }

        private static readonly object Gate = new object();
        private static readonly ManualResetEvent Ready = new ManualResetEvent(false);
        private static readonly WinEventProc Callback = OnWindowEvent;
        private static Thread watcher;
        private static uint watcherThread;
        private static IntPtr lastBrave = IntPtr.Zero;
        private static bool hookReady;
        private static bool suppressAutomaticActivation;
        private static uint minimizeInputTime;
        private static uint lastObservedInput;

        public static string VA_DisplayName() { return "Macropad: Focus latest Brave window"; }
        public static string VA_DisplayInfo() { return "Focuses the last active Brave browser window, restoring it if minimized. Tracks only window activation while VoiceAttack is running."; }
        public static Guid VA_Id() { return new Guid("4f631e41-231e-45c4-9db3-525092b8afe8"); }
        public static void VA_StopCommand() { }

        private static uint LastInputTime()
        {
            var info = new LastInput { size = (uint)Marshal.SizeOf(typeof(LastInput)) };
            return GetLastInputInfo(ref info) ? info.time : 0;
        }

        private static bool IsBrowserWindow(IntPtr hwnd)
        {
            if (hwnd == IntPtr.Zero) return false;
            return BraveFocus.BrowserWindows().Exists(w => w.Handle == hwnd && !w.Cloaked);
        }

        private static void OnWindowEvent(IntPtr hook, uint eventType, IntPtr hwnd, int objectId, int childId, uint eventThread, uint eventTime)
        {
            try
            {
                if (hwnd == IntPtr.Zero || objectId != 0 || childId != 0) return;
                if (eventType == EventMinimizeStart)
                {
                    lock (Gate) {
                        if (lastBrave == hwnd) {
                            // Minimizing can automatically activate an older
                            // Brave window. That is not a new user selection.
                            minimizeInputTime = LastInputTime();
                            lastObservedInput = minimizeInputTime;
                            suppressAutomaticActivation = true;
                        }
                    }
                    return;
                }
                if (eventType == EventMinimizeEnd && GetForegroundWindow() != hwnd) return;
                if (eventType != EventForeground && eventType != EventMinimizeEnd) return;
                lock (Gate) {
                    if (suppressAutomaticActivation && hwnd != lastBrave) {
                        bool sameInput = LastInputTime() == minimizeInputTime;
                        suppressAutomaticActivation = false;
                        if (sameInput) return;
                    }
                }
                if (IsBrowserWindow(hwnd)) lock (Gate) { lastBrave = hwnd; }
            }
            catch { /* A window can close while its event is being processed. */ }
        }

        private static void WatchWindows()
        {
            IntPtr foregroundHook = IntPtr.Zero, minimizeHook = IntPtr.Zero;
            UIntPtr timer = UIntPtr.Zero;
            try
            {
                Message message;
                PeekMessage(out message, IntPtr.Zero, 0, 0, 0); // create a message queue
                watcherThread = GetCurrentThreadId();
                var windows = BraveFocus.BrowserWindows();
                IntPtr foreground = GetForegroundWindow();
                var initial = windows.Find(w => w.Handle == foreground && !w.Cloaked)
                    ?? windows.Find(w => !w.Cloaked);
                lock (Gate) { lastBrave = initial == null ? IntPtr.Zero : initial.Handle; }
                lastObservedInput = LastInputTime();
                foregroundHook = SetWinEventHook(EventForeground, EventForeground, IntPtr.Zero, Callback, 0, 0, 0);
                minimizeHook = SetWinEventHook(EventMinimizeStart, EventMinimizeEnd, IntPtr.Zero, Callback, 0, 0, 0);
                timer = SetTimer(IntPtr.Zero, UIntPtr.Zero, 250, IntPtr.Zero);
                hookReady = foregroundHook != IntPtr.Zero && minimizeHook != IntPtr.Zero && timer != UIntPtr.Zero;
                Ready.Set();
                if (!hookReady) return;
                while (GetMessage(out message, IntPtr.Zero, 0, 0) > 0) {
                    if (message.message != WmTimer) continue;
                    // Only check the input timestamp, never keys or content.
                    // This detects the user interacting with a Brave window
                    // that Windows activated automatically after a minimize.
                    uint input = LastInputTime();
                    if (input == lastObservedInput) continue;
                    lastObservedInput = input;
                    IntPtr active = GetForegroundWindow();
                    if (IsBrowserWindow(active)) lock (Gate) {
                        lastBrave = active;
                        suppressAutomaticActivation = false;
                    }
                }
            }
            finally {
                if (timer != UIntPtr.Zero) KillTimer(IntPtr.Zero, timer);
                if (foregroundHook != IntPtr.Zero) UnhookWinEvent(foregroundHook);
                if (minimizeHook != IntPtr.Zero) UnhookWinEvent(minimizeHook);
                hookReady = false;
                Ready.Set();
            }
        }

        public static void VA_Init1(object vaProxy)
        {
            lock (Gate) {
                if (watcher != null) return;
                Ready.Reset();
                watcher = new Thread(WatchWindows) { IsBackground = true, Name = "Brave window activation tracker" };
                watcher.Start();
            }
            Ready.WaitOne(2000);
        }

        public static void VA_Invoke1(object vaProxy)
        {
            if (!hookReady) throw new InvalidOperationException("Brave window tracking did not start. Restart VoiceAttack and check plugin support.");
            IntPtr preferred;
            lock (Gate) { preferred = lastBrave; }
            int result = BraveFocus.Execute(preferred);
            if (result == 1) {
                string detail = BraveFocus.LastExecutionError;
                throw new InvalidOperationException("Could not activate or launch Brave (error 1)" +
                    (String.IsNullOrWhiteSpace(detail) ? "." : ": " + detail));
            }
            if (result == 2) throw new InvalidOperationException("Could not activate the Brave window (error 2): Windows refused foreground activation.");
            if (result == 3) throw new InvalidOperationException("Could not launch Brave (error 3): the Brave executable was not found.");
        }

        public static void VA_Exit1(object vaProxy)
        {
            Thread current;
            lock (Gate) { current = watcher; watcher = null; }
            if (watcherThread != 0) PostThreadMessage(watcherThread, WmQuit, UIntPtr.Zero, IntPtr.Zero);
            if (current != null && current != Thread.CurrentThread) current.Join(1000);
            watcherThread = 0;
        }

        // Used by the local test harness; not a VoiceAttack action.
        public static long DiagnosticLastWindow() { lock (Gate) { return lastBrave.ToInt64(); } }
        public static bool DiagnosticHookReady() { return hookReady; }
    }
}

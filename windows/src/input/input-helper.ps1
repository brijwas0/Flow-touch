# PhoneTouch input helper (Windows).
#
# Started by the receiver (windows-backend.js). It compiles a small C# class that
# calls the documented user32 SendInput API, prints READY, then reads fixed-format
# command lines from stdin until stdin closes or it receives "Q".
#
# It NEVER evaluates input as PowerShell or runs external programs: each line is
# parsed by the C# code below into numbers / a whitelisted key code / base64 text.
#
#   M <dx> <dy>   relative mouse move        D <L|R|M>  button down     U <L|R|M>  button up
#   W <delta>     vertical wheel             H <delta>  horizontal wheel
#   P <vk>        press+release a whitelisted virtual key
#   T <base64>    type text (base64 of UTF-16LE)
#   Q             quit
#
# Note: Windows (UIPI) does not let a normal program send input to elevated
# (administrator) windows, the UAC prompt or the lock screen.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$source = @'
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;

public static class PhoneTouchInput
{
    [StructLayout(LayoutKind.Sequential)]
    struct MOUSEINPUT
    {
        public int dx;
        public int dy;
        public uint mouseData;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct KEYBDINPUT
    {
        public ushort wVk;
        public ushort wScan;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct HARDWAREINPUT
    {
        public uint uMsg;
        public ushort wParamL;
        public ushort wParamH;
    }

    [StructLayout(LayoutKind.Explicit)]
    struct InputUnion
    {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
        [FieldOffset(0)] public HARDWAREINPUT hi;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct INPUT
    {
        public uint type;
        public InputUnion u;
    }

    [DllImport("user32.dll", SetLastError = true)]
    static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

    [DllImport("user32.dll")]
    static extern uint MapVirtualKey(uint uCode, uint uMapType);

    const uint INPUT_MOUSE = 0;
    const uint INPUT_KEYBOARD = 1;

    const uint MOUSEEVENTF_MOVE = 0x0001;
    const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    const uint MOUSEEVENTF_LEFTUP = 0x0004;
    const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
    const uint MOUSEEVENTF_RIGHTUP = 0x0010;
    const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020;
    const uint MOUSEEVENTF_MIDDLEUP = 0x0040;
    const uint MOUSEEVENTF_WHEEL = 0x0800;
    const uint MOUSEEVENTF_HWHEEL = 0x1000;

    const uint KEYEVENTF_EXTENDEDKEY = 0x0001;
    const uint KEYEVENTF_KEYUP = 0x0002;
    const uint KEYEVENTF_UNICODE = 0x0004;

    static readonly HashSet<int> AllowedKeys = new HashSet<int>(new int[] {
        0x08, 0x09, 0x0D, 0x1B, 0x20, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x2E
    });

    static INPUT MouseInput(int dx, int dy, uint data, uint flags)
    {
        INPUT i = new INPUT();
        i.type = INPUT_MOUSE;
        i.u.mi.dx = dx;
        i.u.mi.dy = dy;
        i.u.mi.mouseData = data;
        i.u.mi.dwFlags = flags;
        return i;
    }

    static INPUT KeyInput(ushort vk, ushort scan, uint flags)
    {
        INPUT i = new INPUT();
        i.type = INPUT_KEYBOARD;
        i.u.ki.wVk = vk;
        i.u.ki.wScan = scan;
        i.u.ki.dwFlags = flags;
        return i;
    }

    static void Send(INPUT[] inputs)
    {
        if (inputs.Length == 0) return;
        SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
    }

    static bool Num(string s, int min, int max, out int value)
    {
        if (!int.TryParse(s, NumberStyles.Integer, CultureInfo.InvariantCulture, out value)) return false;
        return value >= min && value <= max;
    }

    static bool IsExtended(int vk)
    {
        return (vk >= 0x21 && vk <= 0x28) || vk == 0x2D || vk == 0x2E;
    }

    static void Button(string which, bool down)
    {
        uint flag;
        if (which == "L") flag = down ? MOUSEEVENTF_LEFTDOWN : MOUSEEVENTF_LEFTUP;
        else if (which == "R") flag = down ? MOUSEEVENTF_RIGHTDOWN : MOUSEEVENTF_RIGHTUP;
        else if (which == "M") flag = down ? MOUSEEVENTF_MIDDLEDOWN : MOUSEEVENTF_MIDDLEUP;
        else return;
        Send(new INPUT[] { MouseInput(0, 0, 0, flag) });
    }

    static void PressKey(int vk)
    {
        if (!AllowedKeys.Contains(vk)) return;
        uint ext = IsExtended(vk) ? KEYEVENTF_EXTENDEDKEY : 0;
        ushort scan = (ushort)MapVirtualKey((uint)vk, 0);
        Send(new INPUT[] {
            KeyInput((ushort)vk, scan, ext),
            KeyInput((ushort)vk, scan, ext | KEYEVENTF_KEYUP)
        });
    }

    static void TypeText(string text)
    {
        if (text.Length == 0 || text.Length > 1024) return;
        List<INPUT> list = new List<INPUT>();
        foreach (char c in text)
        {
            list.Add(KeyInput(0, c, KEYEVENTF_UNICODE));
            list.Add(KeyInput(0, c, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP));
        }
        Send(list.ToArray());
    }

    static void Combo(int[] vks)
    {
        List<INPUT> list = new List<INPUT>();
        for (int i = 0; i < vks.Length; i++)
        {
            int vk = vks[i];
            uint ext = IsExtended(vk) ? KEYEVENTF_EXTENDEDKEY : 0;
            ushort scan = (ushort)MapVirtualKey((uint)vk, 0);
            list.Add(KeyInput((ushort)vk, scan, ext));
        }
        for (int i = vks.Length - 1; i >= 0; i--)
        {
            int vk = vks[i];
            uint ext = IsExtended(vk) ? KEYEVENTF_EXTENDEDKEY : 0;
            ushort scan = (ushort)MapVirtualKey((uint)vk, 0);
            list.Add(KeyInput((ushort)vk, scan, ext | KEYEVENTF_KEYUP));
        }
        Send(list.ToArray());
    }

    static void Gesture(string g)
    {
        switch (g)
        {
            case "start":
                Send(new INPUT[] {
                    KeyInput(0x5B, (ushort)MapVirtualKey(0x5B, 0), 0),
                    KeyInput(0x5B, (ushort)MapVirtualKey(0x5B, 0), KEYEVENTF_KEYUP)
                });
                break;
            case "desktop":
                Combo(new int[] { 0x5B, 0x44 }); // Win + D
                break;
            case "notifications":
                Combo(new int[] { 0x5B, 0x41 }); // Win + A
                break;
            case "app_next":
                Combo(new int[] { 0x12, 0x09 }); // Alt + Tab
                break;
            case "app_prev":
                Combo(new int[] { 0x12, 0x10, 0x09 }); // Alt + Shift + Tab
                break;
            case "desktop_next":
                Combo(new int[] { 0x5B, 0x11, 0x27 }); // Win + Ctrl + Right
                break;
            case "desktop_prev":
                Combo(new int[] { 0x5B, 0x11, 0x25 }); // Win + Ctrl + Left
                break;
            case "task_view":
                Combo(new int[] { 0x5B, 0x09 }); // Win + Tab
                break;
        }
    }

    static void Zoom(int dy)
    {
        ushort scan = (ushort)MapVirtualKey(0x11, 0);
        Send(new INPUT[] {
            KeyInput(0x11, scan, 0),
            MouseInput(0, 0, unchecked((uint)dy), MOUSEEVENTF_WHEEL),
            KeyInput(0x11, scan, KEYEVENTF_KEYUP)
        });
    }

    static void Handle(string line)
    {
        string[] p = line.Split(' ');
        int a;
        int b;
        switch (p[0])
        {
            case "M":
                if (p.Length == 3 && Num(p[1], -2000, 2000, out a) && Num(p[2], -2000, 2000, out b))
                    Send(new INPUT[] { MouseInput(a, b, 0, MOUSEEVENTF_MOVE) });
                break;
            case "D":
                if (p.Length == 2) Button(p[1], true);
                break;
            case "U":
                if (p.Length == 2) Button(p[1], false);
                break;
            case "W":
                if (p.Length == 2 && Num(p[1], -2400, 2400, out a))
                    Send(new INPUT[] { MouseInput(0, 0, unchecked((uint)a), MOUSEEVENTF_WHEEL) });
                break;
            case "H":
                if (p.Length == 2 && Num(p[1], -2400, 2400, out a))
                    Send(new INPUT[] { MouseInput(0, 0, unchecked((uint)a), MOUSEEVENTF_HWHEEL) });
                break;
            case "P":
                if (p.Length == 2 && Num(p[1], 0, 255, out a)) PressKey(a);
                break;
            case "T":
                if (p.Length == 2 && p[1].Length <= 4096)
                    TypeText(Encoding.Unicode.GetString(Convert.FromBase64String(p[1])));
                break;
            case "G":
                if (p.Length == 2) Gesture(p[1]);
                break;
            case "Z":
                if (p.Length == 2 && Num(p[1], -2400, 2400, out a)) Zoom(a);
                break;
        }
    }

    public static void Run()
    {
        Console.Out.WriteLine("READY");
        Console.Out.Flush();
        string line;
        while ((line = Console.In.ReadLine()) != null)
        {
            line = line.Trim();
            if (line.Length == 0) continue;
            if (line == "Q") break;
            try
            {
                Handle(line);
            }
            catch (Exception)
            {
                // ignore a malformed command and keep running
            }
        }
    }
}
'@

Add-Type -TypeDefinition $source -Language CSharp
[PhoneTouchInput]::Run()

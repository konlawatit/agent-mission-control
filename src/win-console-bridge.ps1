param(
    [Parameter(Mandatory=$true)]
    [ValidateSet("scan", "read", "send-key", "send-text", "select-option")]
    [string]$Action,

    [int]$TargetPid = 0,
    [string]$Value = "",
    [int]$CurrentIndex = 1,
    [int]$TargetIndex = 1,
    [string]$OutputFile = ""
)

$ErrorActionPreference = "SilentlyContinue"

$code = @"
using System;
using System.Text;
using System.Runtime.InteropServices;

public class WinConsoleBridge {
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool FreeConsole();

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool AttachConsole(uint dwProcessId);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern uint GetConsoleProcessList([Out] uint[] lpdwProcessList, uint dwProcessCount);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Auto)]
    public static extern IntPtr CreateFile(
        string lpFileName,
        uint dwDesiredAccess,
        uint dwShareMode,
        IntPtr lpSecurityAttributes,
        uint dwCreationDisposition,
        uint dwFlagsAndAttributes,
        IntPtr hTemplateFile
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CloseHandle(IntPtr hObject);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr OpenProcess(uint processAccess, bool bInheritHandle, uint processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool ReadProcessMemory(
        IntPtr hProcess,
        IntPtr lpBaseAddress,
        [Out] byte[] lpBuffer,
        int dwSize,
        out IntPtr lpNumberOfBytesRead
    );

    [StructLayout(LayoutKind.Sequential)]
    public struct PROCESS_BASIC_INFORMATION {
        public IntPtr Reserved1;
        public IntPtr PebBaseAddress;
        public IntPtr Reserved2_0;
        public IntPtr Reserved2_1;
        public IntPtr UniqueProcessId;
        public IntPtr Reserved3;
    }

    [DllImport("ntdll.dll")]
    public static extern int NtQueryInformationProcess(
        IntPtr processHandle,
        int processInformationClass,
        ref PROCESS_BASIC_INFORMATION processInformation,
        int processInformationLength,
        out int returnLength
    );

    [StructLayout(LayoutKind.Sequential)]
    public struct COORD {
        public short X;
        public short Y;
        public COORD(short x, short y) { X = x; Y = y; }
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct SMALL_RECT {
        public short Left;
        public short Top;
        public short Right;
        public short Bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct CONSOLE_SCREEN_BUFFER_INFO {
        public COORD dwSize;
        public COORD dwCursorPosition;
        public short wAttributes;
        public SMALL_RECT srWindow;
        public COORD dwMaximumWindowSize;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool GetConsoleScreenBufferInfo(
        IntPtr hConsoleOutput,
        out CONSOLE_SCREEN_BUFFER_INFO lpConsoleScreenBufferInfo
    );

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool ReadConsoleOutputCharacterW(
        IntPtr hConsoleOutput,
        [Out] char[] lpCharacter,
        uint nLength,
        COORD dwReadCoord,
        out uint lpNumberOfCharsRead
    );

    [StructLayout(LayoutKind.Explicit, CharSet = CharSet.Unicode)]
    public struct KEY_EVENT_RECORD {
        [FieldOffset(0), MarshalAs(UnmanagedType.Bool)]
        public bool bKeyDown;
        [FieldOffset(4)]
        public ushort wRepeatCount;
        [FieldOffset(6)]
        public ushort wVirtualKeyCode;
        [FieldOffset(8)]
        public ushort wVirtualScanCode;
        [FieldOffset(10)]
        public char UnicodeChar;
        [FieldOffset(12)]
        public uint dwControlKeyState;
    }

    [StructLayout(LayoutKind.Explicit)]
    public struct INPUT_RECORD {
        [FieldOffset(0)]
        public ushort EventType;
        [FieldOffset(4)]
        public KEY_EVENT_RECORD KeyEvent;
    }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool WriteConsoleInputW(
        IntPtr hConsoleInput,
        INPUT_RECORD[] lpBuffer,
        uint nLength,
        out uint lpNumberOfEventsWritten
    );

    [DllImport("user32.dll")]
    public static extern uint MapVirtualKey(uint uCode, uint uMapType);

    private const uint GENERIC_READ = 0x80000000;
    private const uint GENERIC_WRITE = 0x40000000;
    private const uint FILE_SHARE_READ = 0x00000001;
    private const uint FILE_SHARE_WRITE = 0x00000002;
    private const uint OPEN_EXISTING = 3;
    private const ushort KEY_EVENT = 0x0001;
    private const uint ATTACH_PARENT_PROCESS = 0xFFFFFFFF;
    private const uint PROCESS_QUERY_INFORMATION = 0x0400;
    private const uint PROCESS_VM_READ = 0x0010;

    /**
     * Reads the exact OS-level Current Working Directory of a 64-bit Windows process from its PEB.
     */
    public static string GetProcessCwd(uint pid) {
        if (IntPtr.Size != 8) return null; // 64-bit offsets
        IntPtr hProc = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, false, pid);
        if (hProc == IntPtr.Zero) return null;

        try {
            PROCESS_BASIC_INFORMATION pbi = new PROCESS_BASIC_INFORMATION();
            int retLen = 0;
            int status = NtQueryInformationProcess(hProc, 0, ref pbi, Marshal.SizeOf(pbi), out retLen);
            if (status != 0 || pbi.PebBaseAddress == IntPtr.Zero) return null;

            byte[] ptrBuf = new byte[8];
            IntPtr bytesRead;
            // On x64 Windows, ProcessParameters is at PEB + 0x20
            if (!ReadProcessMemory(hProc, IntPtr.Add(pbi.PebBaseAddress, 0x20), ptrBuf, 8, out bytesRead))
                return null;

            long procParamsAddr = BitConverter.ToInt64(ptrBuf, 0);
            if (procParamsAddr == 0) return null;

            // On x64 Windows, CurrentDirectory.DosPath (UNICODE_STRING: ushort Length, ushort MaxLength, uint pad, IntPtr Buffer) is at ProcessParameters + 0x38
            byte[] ustrBuf = new byte[16];
            if (!ReadProcessMemory(hProc, new IntPtr(procParamsAddr + 0x38), ustrBuf, 16, out bytesRead))
                return null;

            ushort byteLen = BitConverter.ToUInt16(ustrBuf, 0);
            long strPtr = BitConverter.ToInt64(ustrBuf, 8);
            if (byteLen == 0 || byteLen > 2048 || strPtr == 0) return null;

            byte[] strBytes = new byte[byteLen];
            if (!ReadProcessMemory(hProc, new IntPtr(strPtr), strBytes, byteLen, out bytesRead))
                return null;

            string cwd = Encoding.Unicode.GetString(strBytes).TrimEnd('\\', '/', '\0');
            return cwd;
        } catch {
            return null;
        } finally {
            CloseHandle(hProc);
        }
    }

    public static uint[] GetConsolePids(uint pid) {
        FreeConsole();
        if (!AttachConsole(pid)) {
            AttachConsole(ATTACH_PARENT_PROCESS);
            return new uint[0];
        }
        try {
            uint[] arr = new uint[64];
            uint n = GetConsoleProcessList(arr, 64);
            if (n == 0 || n > 64) return new uint[] { pid };
            uint[] res = new uint[n];
            Array.Copy(arr, res, n);
            return res;
        } finally {
            FreeConsole();
            AttachConsole(ATTACH_PARENT_PROCESS);
        }
    }

    public static string ReadConsoleText(uint pid, int maxLines) {
        FreeConsole();
        if (!AttachConsole(pid)) {
            AttachConsole(ATTACH_PARENT_PROCESS);
            return null;
        }
        IntPtr hOut = CreateFile("CONOUT$", GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, IntPtr.Zero, OPEN_EXISTING, 0, IntPtr.Zero);
        if (hOut == IntPtr.Zero || hOut == new IntPtr(-1)) {
            FreeConsole();
            AttachConsole(ATTACH_PARENT_PROCESS);
            return null;
        }

        try {
            CONSOLE_SCREEN_BUFFER_INFO csbi;
            if (!GetConsoleScreenBufferInfo(hOut, out csbi)) {
                return null;
            }

            short width = csbi.dwSize.X;
            if (width <= 0) width = 120;
            short bottomRow = Math.Max(csbi.dwCursorPosition.Y, csbi.srWindow.Bottom);
            short topRow = (short)Math.Max(0, bottomRow - maxLines);

            StringBuilder sb = new StringBuilder();
            char[] rowBuf = new char[width];

            for (short y = topRow; y <= bottomRow; y++) {
                uint read = 0;
                if (ReadConsoleOutputCharacterW(hOut, rowBuf, (uint)width, new COORD(0, y), out read) && read > 0) {
                    string line = new string(rowBuf, 0, (int)read).TrimEnd();
                    sb.AppendLine(line);
                }
            }

            return sb.ToString();
        } finally {
            CloseHandle(hOut);
            FreeConsole();
            AttachConsole(ATTACH_PARENT_PROCESS);
        }
    }

    private static INPUT_RECORD MakeKeyRecord(bool down, ushort vk, char ch) {
        INPUT_RECORD rec = new INPUT_RECORD();
        rec.EventType = KEY_EVENT;
        rec.KeyEvent.bKeyDown = down;
        rec.KeyEvent.wRepeatCount = 1;
        rec.KeyEvent.wVirtualKeyCode = vk;
        rec.KeyEvent.wVirtualScanCode = (ushort)MapVirtualKey(vk, 0);
        rec.KeyEvent.UnicodeChar = ch;
        rec.KeyEvent.dwControlKeyState = 0;
        return rec;
    }

    public static bool SendVirtualKey(uint pid, ushort vk, char ch) {
        FreeConsole();
        if (!AttachConsole(pid)) {
            AttachConsole(ATTACH_PARENT_PROCESS);
            return false;
        }
        IntPtr hIn = CreateFile("CONIN$", GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, IntPtr.Zero, OPEN_EXISTING, 0, IntPtr.Zero);
        if (hIn == IntPtr.Zero || hIn == new IntPtr(-1)) {
            FreeConsole();
            AttachConsole(ATTACH_PARENT_PROCESS);
            return false;
        }
        try {
            INPUT_RECORD[] recs = new INPUT_RECORD[2];
            recs[0] = MakeKeyRecord(true, vk, ch);
            recs[1] = MakeKeyRecord(false, vk, ch);
            uint written = 0;
            return WriteConsoleInputW(hIn, recs, 2, out written);
        } finally {
            CloseHandle(hIn);
            FreeConsole();
            AttachConsole(ATTACH_PARENT_PROCESS);
        }
    }

    public static bool SendTextAndEnter(uint pid, string text, bool pressEnter) {
        FreeConsole();
        if (!AttachConsole(pid)) {
            AttachConsole(ATTACH_PARENT_PROCESS);
            return false;
        }
        IntPtr hIn = CreateFile("CONIN$", GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, IntPtr.Zero, OPEN_EXISTING, 0, IntPtr.Zero);
        if (hIn == IntPtr.Zero || hIn == new IntPtr(-1)) {
            FreeConsole();
            AttachConsole(ATTACH_PARENT_PROCESS);
            return false;
        }
        try {
            int count = text.Length * 2 + (pressEnter ? 2 : 0);
            INPUT_RECORD[] recs = new INPUT_RECORD[count];
            int idx = 0;
            foreach (char c in text) {
                recs[idx++] = MakeKeyRecord(true, 0, c);
                recs[idx++] = MakeKeyRecord(false, 0, c);
            }
            if (pressEnter) {
                recs[idx++] = MakeKeyRecord(true, 0x0D, '\r');
                recs[idx++] = MakeKeyRecord(false, 0x0D, '\r');
            }
            uint written = 0;
            return WriteConsoleInputW(hIn, recs, (uint)count, out written);
        } finally {
            CloseHandle(hIn);
            FreeConsole();
            AttachConsole(ATTACH_PARENT_PROCESS);
        }
    }
}
"@

function Emit-Result($obj) {
    $json = ConvertTo-Json -InputObject $obj -Depth 6 -Compress
    if ($OutputFile -ne "") {
        [System.IO.File]::WriteAllText($OutputFile, $json, (New-Object System.Text.UTF8Encoding($false)))
    } else {
        [System.Console]::Out.WriteLine($json)
    }
}

Add-Type -TypeDefinition $code -Language CSharp

if ($Action -eq "scan") {
    $procs = @(Get-Process -Name "claude" -ErrorAction SilentlyContinue)
    $seenConsolePids = New-Object 'System.Collections.Generic.HashSet[uint32]'
    $results = @()

    foreach ($p in $procs) {
        $procId = [uint32]$p.Id
        if ($seenConsolePids.Contains($procId)) {
            continue
        }

        $consolePids = [WinConsoleBridge]::GetConsolePids($procId)
        foreach ($cp in $consolePids) {
            [void]$seenConsolePids.Add([uint32]$cp)
        }

        $cwd = [WinConsoleBridge]::GetProcessCwd($procId)
        $screen = [WinConsoleBridge]::ReadConsoleText($procId, 45)
        if ($null -ne $screen) {
            $results += @{
                pid = $p.Id
                cwd = $cwd
                consolePids = $consolePids
                title = $p.MainWindowTitle
                startTime = if ($p.StartTime) { $p.StartTime.ToString("o") } else { "" }
                screen = $screen
            }
        }
    }
    Emit-Result @{ ok = $true; items = $results }
    exit 0
}

if ($Action -eq "read" -and $TargetPid -gt 0) {
    $cwd = [WinConsoleBridge]::GetProcessCwd([uint32]$TargetPid)
    $screen = [WinConsoleBridge]::ReadConsoleText([uint32]$TargetPid, 45)
    Emit-Result @{ ok = ($null -ne $screen); pid = $TargetPid; cwd = $cwd; screen = $screen }
    exit 0
}

if ($Action -eq "send-key" -and $TargetPid -gt 0) {
    $ok = $false
    switch ($Value.ToLower()) {
        "enter"  { $ok = [WinConsoleBridge]::SendVirtualKey([uint32]$TargetPid, 0x0D, "`r") }
        "esc"    { $ok = [WinConsoleBridge]::SendVirtualKey([uint32]$TargetPid, 0x1B, [char]27) }
        "escape" { $ok = [WinConsoleBridge]::SendVirtualKey([uint32]$TargetPid, 0x1B, [char]27) }
        "up"     { $ok = [WinConsoleBridge]::SendVirtualKey([uint32]$TargetPid, 0x26, [char]0) }
        "down"   { $ok = [WinConsoleBridge]::SendVirtualKey([uint32]$TargetPid, 0x28, [char]0) }
        "tab"    { $ok = [WinConsoleBridge]::SendVirtualKey([uint32]$TargetPid, 0x09, "`t") }
        "space"  { $ok = [WinConsoleBridge]::SendVirtualKey([uint32]$TargetPid, 0x20, " ") }
        default  {
            if ($Value.Length -eq 1) {
                $ch = $Value[0]
                $vk = [uint16][char]::ToUpper($ch)
                $ok = [WinConsoleBridge]::SendVirtualKey([uint32]$TargetPid, $vk, $ch)
            } else {
                $ok = [WinConsoleBridge]::SendTextAndEnter([uint32]$TargetPid, $Value, $false)
            }
        }
    }
    Emit-Result @{ ok = $ok; pid = $TargetPid; key = $Value }
    exit 0
}

if ($Action -eq "select-option" -and $TargetPid -gt 0) {
    $ok = $false
    if ($CurrentIndex -gt 0 -and $TargetIndex -gt 0) {
        $delta = $TargetIndex - $CurrentIndex
        if ($delta -gt 0) {
            for ($i = 0; $i -lt $delta; $i++) {
                [void][WinConsoleBridge]::SendVirtualKey([uint32]$TargetPid, 0x28, [char]0)
                Start-Sleep -Milliseconds 45
            }
        } elseif ($delta -lt 0) {
            for ($i = 0; $i -lt [Math]::Abs($delta); $i++) {
                [void][WinConsoleBridge]::SendVirtualKey([uint32]$TargetPid, 0x26, [char]0)
                Start-Sleep -Milliseconds 45
            }
        }
        Start-Sleep -Milliseconds 45
        $ok = [WinConsoleBridge]::SendVirtualKey([uint32]$TargetPid, 0x0D, "`r")
    } else {
        $ch = if ($Value.Length -ge 1) { $Value[0] } else { '1' }
        $vk = [uint16][char]::ToUpper($ch)
        $ok = [WinConsoleBridge]::SendVirtualKey([uint32]$TargetPid, $vk, $ch)
    }
    Emit-Result @{ ok = $ok; pid = $TargetPid; selected = $TargetIndex }
    exit 0
}

if ($Action -eq "send-text" -and $TargetPid -gt 0) {
    $ok = [WinConsoleBridge]::SendTextAndEnter([uint32]$TargetPid, $Value, $true)
    Emit-Result @{ ok = $ok; pid = $TargetPid }
    exit 0
}

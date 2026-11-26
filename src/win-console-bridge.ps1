param(
    [Parameter(Mandatory=$true)]
    [ValidateSet("scan", "read", "send-key", "send-text", "select-option", "serve")]
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

    // Input events written to the console that the program has not read yet.
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool GetNumberOfConsoleInputEvents(IntPtr hConsoleInput, out uint lpcNumberOfEvents);

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

    // Where the console cursor was in the last ReadConsoleText: its line in the returned text and
    // its column. Claude Code keeps the caret there, so text AFTER a caret at the start of its
    // input box is a dim suggestion, not something typed.
    public static int LastCursorRow = -1;
    public static int LastCursorCol = -1;

    public static string ReadConsoleText(uint pid, int maxLines) {
        LastCursorRow = -1;
        LastCursorCol = -1;
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
            LastCursorRow = csbi.dwCursorPosition.Y - topRow;
            LastCursorCol = csbi.dwCursorPosition.X;

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

    // A key pressed with Ctrl held (e.g. Ctrl+U = 0x55 with control character 0x15).
    public static bool SendCtrlKey(uint pid, ushort vk, char ch) {
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
            recs[0].KeyEvent.dwControlKeyState = 0x0008; // LEFT_CTRL_PRESSED
            recs[1].KeyEvent.dwControlKeyState = 0x0008;
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
            INPUT_RECORD[] recs = new INPUT_RECORD[text.Length * 2];
            int idx = 0;
            foreach (char c in text) {
                recs[idx++] = MakeKeyRecord(true, 0, c);
                recs[idx++] = MakeKeyRecord(false, 0, c);
            }
            uint written = 0;
            bool ok = recs.Length == 0 || WriteConsoleInputW(hIn, recs, (uint)recs.Length, out written);
            if (ok && pressEnter) {
                // Read together with the text, Enter is part of a paste for Claude Code and
                // becomes a newline in the prompt instead of sending it. A fixed delay is not
                // enough: while Claude is busy it reads input late, the text and the Enter pile
                // up and arrive as one chunk. So wait until the text has actually been read
                // (bounded, to stay inside the bridge's request timeout), then a short pause so
                // the Enter is a read of its own.
                var waited = System.Diagnostics.Stopwatch.StartNew();
                uint unread = 0;
                while (waited.ElapsedMilliseconds < 5000 && GetNumberOfConsoleInputEvents(hIn, out unread) && unread > 0) {
                    System.Threading.Thread.Sleep(20);
                }
                System.Threading.Thread.Sleep(Math.Min(900, 250 + text.Length / 8));
                INPUT_RECORD[] enter = new INPUT_RECORD[2];
                enter[0] = MakeKeyRecord(true, 0x0D, '\r');
                enter[1] = MakeKeyRecord(false, 0x0D, '\r');
                ok = WriteConsoleInputW(hIn, enter, 2, out written);
            }
            return ok;
        } finally {
            CloseHandle(hIn);
            FreeConsole();
            AttachConsole(ATTACH_PARENT_PROCESS);
        }
    }
}
"@


Add-Type -TypeDefinition $code -Language CSharp

function Invoke-BridgeAction {
    param(
        [string]$Action,
        [int]$TargetPid = 0,
        [string]$Value = "",
        [int]$CurrentIndex = 1,
        [int]$TargetIndex = 1
    )

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
                    cursorRow = [WinConsoleBridge]::LastCursorRow
                    cursorCol = [WinConsoleBridge]::LastCursorCol
                }
            }
        }
        return @{ ok = $true; items = $results }
    }

    if ($TargetPid -le 0) {
        return @{ ok = $false; error = "TargetPid is required" }
    }

    if ($Action -eq "read") {
        $cwd = [WinConsoleBridge]::GetProcessCwd([uint32]$TargetPid)
        $screen = [WinConsoleBridge]::ReadConsoleText([uint32]$TargetPid, 45)
        return @{ ok = ($null -ne $screen); pid = $TargetPid; cwd = $cwd; screen = $screen }
    }

    if ($Action -eq "send-key") {
        $ok = $false
        switch ($Value.ToLower()) {
            "enter"  { $ok = [WinConsoleBridge]::SendVirtualKey([uint32]$TargetPid, 0x0D, "`r") }
            "esc"    { $ok = [WinConsoleBridge]::SendVirtualKey([uint32]$TargetPid, 0x1B, [char]27) }
            "escape" { $ok = [WinConsoleBridge]::SendVirtualKey([uint32]$TargetPid, 0x1B, [char]27) }
            "up"     { $ok = [WinConsoleBridge]::SendVirtualKey([uint32]$TargetPid, 0x26, [char]0) }
            "down"   { $ok = [WinConsoleBridge]::SendVirtualKey([uint32]$TargetPid, 0x28, [char]0) }
            "left"   { $ok = [WinConsoleBridge]::SendVirtualKey([uint32]$TargetPid, 0x25, [char]0) }
            "right"  { $ok = [WinConsoleBridge]::SendVirtualKey([uint32]$TargetPid, 0x27, [char]0) }
            # Claude Code: delete from the cursor to the start of the line (repeat for more lines).
            "ctrl-u" { $ok = [WinConsoleBridge]::SendCtrlKey([uint32]$TargetPid, 0x55, [char]0x15) }
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
        return @{ ok = $ok; pid = $TargetPid; key = $Value }
    }

    if ($Action -eq "select-option") {
        $ok = $false
        if ($CurrentIndex -gt 0 -and $TargetIndex -gt 0) {
            $delta = $TargetIndex - $CurrentIndex
            $vk = if ($delta -gt 0) { 0x28 } else { 0x26 }
            for ($i = 0; $i -lt [Math]::Abs($delta); $i++) {
                [void][WinConsoleBridge]::SendVirtualKey([uint32]$TargetPid, $vk, [char]0)
                Start-Sleep -Milliseconds 45
            }
            Start-Sleep -Milliseconds 45
            $ok = [WinConsoleBridge]::SendVirtualKey([uint32]$TargetPid, 0x0D, "`r")
        } else {
            $ch = if ($Value.Length -ge 1) { $Value[0] } else { '1' }
            $vk = [uint16][char]::ToUpper($ch)
            $ok = [WinConsoleBridge]::SendVirtualKey([uint32]$TargetPid, $vk, $ch)
        }
        return @{ ok = $ok; pid = $TargetPid; selected = $TargetIndex }
    }

    if ($Action -eq "send-text") {
        $ok = [WinConsoleBridge]::SendTextAndEnter([uint32]$TargetPid, $Value, $true)
        return @{ ok = $ok; pid = $TargetPid }
    }

    return @{ ok = $false; error = "Unknown action: $Action" }
}

if ($Action -eq "serve") {
    # Long-lived mode: the C# above is compiled once, then one JSON request per stdin line
    # is answered with one JSON line on stdout. The pipe streams are opened up front because
    # AttachConsole/FreeConsole swap the console handles that [Console]::In/Out would use.
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    $reader = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), $utf8)
    $writer = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(), $utf8)
    $writer.AutoFlush = $true
    $writer.WriteLine((ConvertTo-Json -InputObject @{ id = 0; ok = $true; ready = $true } -Compress))

    while ($true) {
        $line = $reader.ReadLine()
        if ($null -eq $line) { break }
        if ($line.Trim() -eq "") { continue }
        $id = $null
        try {
            $req = ConvertFrom-Json -InputObject $line
            $id = $req.id
            $result = Invoke-BridgeAction -Action ([string]$req.action) `
                -TargetPid ([int]$req.targetPid) `
                -Value ([string]$req.value) `
                -CurrentIndex ([int]$req.currentIndex) `
                -TargetIndex ([int]$req.targetIndex)
        } catch {
            $result = @{ ok = $false; error = $_.Exception.Message }
        }
        $result.id = $id
        $writer.WriteLine((ConvertTo-Json -InputObject $result -Depth 6 -Compress))
    }
    exit 0
}

$oneShot = Invoke-BridgeAction -Action $Action -TargetPid $TargetPid -Value $Value `
    -CurrentIndex $CurrentIndex -TargetIndex $TargetIndex
$json = ConvertTo-Json -InputObject $oneShot -Depth 6 -Compress
if ($OutputFile -ne "") {
    [System.IO.File]::WriteAllText($OutputFile, $json, (New-Object System.Text.UTF8Encoding($false)))
} else {
    [System.Console]::Out.WriteLine($json)
}
exit 0

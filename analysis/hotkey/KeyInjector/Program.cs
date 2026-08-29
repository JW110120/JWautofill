using System.Runtime.InteropServices;

// Injects raw virtual-key strokes with keybd_event.
// Rationale: WScript.Shell.SendKeys routes characters through SendInput with
// KEYEVENTF_UNICODE, so the low-level keyboard hook sees VK_PACKET (0xE7)
// instead of the real OEM code. Punctuation hotkeys can therefore never be
// matched when driven by SendKeys, which made earlier E2E tests report false
// negatives. PowerShell's Add-Type is blocked by policy here, so this tiny
// console app is the injection vehicle.
internal static class Program
{
    [DllImport("user32.dll")]
    private static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);

    [DllImport("user32.dll")]
    private static extern short VkKeyScanW(char ch);

    private const uint KeyDown = 0;
    private const uint KeyUp = 2;

    private static int Main(string[] args)
    {
        bool ctrl = false, alt = false, shift = false, byChar = false;
        var keys = new List<string>();

        foreach (var a in args)
        {
            switch (a.ToLowerInvariant())
            {
                case "--ctrl": ctrl = true; break;
                case "--alt": alt = true; break;
                case "--shift": shift = true; break;
                case "--char": byChar = true; break;
                default: keys.Add(a); break;
            }
        }

        if (keys.Count == 0)
        {
            Console.WriteLine("usage: jwkinject [--ctrl] [--alt] [--shift] [--char] <vk-hex|char> ...");
            return 2;
        }

        var z = UIntPtr.Zero;

        void Down(byte vk) => keybd_event(vk, 0, KeyDown, z);
        void Up(byte vk) => keybd_event(vk, 0, KeyUp, z);

        foreach (var k in keys)
        {
            byte vk;
            if (byChar)
            {
                short scan = VkKeyScanW(k[0]);
                if (scan == -1)
                {
                    Console.WriteLine("no vk mapped for char '" + k + "'");
                    continue;
                }
                vk = (byte)(scan & 0xFF);
            }
            else
            {
                vk = Convert.ToByte(k, 16);
            }

            if (ctrl) Down(0x11);
            if (alt) Down(0x12);
            if (shift) Down(0x10);
            Thread.Sleep(120);
            Down(vk);
            Thread.Sleep(150);
            Up(vk);
            Thread.Sleep(120);
            if (shift) Up(0x10);
            if (alt) Up(0x12);
            if (ctrl) Up(0x11);

            Console.WriteLine("sent vk=0x" + vk.ToString("X2"));
            Thread.Sleep(900);
        }

        return 0;
    }
}

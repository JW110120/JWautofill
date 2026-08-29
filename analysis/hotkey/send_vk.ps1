$ErrorActionPreference = "Continue"
# Inject raw virtual-key strokes via keybd_event.
# WScript.Shell.SendKeys is avoided because it emits an extra NUMLOCK keystroke
# to sync keyboard state, which pollutes hotkey recording tests.
# Usage: .\send_vk.ps1 -Vk 0xBA -Ctrl 1 -Alt 1
param([int]$Vk = 0xBA, [int]$Ctrl = 1, [int]$Alt = 1, [int]$Shift = 0)

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class JWKbd {
  [DllImport("user32.dll")]
  public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
}
"@

$down = 0
$up   = 2
$z    = [UIntPtr]::Zero

if ($Ctrl)  { [JWKbd]::keybd_event(0x11, 0, $down, $z) }
if ($Alt)   { [JWKbd]::keybd_event(0x12, 0, $down, $z) }
if ($Shift) { [JWKbd]::keybd_event(0x10, 0, $down, $z) }
Start-Sleep -Milliseconds 120
[JWKbd]::keybd_event([byte]$Vk, 0, $down, $z)
Start-Sleep -Milliseconds 150
[JWKbd]::keybd_event([byte]$Vk, 0, $up, $z)
Start-Sleep -Milliseconds 120
if ($Shift) { [JWKbd]::keybd_event(0x10, 0, $up, $z) }
if ($Alt)   { [JWKbd]::keybd_event(0x12, 0, $up, $z) }
if ($Ctrl)  { [JWKbd]::keybd_event(0x11, 0, $up, $z) }
"sent vk=0x{0:X2}" -f $Vk

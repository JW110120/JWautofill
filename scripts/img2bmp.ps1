param(
  [string]$Path,
  [string]$Out
)
# Re-encode any image to a plain 24bpp BMP (ASCII-only source on purpose).
Add-Type -AssemblyName System.Drawing
$bmp = [System.Drawing.Bitmap]::FromFile($Path)
$w = $bmp.Width; $h = $bmp.Height
$conv = New-Object System.Drawing.Bitmap $w, $h, ([System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
$g = [System.Drawing.Graphics]::FromImage($conv)
$g.DrawImage($bmp, 0, 0, $w, $h)
$g.Dispose()
$conv.Save($Out, [System.Drawing.Imaging.ImageFormat]::Bmp)
$conv.Dispose()
$bmp.Dispose()
Write-Output ("OK {0} {1} -> {2}" -f $w, $h, $Out)

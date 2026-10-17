param(
  [string]$Path,
  [string]$Out,
  [int]$Cols = 106
)
# Decode an image to PPM(P6), print a coarse ASCII overview (ASCII-only source on purpose).
Add-Type -AssemblyName System.Drawing
$bmp = [System.Drawing.Bitmap]::FromFile($Path)
$w = $bmp.Width; $h = $bmp.Height
Write-Output ("SIZE {0} {1}" -f $w, $h)

$rect = New-Object System.Drawing.Rectangle 0, 0, $w, $h
$data = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly,
                      [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
$stride = $data.Stride
$bytes = [byte[]]::new($stride * $h)
[System.Runtime.InteropServices.Marshal]::Copy([IntPtr]$data.Scan0, $bytes, 0, $bytes.Length)
$bmp.UnlockBits($data)
$bmp.Dispose()

$ppm = [byte[]]::new($w * $h * 3)
for ($y = 0; $y -lt $h; $y++) {
  $base = $y * $stride
  $dst = $y * $w * 3
  for ($x = 0; $x -lt $w; $x++) {
    $i = $base + $x * 3
    $ppm[$dst + $x * 3]     = $bytes[$i + 2]
    $ppm[$dst + $x * 3 + 1] = $bytes[$i + 1]
    $ppm[$dst + $x * 3 + 2] = $bytes[$i]
  }
}
$hdr = [System.Text.Encoding]::ASCII.GetBytes("P6`n$w $h`n255`n")
$all = [byte[]]::new($hdr.Length + $ppm.Length)
[Array]::Copy($hdr, 0, $all, 0, $hdr.Length)
[Array]::Copy($ppm, 0, $all, $hdr.Length, $ppm.Length)
[System.IO.File]::WriteAllBytes($Out, $all)

# ASCII overview: each cell samples every 2nd pixel of its block.
$rows = [int]($Cols * $h / $w)
if ($rows -lt 8) { $rows = 8 }
$out2 = New-Object System.Text.StringBuilder
for ($gy = 0; $gy -lt $rows; $gy++) {
  $sb = New-Object System.Text.StringBuilder
  for ($gx = 0; $gx -lt $Cols; $gx++) {
    $x0 = [int]($gx * $w / $Cols); $x1 = [int](($gx + 1) * $w / $Cols)
    $y0 = [int]($gy * $h / $rows); $y1 = [int](($gy + 1) * $h / $rows)
    $orange = 0; $dark = 0; $tot = 0
    for ($y = $y0; $y -lt $y1; $y += 3) {
      $base = $y * $stride
      for ($x = $x0; $x -lt $x1; $x += 3) {
        $i = $base + $x * 3
        $b = $bytes[$i]; $g = $bytes[$i + 1]; $r = $bytes[$i + 2]
        $tot++
        if ($r -gt 150 -and $g -gt 60 -and $g -lt 200 -and $b -lt 110 -and ($r - $b) -gt 80) { $orange++ }
        elseif ($r -lt 110 -and $g -lt 110 -and $b -lt 110) { $dark++ }
      }
    }
    $c = '.'
    if ($tot -gt 0) {
      if ($orange * 3 -ge $tot) { $c = 'O' }
      elseif ($orange -gt 0) { $c = 'o' }
      elseif ($dark * 4 -ge $tot) { $c = '#' }
      elseif ($dark -gt 0) { $c = '+' }
    }
    [void]$sb.Append($c)
  }
  [void]$out2.AppendLine($sb.ToString())
}
Write-Output $out2.ToString()

param(
  [string]$Path,
  [string]$Out,
  [int]$X,
  [int]$Y,
  [int]$W,
  [int]$H,
  [int]$Zoom = 4
)
# Crop a region from a BMP and scale it up with nearest-neighbour (ASCII-only source).
Add-Type -AssemblyName System.Drawing
$bmp = [System.Drawing.Bitmap]::FromFile($Path)
if ($X -lt 0) { $X = 0 }
if ($Y -lt 0) { $Y = 0 }
if ($X + $W -gt $bmp.Width) { $W = $bmp.Width - $X }
if ($Y + $H -gt $bmp.Height) { $H = $bmp.Height - $Y }
$rect = New-Object System.Drawing.Rectangle $X, $Y, $W, $H
$crop = $bmp.Clone($rect, $bmp.PixelFormat)
$ow = $W * $Zoom; $oh = $H * $Zoom
$big = New-Object System.Drawing.Bitmap $ow, $oh, ([System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
$g = [System.Drawing.Graphics]::FromImage($big)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
$g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::Half
$g.DrawImage($crop, 0, 0, $ow, $oh)
$g.Dispose()
$big.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$big.Dispose(); $crop.Dispose(); $bmp.Dispose()
Write-Output ("OK {0}x{1} zoom{2} -> {3}" -f $W, $H, $Zoom, $Out)

# Converts a screenshot (PNG/JPEG) to a JPEG no wider than -MaxWidth, using the .NET drawing classes that ship with
# Windows (no extra tools). Prints "width height" of the output on success.
param([Parameter(Mandatory=$true)][string]$In, [Parameter(Mandatory=$true)][string]$Out, [int]$MaxWidth = 1280, [int]$Quality = 82)
Add-Type -AssemblyName System.Drawing
$img = [System.Drawing.Image]::FromFile($In)
try {
  $scale = [Math]::Min(1.0, $MaxWidth / $img.Width)
  $w = [Math]::Max(1, [int]($img.Width * $scale)); $h = [Math]::Max(1, [int]($img.Height * $scale))
  $bmp = New-Object System.Drawing.Bitmap $w, $h, ([System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
  $g.Clear([System.Drawing.Color]::Black)
  $g.DrawImage($img, 0, 0, $w, $h)
  $g.Dispose()
  $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
  $params = New-Object System.Drawing.Imaging.EncoderParameters 1
  $params.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality, [long]$Quality)
  $bmp.Save($Out, $codec, $params)
  $bmp.Dispose()
  "$w $h"
} finally { $img.Dispose() }

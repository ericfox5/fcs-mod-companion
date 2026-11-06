# Converts a screenshot (PNG/JPEG) to a JPEG no wider than -MaxWidth, using the .NET drawing classes that ship with
# Windows (no extra tools). Prints "width height range" of the output on success, where range is the spread of
# brightness (0-255) across a 32x18 average of the picture: a blank frame (one flat colour) is <= 6, a real photo is far
# more. -Check only measures the input (prints "width height range" of the input) and writes nothing.
param([Parameter(Mandatory=$true)][string]$In, [string]$Out, [int]$MaxWidth = 1280, [int]$Quality = 82, [switch]$Check)
Add-Type -AssemblyName System.Drawing
function Get-Range($image) {
  $small = New-Object System.Drawing.Bitmap 32, 18, ([System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $sg = [System.Drawing.Graphics]::FromImage($small)
  $sg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBilinear
  $wrap = New-Object System.Drawing.Imaging.ImageAttributes; $wrap.SetWrapMode([System.Drawing.Drawing2D.WrapMode]::TileFlipXY) # no dark edges
  $sg.DrawImage($image, (New-Object System.Drawing.Rectangle 0, 0, 32, 18), 0, 0, $image.Width, $image.Height, [System.Drawing.GraphicsUnit]::Pixel, $wrap); $sg.Dispose()
  $lo = 255.0; $hi = 0.0
  for ($y = 0; $y -lt 18; $y++) { for ($x = 0; $x -lt 32; $x++) {
    $c = $small.GetPixel($x, $y); $l = 0.299 * $c.R + 0.587 * $c.G + 0.114 * $c.B
    if ($l -lt $lo) { $lo = $l }; if ($l -gt $hi) { $hi = $l }
  } }
  $small.Dispose()
  [int][Math]::Round($hi - $lo)
}
$img = [System.Drawing.Image]::FromFile($In)
try {
  if ($Check) { "$($img.Width) $($img.Height) $(Get-Range $img)"; return }
  if (-not $Out) { throw '-Out is required unless -Check is given' }
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
  "$w $h $(Get-Range $bmp)"
  $bmp.Dispose()
} finally { $img.Dispose() }

@echo off
:: Packages the Firefox shell into an .xpi (zip) for side-loading on Firefox for Android.
:: Output: ssd-tick-firefox.xpi in the current directory.
:: Usage: run from ssd-tick-2\

set OUT=ssd-tick-firefox.xpi
if exist "%OUT%" del "%OUT%"

powershell -NoProfile -Command ^
  "Add-Type -Assembly 'System.IO.Compression.FileSystem'; " ^
  "$src = Resolve-Path '.'; " ^
  "$dst = Join-Path $src 'ssd-tick-firefox.xpi'; " ^
  "$excludes = @('ssd-tick-firefox.xpi','manifest-chrome.json','build-firefox.bat','.git','.gitignore','test'); " ^
  "$tmp = [System.IO.Path]::GetTempPath() + [System.Guid]::NewGuid(); " ^
  "New-Item -ItemType Directory $tmp | Out-Null; " ^
  "Get-ChildItem -Path $src -Recurse | Where-Object { " ^
  "  $rel = $_.FullName.Substring($src.Path.Length+1); " ^
  "  $top = $rel.Split([IO.Path]::DirectorySeparatorChar)[0]; " ^
  "  -not ($excludes -contains $top) -and -not ($excludes -contains $_.Name) " ^
  "} | ForEach-Object { " ^
  "  $rel = $_.FullName.Substring($src.Path.Length+1); " ^
  "  $dest = Join-Path $tmp $rel; " ^
  "  if ($_.PSIsContainer) { New-Item -ItemType Directory -Force $dest | Out-Null } " ^
  "  else { New-Item -ItemType File -Force $dest | Out-Null; Copy-Item $_.FullName $dest } " ^
  "}; " ^
  "[System.IO.Compression.ZipFile]::CreateFromDirectory($tmp, $dst); " ^
  "Remove-Item -Recurse -Force $tmp"

if exist "%OUT%" (
  echo Built: %OUT%
) else (
  echo ERROR: build failed.
  exit /b 1
)

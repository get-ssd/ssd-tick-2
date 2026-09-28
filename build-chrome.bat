@echo off
:: Builds the Chrome shell into an unpacked folder for chrome://extensions Developer mode.
:: Output: dist\chrome\  (load this folder via "Load unpacked")
:: Usage: run from ssd-tick-2\

if not exist dist mkdir dist
set OUT=dist\chrome
if exist "%OUT%" rmdir /s /q "%OUT%"
mkdir "%OUT%"

powershell -NoProfile -Command ^
  "$src = Resolve-Path '.'; " ^
  "$dst = Join-Path $src 'dist\chrome'; " ^
  "$excludes = @('dist','demo','.venv','manifest.json','manifest-chrome.json','build-firefox.bat','build-chrome.bat','.git','.gitignore','background\background.js'); " ^
  "Copy-Item (Join-Path $src 'manifest-chrome.json') (Join-Path $dst 'manifest.json'); " ^
  "Get-ChildItem -Path $src -Recurse | Where-Object { " ^
  "  $rel = $_.FullName.Substring($src.Path.Length+1); " ^
  "  $top = $rel.Split([IO.Path]::DirectorySeparatorChar)[0]; " ^
  "  -not ($excludes -contains $top) -and -not ($excludes -contains $_.Name) -and -not ($excludes -contains $rel) " ^
  "} | ForEach-Object { " ^
  "  $rel = $_.FullName.Substring($src.Path.Length+1); " ^
  "  $dest = Join-Path $dst $rel; " ^
  "  if ($_.PSIsContainer) { New-Item -ItemType Directory -Force $dest | Out-Null } " ^
  "  else { New-Item -ItemType File -Force $dest | Out-Null; Copy-Item $_.FullName $dest } " ^
  "}"

if exist "%OUT%\manifest.json" (
  echo Built: %OUT%
) else (
  echo ERROR: build failed.
  exit /b 1
)

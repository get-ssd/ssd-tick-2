@echo off
:: Packages the Firefox shell into an .xpi for side-loading on Firefox for Android.
:: Output: dist\ssd-tick-firefox.xpi and dist\firefox-unpacked\ (for web-ext)
:: Runs from its own folder wherever it is started.
:: Note: uses ZipArchive.CreateEntry to ensure forward-slash paths (required by Firefox).
:: test/ is excluded. With .devmode present, test/bootstrap.js is packaged for the
:: localhost test bootstrap; otherwise the content scripts that reference test/ are
:: dropped from the packaged manifest, or Firefox refuses to load it.

cd /d "%~dp0"
if not exist dist mkdir dist
set OUT=dist\ssd-tick-firefox.xpi
if exist "%OUT%" del "%OUT%"

powershell -NoProfile -Command ^
  "Add-Type -Assembly 'System.IO.Compression.FileSystem'; " ^
  "Add-Type -Assembly 'System.IO.Compression'; " ^
  "$src = (Resolve-Path '.').Path; " ^
  "$dst = Join-Path $src 'dist\ssd-tick-firefox.xpi'; " ^
  "$excludeTop = @('dist','.git','test','demo','.venv','.devmode'); " ^
  "$excludeNames = @('manifest-chrome.json','build-firefox.bat','build-chrome.bat','.gitignore'); " ^
  "$excludeRel = @('background\service-worker.js'); " ^
  "$fs = [System.IO.File]::Open($dst, [System.IO.FileMode]::Create); " ^
  "$zip = New-Object System.IO.Compression.ZipArchive($fs, [System.IO.Compression.ZipArchiveMode]::Create); " ^
  "$devmode = Test-Path (Join-Path $src '.devmode'); " ^
  "Get-ChildItem -Path $src -Recurse -File | ForEach-Object { " ^
  "  $rel = $_.FullName.Substring($src.Length+1); " ^
  "  $top = $rel.Split([IO.Path]::DirectorySeparatorChar)[0]; " ^
  "  if ($excludeTop -contains $top -and -not ($devmode -and $rel -eq 'test\bootstrap.js')) { return }; " ^
  "  if ($excludeNames -contains $_.Name) { return }; " ^
  "  if ($excludeRel -contains $rel) { return }; " ^
  "  $entryName = $rel.Replace('\', '/'); " ^
  "  $entry = $zip.CreateEntry($entryName, [System.IO.Compression.CompressionLevel]::Optimal); " ^
  "  $es = $entry.Open(); " ^
  "  if ($rel -eq 'manifest.json' -and -not $devmode) { " ^
  "    $m = Get-Content $_.FullName -Raw | ConvertFrom-Json; " ^
  "    $m.content_scripts = @($m.content_scripts | Where-Object { -not ($_.js | Where-Object { $_ -like 'test/*' }) }); " ^
  "    $b = (New-Object System.Text.UTF8Encoding $false).GetBytes(($m | ConvertTo-Json -Depth 10)); " ^
  "    $es.Write($b, 0, $b.Length); $es.Dispose(); return " ^
  "  }; " ^
  "  $fs2 = [System.IO.File]::OpenRead($_.FullName); " ^
  "  $fs2.CopyTo($es); " ^
  "  $fs2.Dispose(); $es.Dispose() " ^
  "}; " ^
  "$zip.Dispose(); $fs.Dispose()"

if not exist "%OUT%" (
  echo ERROR: build failed.
  exit /b 1
)
echo Built: %OUT%

:: Unzipped copy for web-ext --source-dir (see test\TESTING-MOCK.md).
set UNPACKED=dist\firefox-unpacked
if exist "%UNPACKED%" rmdir /s /q "%UNPACKED%"
powershell -NoProfile -Command ^
  "Add-Type -Assembly 'System.IO.Compression.FileSystem'; " ^
  "[System.IO.Compression.ZipFile]::ExtractToDirectory((Resolve-Path '%OUT%').Path, (Join-Path (Resolve-Path '.').Path '%UNPACKED%'))"
if not exist "%UNPACKED%\manifest.json" (
  echo ERROR: unzip failed.
  exit /b 1
)
echo Built: %UNPACKED%

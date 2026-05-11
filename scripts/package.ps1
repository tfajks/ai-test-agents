# Creates a properly formatted deployment ZIP for AWS Elastic Beanstalk.
# Compress-Archive uses Windows backslashes — EB/Linux can't extract those.
# This script uses System.IO.Compression to write forward-slash entry names.

param(
    [string]$Version = "next",
    [string]$OutDir  = "$PSScriptRoot\.."
)

$rootDir = Resolve-Path "$PSScriptRoot\.."
$zipPath = Join-Path $OutDir "deploy-$Version.zip"

if (Test-Path $zipPath) { Remove-Item $zipPath }

Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName System.IO.Compression

$zipStream = [System.IO.File]::Open($zipPath, [System.IO.FileMode]::Create)
$archive   = [System.IO.Compression.ZipArchive]::new($zipStream, [System.IO.Compression.ZipArchiveMode]::Create)

$filesToAdd = @()

Get-ChildItem -Path "$rootDir\dist" -Recurse -File | ForEach-Object {
    $rel = $_.FullName.Substring($rootDir.ToString().Length + 1) -replace '\\', '/'
    $filesToAdd += @{ Path = $_.FullName; Entry = $rel }
}

foreach ($name in @("package.json", "package-lock.json", "Procfile")) {
    $filesToAdd += @{ Path = "$rootDir\$name"; Entry = $name }
}

foreach ($f in $filesToAdd) {
    $entry       = $archive.CreateEntry($f.Entry, [System.IO.Compression.CompressionLevel]::Optimal)
    $entryStream = $entry.Open()
    $fileStream  = [System.IO.File]::OpenRead($f.Path)
    $fileStream.CopyTo($entryStream)
    $fileStream.Dispose()
    $entryStream.Dispose()
}

$archive.Dispose()
$zipStream.Dispose()

Write-Host "Created: $zipPath ($([Math]::Round((Get-Item $zipPath).Length / 1KB, 1)) KB)"

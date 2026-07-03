#Requires -Version 5.1
# release.ps1 — bump all runtimes, run checks, commit, push, and tag.
#
# Usage:
#   .\scripts\release.ps1 1.12.4
#   .\scripts\release.ps1 -SkipTests 1.12.4
#   .\scripts\release.ps1 -NoTag 1.12.4     # commit+push only, tag separately

[CmdletBinding()]
param(
    [Parameter(Position = 0, Mandatory = $true)]
    [ValidatePattern('^\d+\.\d+\.\d+$')]
    [string]$NewVersion,

    [switch]$SkipTests,
    [switch]$NoTag
)

$ErrorActionPreference = 'Stop'

Set-Location (Split-Path $PSScriptRoot -Parent)

# ── helpers ───────────────────────────────────────────────────────────────────

function Die([string]$msg) { Write-Error "ERROR: $msg"; exit 1 }
function Info([string]$msg) { Write-Host "  -> $msg" }
function Step([string]$msg) { Write-Host ""; Write-Host ">> $msg" }

function Invoke-Checked([scriptblock]$cmd) {
    & $cmd
    if ($LASTEXITCODE -ne 0) { Die "Command failed with exit code $LASTEXITCODE" }
}

# ── detect current version ────────────────────────────────────────────────────

$pkgJson = Get-Content "packages\cnos\package.json" -Raw | ConvertFrom-Json
$OldVersion = $pkgJson.version
if (-not $OldVersion) { Die "Could not detect current version from packages/cnos/package.json" }
if ($OldVersion -eq $NewVersion) { Die "Already at $NewVersion — nothing to do" }

Write-Host ""
Write-Host "Release: $OldVersion -> $NewVersion"

# ── pre-flight ────────────────────────────────────────────────────────────────

Step "Pre-flight checks"

$branch = git branch --show-current
if ($branch -ne 'main') { Die "Must be on main (currently on '$branch')" }
Info "Branch: main OK"

$dirty = git status --porcelain
if ($dirty) { Die "Working tree is dirty — commit or stash changes first" }
Info "Working tree: clean OK"

Info "Fetching origin/main..."
git fetch --quiet origin main
$local  = git rev-parse HEAD
$remote = git rev-parse origin/main
if ($local -ne $remote) { Die "Local main is not in sync with origin/main - run: git pull origin main" }
Info "Up to date with origin/main OK"

# ── tests ─────────────────────────────────────────────────────────────────────

Step "Tests"

if (-not $SkipTests) {
    Info "Running pnpm test..."
    Invoke-Checked { pnpm test }
    Info "Tests passed OK"

    $mvn = "$env:USERPROFILE\.m2\maven-3.9.9\bin\mvn.cmd"
    if (-not (Test-Path $mvn)) { $mvn = 'mvn' }

    Info "Compiling Java (compile check)..."
    Invoke-Checked { & $mvn --quiet --batch-mode --no-transfer-progress clean compile -f packages\java\pom.xml "-Drevision=$OldVersion" }
    Info "Java compile OK"

    Info "Compiling Kotlin (compile check)..."
    Invoke-Checked { & $mvn --quiet --batch-mode --no-transfer-progress clean compile -f packages\kotlin\pom.xml "-Drevision=$OldVersion" }
    Info "Kotlin compile OK"
} else {
    Info "Skipped (-SkipTests)"
}

# ── version bumps ─────────────────────────────────────────────────────────────

Step "Bumping versions ($OldVersion -> $NewVersion)"

$OLD = $OldVersion
$NEW = $NewVersion

# Node.js: version field + inter-package peer dep constraints
Get-ChildItem -Path packages -Recurse -Filter package.json |
    Where-Object { $_.FullName -notmatch '\\node_modules\\' } |
    ForEach-Object {
        $content = Get-Content $_.FullName -Raw
        $content = $content -replace [regex]::Escape("`"version`": `"$OLD`""), "`"version`": `"$NEW`""
        $content = $content -replace [regex]::Escape("`"^$OLD`""), "`"^$NEW`""
        Set-Content $_.FullName $content -Encoding utf8 -NoNewline
    }
Info "Node.js OK"

# Python: version + intra-monorepo dep lower-bounds
Get-ChildItem -Path packages\python -Recurse -Filter pyproject.toml |
    ForEach-Object {
        $content = Get-Content $_.FullName -Raw
        $content = $content -replace [regex]::Escape("version = `"$OLD`""), "version = `"$NEW`""
        $content = $content -replace [regex]::Escape("kitsy-cnos>=$OLD"), "kitsy-cnos>=$NEW"
        $content = $content -replace [regex]::Escape("kitsy-cnos-gcp>=$OLD"), "kitsy-cnos-gcp>=$NEW"
        Set-Content $_.FullName $content -Encoding utf8 -NoNewline
    }
Info "Python OK"

# Rust: crate Cargo.toml files only (depth >= 2, skip workspace root and target/)
Get-ChildItem -Path packages\rust -Recurse -Filter Cargo.toml |
    Where-Object { $_.FullName -notmatch '\\target\\' -and ($_.FullName -replace '\\','/' -split '/').Count -gt (($_.Directory.FullName -replace '\\','/' -split '/').Count - 1) } |
    Where-Object { $_.DirectoryName -ne (Resolve-Path packages\rust).Path } |
    ForEach-Object {
        $content = Get-Content $_.FullName -Raw
        $content = $content -replace [regex]::Escape("version = `"$OLD`""), "version = `"$NEW`""
        Set-Content $_.FullName $content -Encoding utf8 -NoNewline
    }
Info "Rust OK"

# Java + Kotlin: <revision> in parent POMs only
foreach ($pom in @('packages\java\pom.xml', 'packages\kotlin\pom.xml')) {
    $content = Get-Content $pom -Raw
    $content = $content -replace [regex]::Escape("<revision>$OLD</revision>"), "<revision>$NEW</revision>"
    Set-Content $pom $content -Encoding utf8 -NoNewline
}
Info "Java / Kotlin OK"

# C#: <Version> element and PackageReference Version= attribute
Get-ChildItem -Path packages\csharp -Recurse -Filter *.csproj |
    ForEach-Object {
        $content = Get-Content $_.FullName -Raw
        $content = $content -replace [regex]::Escape("<Version>$OLD</Version>"), "<Version>$NEW</Version>"
        $content = $content -replace [regex]::Escape("Version=`"$OLD`""), "Version=`"$NEW`""
        Set-Content $_.FullName $content -Encoding utf8 -NoNewline
    }
Info "C# OK"

# PHP: no version field in composer.json — Packagist reads from git tags
Info "PHP OK (no version field in composer.json)"

# ── commit ────────────────────────────────────────────────────────────────────

Step "Committing"

git add -A
git commit -m @"
chore(release): bump all runtimes to $NewVersion

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
"@
if ($LASTEXITCODE -ne 0) { Die "git commit failed" }
Info "Committed OK"

# ── push ──────────────────────────────────────────────────────────────────────

Step "Pushing to origin/main"

git push origin main
if ($LASTEXITCODE -ne 0) { Die "git push failed" }
Info "Pushed OK"

# ── tag ───────────────────────────────────────────────────────────────────────

if (-not $NoTag) {
    Step "Tagging v$NewVersion"
    git tag "v$NewVersion"
    git push origin "v$NewVersion"
    if ($LASTEXITCODE -ne 0) { Die "git push tag failed" }
    Info "Tag v$NewVersion pushed OK"
    Write-Host ""
    Write-Host "Done. CI will now publish v$NewVersion to all registries."
} else {
    Write-Host ""
    Write-Host "Done. Version bump pushed to main."
    Write-Host "When ready to release, run:"
    Write-Host "  git tag v$NewVersion; git push origin v$NewVersion"
}

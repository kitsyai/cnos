#Requires -Version 5.1
# release.ps1 — bump all runtimes, run checks, commit, push, and tag.
#
# Usage:
#   .\scripts\release.ps1 patch          # 1.2.3 -> 1.2.4
#   .\scripts\release.ps1 minor          # 1.2.3 -> 1.3.0
#   .\scripts\release.ps1 major          # 1.2.3 -> 2.0.0
#   .\scripts\release.ps1 1.12.4         # explicit version
#   .\scripts\release.ps1 -SkipTests patch
#   .\scripts\release.ps1 -NoTag patch   # commit+push only, tag separately

[CmdletBinding()]
param(
    [Parameter(Position = 0, Mandatory = $true)]
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

# PS 5.1 Set-Content -Encoding utf8 writes UTF-8 WITH BOM, which breaks TOML/JSON parsers.
# Use this instead everywhere we update files.
$_utf8NoBom = New-Object System.Text.UTF8Encoding($false)
function Write-Utf8NoBom([string]$path, [string]$content) {
    # Resolve through PS so relative paths honour Set-Location, not the .NET CWD.
    $absPath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($path)
    [System.IO.File]::WriteAllText($absPath, $content, $_utf8NoBom)
}

# ── detect current version ────────────────────────────────────────────────────

$pkgJson = Get-Content "packages\cnos\package.json" -Raw | ConvertFrom-Json
$OldVersion = $pkgJson.version
if (-not $OldVersion) { Die "Could not detect current version from packages/cnos/package.json" }

# ── resolve semantic bump ────────────────────────────────────────────────────

if ($NewVersion -in 'major', 'minor', 'patch') {
    $parts = $OldVersion -split '\.'
    $maj = [int]$parts[0]; $min = [int]$parts[1]; $pat = [int]$parts[2]
    $NewVersion = switch ($NewVersion.ToLower()) {
        'major' { "$($maj + 1).0.0" }
        'minor' { "$maj.$($min + 1).0" }
        'patch' { "$maj.$min.$($pat + 1)" }
    }
}

if ($NewVersion -notmatch '^\d+\.\d+\.\d+$') {
    Die "Version must be X.Y.Z or major|minor|patch (got: '$NewVersion')"
}

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
        Write-Utf8NoBom $_.FullName $content
    }
Info "Node.js OK"

# Python: version + intra-monorepo dep lower-bounds
Get-ChildItem -Path packages\python -Recurse -Filter pyproject.toml |
    ForEach-Object {
        $content = Get-Content $_.FullName -Raw
        $content = $content -replace [regex]::Escape("version = `"$OLD`""), "version = `"$NEW`""
        $content = $content -replace [regex]::Escape("kitsy-cnos>=$OLD"), "kitsy-cnos>=$NEW"
        $content = $content -replace [regex]::Escape("kitsy-cnos-gcp>=$OLD"), "kitsy-cnos-gcp>=$NEW"
        Write-Utf8NoBom $_.FullName $content
    }
Info "Python OK"

# Rust: crate Cargo.toml files only (depth >= 2, skip workspace root and target/)
Get-ChildItem -Path packages\rust -Recurse -Filter Cargo.toml |
    Where-Object { $_.FullName -notmatch '\\target\\' -and ($_.FullName -replace '\\','/' -split '/').Count -gt (($_.Directory.FullName -replace '\\','/' -split '/').Count - 1) } |
    Where-Object { $_.DirectoryName -ne (Resolve-Path packages\rust).Path } |
    ForEach-Object {
        $content = Get-Content $_.FullName -Raw
        $content = $content -replace [regex]::Escape("version = `"$OLD`""), "version = `"$NEW`""
        Write-Utf8NoBom $_.FullName $content
    }
Info "Rust OK"

# Java + Kotlin: <revision> in parent POMs only
foreach ($pom in @('packages\java\pom.xml', 'packages\kotlin\pom.xml')) {
    $content = Get-Content $pom -Raw
    $content = $content -replace [regex]::Escape("<revision>$OLD</revision>"), "<revision>$NEW</revision>"
    Write-Utf8NoBom $pom $content
}
Info "Java / Kotlin OK"

# C#: <Version> element and PackageReference Version= attribute
Get-ChildItem -Path packages\csharp -Recurse -Filter *.csproj |
    ForEach-Object {
        $content = Get-Content $_.FullName -Raw
        $content = $content -replace [regex]::Escape("<Version>$OLD</Version>"), "<Version>$NEW</Version>"
        $content = $content -replace [regex]::Escape("Version=`"$OLD`""), "Version=`"$NEW`""
        Write-Utf8NoBom $_.FullName $content
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

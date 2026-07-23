#Requires -Version 5.1

[CmdletBinding()]
param(
    [Parameter(Position = 0, Mandatory = $true)]
    [ValidateSet('node', 'go', 'java', 'kotlin', 'python', 'rust', 'csharp', 'php')]
    [string]$Ecosystem,

    [Parameter(Position = 1, Mandatory = $true)]
    [string]$NewVersion,

    [switch]$SkipTests
)

$arguments = @($Ecosystem, $NewVersion)
if ($SkipTests) {
    $arguments += '--skip-tests'
}

& node (Join-Path $PSScriptRoot 'release-part.mjs') @arguments
exit $LASTEXITCODE

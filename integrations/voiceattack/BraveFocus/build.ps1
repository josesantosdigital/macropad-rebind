$ErrorActionPreference = 'Stop'
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) { throw 'The Windows .NET Framework C# compiler was not found.' }
Push-Location $PSScriptRoot
try {
    & $compiler /nologo /optimize+ /target:library /platform:x64 /out:MacropadBraveFocus.dll BraveFocus.cs VoiceAttackPlugin.cs
    if ($LASTEXITCODE -ne 0) { throw 'Plugin build failed.' }
    & $compiler /nologo /optimize+ /target:winexe /out:BraveFocus.exe BraveFocus.cs
    if ($LASTEXITCODE -ne 0) { throw 'Standalone build failed.' }
    & $compiler /nologo /optimize+ /target:exe /out:BraveFocus-Diagnostic.exe BraveFocus.cs
    if ($LASTEXITCODE -ne 0) { throw 'Diagnostic build failed.' }
} finally { Pop-Location }

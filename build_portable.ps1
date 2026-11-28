param(
    [string]$PostgresRoot = (Join-Path $PSScriptRoot '..\MilitaryPlanner\postgres'),
    [string]$OutputPath = (Join-Path $PSScriptRoot 'portable\MilitaryPlanner'),
    [switch]$UseExistingFrontend
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = (Resolve-Path $PSScriptRoot).Path
$PostgresRoot = [System.IO.Path]::GetFullPath($PostgresRoot)
$OutputPath = [System.IO.Path]::GetFullPath($OutputPath)
$PortableOutputRoot = [System.IO.Path]::GetFullPath((Join-Path $ProjectRoot 'portable')).TrimEnd('\') + '\'
if (-not $OutputPath.StartsWith($PortableOutputRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "OutputPath must be inside $PortableOutputRoot"
}

$BundleMarker = Join-Path $OutputPath '.portable-bundle'
if ((Test-Path -LiteralPath $OutputPath) -and -not (Test-Path -LiteralPath $BundleMarker -PathType Leaf)) {
    throw "Refusing to replace an output directory without the build marker: $OutputPath"
}
$BuildId = [guid]::NewGuid().ToString('N')
$StagedBundle = $OutputPath + '.staging-' + $BuildId
$PreviousBundle = $OutputPath + '.previous-' + $BuildId

function Move-BundleDirectory {
    param([string]$Source, [string]$Destination)

    for ($Attempt = 1; $Attempt -le 8; $Attempt++) {
        try {
            [System.IO.Directory]::Move($Source, $Destination)
            return
        }
        catch {
            if ($Attempt -eq 8 -or (Test-Path -LiteralPath $Destination)) { throw }
            Start-Sleep -Milliseconds 500
        }
    }
}

$StageVerified = $false
$ReferenceFrontendRoot = Join-Path $ProjectRoot 'release'
$IconPath = Join-Path $ReferenceFrontendRoot 'icon.ico'
if (-not $UseExistingFrontend) {
    $BunCommand = Get-Command bun.exe -ErrorAction SilentlyContinue
    $BunExecutable = if ($BunCommand) { $BunCommand.Source }
    if (-not $BunExecutable) {
        $BunInstallRoots = @()
        if ($env:BUN_INSTALL) {
            $BunInstallRoots += $env:BUN_INSTALL
        }
        if ($env:USERPROFILE) {
            $BunInstallRoots += (Join-Path $env:USERPROFILE '.bun')
        }
        foreach ($BunInstallRoot in $BunInstallRoots) {
            $BunPath = Join-Path $BunInstallRoot 'bin\bun.exe'
            if (Test-Path $BunPath -PathType Leaf) {
                $BunExecutable = $BunPath
                break
            }
        }
    }
    if (-not $BunExecutable) {
        throw 'Bun is required to build the frontend from the bun.lock lockfile. Use -UseExistingFrontend only to package an existing release folder.'
    }

    $FrontendRoot = Join-Path $ProjectRoot 'frontend'
    Push-Location $FrontendRoot
    try {
        & $BunExecutable install --frozen-lockfile
        if ($LASTEXITCODE -ne 0) {
            throw "Bun dependency install failed with exit code $LASTEXITCODE."
        }

        & $BunExecutable run build
        if ($LASTEXITCODE -ne 0) {
            throw "Frontend build failed with exit code $LASTEXITCODE."
        }

        # Keep the portable bundle readable when diagnosing browser timeouts.
        & $BunExecutable run vite build --config vite.portable.config.ts --minify false
        if ($LASTEXITCODE -ne 0) {
            throw "Portable frontend build failed with exit code $LASTEXITCODE."
        }

        $PortableFrontendRoot = Join-Path $ProjectRoot 'build\frontend-portable'
        $PortableHtml = Join-Path $PortableFrontendRoot 'portable.html'
        if (-not (Test-Path $PortableHtml -PathType Leaf)) {
            throw "Portable frontend entry not found: $PortableHtml"
        }
        Move-Item -LiteralPath $PortableHtml -Destination (Join-Path $PortableFrontendRoot 'index.html')
    }
    finally {
        Pop-Location
    }
}

$FrontendRoot = if ($UseExistingFrontend) {
    $ReferenceFrontendRoot
} else {
    Join-Path $ProjectRoot 'build\frontend-portable'
}
if (-not (Test-Path (Join-Path $FrontendRoot 'index.html') -PathType Leaf)) {
    throw "Built frontend not found: $FrontendRoot."
}
if (-not (Test-Path $IconPath -PathType Leaf)) {
    throw "Application icon not found: $IconPath"
}
foreach ($RequiredPath in @(
    (Join-Path $PostgresRoot 'bin\initdb.exe'),
    (Join-Path $PostgresRoot 'bin\pg_ctl.exe'),
    (Join-Path $PostgresRoot 'bin\postgres.exe'),
    (Join-Path $PostgresRoot 'lib'),
    (Join-Path $PostgresRoot 'share'),
    (Join-Path $ProjectRoot 'backend\document-templates'),
    $IconPath
)) {
    if (-not (Test-Path $RequiredPath)) {
        throw "Required build component not found: $RequiredPath"
    }
}

$BuildRequirements = Join-Path $ProjectRoot 'requirements-build.txt'
python -m pip install -r $BuildRequirements
if ($LASTEXITCODE -ne 0) {
    throw 'Could not install Python build dependencies.'
}
python -c "import psycopg, docx, lxml"
if ($LASTEXITCODE -ne 0) {
    throw 'Install the backend runtime dependencies in this Python environment before building.'
}

$WorkRoot = Join-Path $ProjectRoot ('build\portable-' + [guid]::NewGuid().ToString('N'))
$PyInstallerOutput = Join-Path $WorkRoot 'dist'
$PyInstallerWork = Join-Path $WorkRoot 'work'
$SpecPath = Join-Path $WorkRoot 'spec'
New-Item -ItemType Directory -Force -Path $WorkRoot, $SpecPath | Out-Null

try {
    Push-Location $ProjectRoot
    try {
        python -m PyInstaller `
            --noconfirm `
            --clean `
            --onedir `
            --name MilitaryPlanner `
            --icon $IconPath `
            --distpath $PyInstallerOutput `
            --workpath $PyInstallerWork `
            --specpath $SpecPath `
            --collect-all psycopg `
            --collect-all docx `
            --add-data "$(Join-Path $ProjectRoot 'backend\document-templates');backend\document-templates" `
            launcher.py
        if ($LASTEXITCODE -ne 0) {
            throw "PyInstaller failed with exit code $LASTEXITCODE."
        }
    }
    finally {
        Pop-Location
    }

    $BuiltExecutable = Join-Path $PyInstallerOutput 'MilitaryPlanner\MilitaryPlanner.exe'
    if (-not (Test-Path $BuiltExecutable -PathType Leaf)) {
        throw "PyInstaller did not create the executable: $BuiltExecutable"
    }

    New-Item -ItemType Directory -Force -Path $StagedBundle | Out-Null
    Set-Content -LiteralPath (Join-Path $StagedBundle '.portable-bundle') -Value 'Generated by build_portable.ps1' -Encoding ASCII
    Copy-Item -Path (Join-Path (Split-Path $BuiltExecutable -Parent) '*') -Destination $StagedBundle -Recurse -Force
    $BundledFrontend = Join-Path $StagedBundle 'release'
    New-Item -ItemType Directory -Force -Path $BundledFrontend | Out-Null
    Copy-Item -Path (Join-Path $FrontendRoot '*') -Destination $BundledFrontend -Recurse -Force
    Copy-Item -LiteralPath $IconPath -Destination (Join-Path $BundledFrontend 'favicon.ico')
    $BundledPostgres = Join-Path $StagedBundle 'postgres'
    New-Item -ItemType Directory -Force -Path $BundledPostgres | Out-Null
    Copy-Item -Path (Join-Path $PostgresRoot 'bin') -Destination $BundledPostgres -Recurse -Force
    foreach ($Directory in @('lib', 'share')) {
        $Source = Join-Path $PostgresRoot $Directory
        if (Test-Path $Source -PathType Container) {
            Copy-Item -Path $Source -Destination $BundledPostgres -Recurse -Force
        }
    }
    $SeedDump = Join-Path $ProjectRoot '..\MilitaryPlanner\initial-data.dump'
    if (Test-Path $SeedDump -PathType Leaf) {
        Copy-Item -LiteralPath $SeedDump -Destination (Join-Path $StagedBundle 'initial-data.dump')
    }
    Copy-Item -LiteralPath $IconPath -Destination (Join-Path $StagedBundle 'icon.ico')
    Copy-Item -LiteralPath (Join-Path $ProjectRoot 'PORTABLE_BUILD.md') -Destination (Join-Path $StagedBundle 'PORTABLE_BUILD.md')

    $ReferenceLicenses = Join-Path (Split-Path $PostgresRoot -Parent) 'licenses'
    if (Test-Path $ReferenceLicenses -PathType Container) {
        Copy-Item -Path $ReferenceLicenses -Destination (Join-Path $StagedBundle 'licenses') -Recurse -Force
    }

    $ShortcutName = -join @(
        [char]0x041F, [char]0x043B, [char]0x0430, [char]0x043D, [char]0x0438,
        [char]0x0440, [char]0x043E, [char]0x0432, [char]0x0430, [char]0x043D,
        [char]0x0438, [char]0x0435, [char]0x0020, [char]0x0412, [char]0x0412,
        [char]0x0421, [char]0x0422
    )
    $ShortcutPath = Join-Path $StagedBundle ($ShortcutName + '.lnk')
    $Shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut($ShortcutPath)
    $Shortcut.TargetPath = Join-Path $OutputPath 'MilitaryPlanner.exe'
    $Shortcut.WorkingDirectory = $OutputPath
    $Shortcut.IconLocation = (Join-Path $OutputPath 'icon.ico') + ',0'
    $Shortcut.Save()

    $Executable = Join-Path $StagedBundle 'MilitaryPlanner.exe'
    $PostgresBinary = Join-Path $StagedBundle 'postgres\bin\postgres.exe'
    $PostgresControl = Join-Path $StagedBundle 'postgres\bin\pg_ctl.exe'
    if (-not ((Test-Path $Executable -PathType Leaf) -and (Test-Path $PostgresBinary -PathType Leaf) -and (Test-Path $PostgresControl -PathType Leaf) -and (Test-Path $ShortcutPath -PathType Leaf))) {
        throw 'Portable bundle verification failed.'
    }

    $StageVerified = $true

    if (Test-Path -LiteralPath $OutputPath) {
        if (-not (Test-Path -LiteralPath $BundleMarker -PathType Leaf)) {
            throw "Refusing to replace an output directory without the build marker: $OutputPath"
        }
        try {
            Move-BundleDirectory -Source $OutputPath -Destination $PreviousBundle
        }
        catch {
            $StopExe = Join-Path $OutputPath 'MilitaryPlanner.exe'
            throw "Could not replace $OutputPath. Stop this copy with & '$StopExe' --stop, or build to another -OutputPath. $($_.Exception.Message)"
        }
    }
    try {
        Move-BundleDirectory -Source $StagedBundle -Destination $OutputPath
    }
    catch {
        $PublishError = $_
        if (Test-Path -LiteralPath $PreviousBundle) {
            try {
                Move-BundleDirectory -Source $PreviousBundle -Destination $OutputPath
            }
            catch {
                Write-Warning "Could not restore the previous bundle. It is at $PreviousBundle."
            }
        }
        throw $PublishError
    }

    if (Test-Path -LiteralPath $PreviousBundle) {
        try {
            Remove-Item -LiteralPath $PreviousBundle -Recurse -Force
        }
        catch {
            Write-Warning "The new bundle is ready. Remove the old bundle at $PreviousBundle after its processes stop."
        }
    }

    $Executable = Join-Path $OutputPath 'MilitaryPlanner.exe'
    Write-Host "Portable bundle created: $OutputPath"
    Write-Host "Start: $Executable"
    Write-Host "Stop: `"$Executable`" --stop"
}
finally {
    if (Test-Path -LiteralPath $StagedBundle) {
        if ($StageVerified) {
            Write-Warning "The verified bundle is still at $StagedBundle. Stop the previous copy before running MilitaryPlanner.exe from that directory. Its shortcut targets $OutputPath."
        }
        else {
            Remove-Item -LiteralPath $StagedBundle -Recurse -Force -ErrorAction Continue
        }
    }
    if (Test-Path $WorkRoot) {
        Remove-Item -LiteralPath $WorkRoot -Recurse -Force
    }

    $BundleLeaf = Split-Path -Leaf $OutputPath
    Get-ChildItem -LiteralPath $PortableOutputRoot -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -like "$BundleLeaf.staging-*" -or $_.Name -like "$BundleLeaf.previous-*" } |
        ForEach-Object {
            if ($StageVerified -and $_.FullName -eq $StagedBundle) {
                Write-Warning "Keeping verified bundle at $StagedBundle because it could not be published."
                return
            }
            try {
                Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction Stop
            }
            catch {
                Write-Warning "Could not remove leftover bundle folder $($_.FullName): $($_.Exception.Message)"
            }
        }
}

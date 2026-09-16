param(
  [Parameter(Mandatory = $true)]
  [string]$Request
)

$ErrorActionPreference = 'Stop'

try {
  $json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Request))
  $spec = $json | ConvertFrom-Json
  $projectRoot = Split-Path -Parent $PSScriptRoot
  $source = Join-Path $projectRoot 'native\windows-sandbox\HarnessSandbox.cs'
  if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
    throw "Windows sandbox source is missing: $source"
  }

  # 编译产物由控制器进程加载，所以它绝不能落在受限进程能写的地方（沙箱授权根目录或
  # 私有临时目录）。那种情况下宁可每次在内存里编译，也不留一个能被替换掉的 DLL。
  $cachedAssembly = $null
  $cacheDir = [string]$spec.cacheDir
  if ($cacheDir) {
    $cacheDir = [IO.Path]::GetFullPath($cacheDir)
    $grantedRoots = @()
    if ($spec.tempDir) { $grantedRoots += [IO.Path]::GetFullPath([string]$spec.tempDir) }
    foreach ($root in @($spec.writableRoots)) {
      if ($root) { $grantedRoots += [IO.Path]::GetFullPath([string]$root) }
    }
    $insideGranted = $false
    foreach ($root in $grantedRoots) {
      $trimmed = $root.TrimEnd('\')
      if ($cacheDir -eq $trimmed -or $cacheDir.StartsWith($trimmed + '\', [StringComparison]::OrdinalIgnoreCase)) {
        $insideGranted = $true
        break
      }
    }
    if ($insideGranted) {
      [Console]::Error.WriteLine('Windows sandbox: engine cache dir is inside the sandbox writable scope; compiling in memory instead.')
    }
    else {
      $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $source).Hash.Substring(0, 16).ToLowerInvariant()
      $cachedAssembly = Join-Path $cacheDir "HarnessSandbox-$hash.dll"
    }
  }

  $typeReady = [bool]('MiniHarness.NativeSandbox.Runner' -as [type])

  # 先试磁盘缓存；缓存坏了（编译中断、被杀毒软件动过）不能让所有命令一起挂掉，
  # 掉回内存编译，把这个问题降级成“慢一点”。
  if (-not $typeReady -and $cachedAssembly) {
    try {
      if (-not (Test-Path -LiteralPath $cachedAssembly -PathType Leaf)) {
        # Windows PowerShell ships with Windows. Compile the tiny native bridge once and
        # cache it in a directory the sandbox cannot write: no SDK, package manager, or download.
        New-Item -ItemType Directory -Force -Path $cacheDir | Out-Null
        $mutexName = "Local\MiniHarnessSandboxCompile-$hash"
        $mutex = New-Object Threading.Mutex($false, $mutexName)
        try {
          if (-not $mutex.WaitOne([TimeSpan]::FromSeconds(30))) {
            throw 'Timed out waiting for the Windows sandbox compiler lock.'
          }
          if (-not (Test-Path -LiteralPath $cachedAssembly -PathType Leaf)) {
            Add-Type -Path $source -OutputAssembly $cachedAssembly -ErrorAction Stop
          }
        }
        finally {
          try { $mutex.ReleaseMutex() } catch { }
          $mutex.Dispose()
        }
      }
      Add-Type -Path $cachedAssembly -ErrorAction Stop
      $typeReady = $true
    }
    catch {
      [Console]::Error.WriteLine("Windows sandbox: disk cache unusable, falling back to in-memory compile: $($_.Exception.Message)")
      try { Remove-Item -LiteralPath $cachedAssembly -Force -ErrorAction Stop } catch { }
      $typeReady = $false
    }
  }

  if (-not $typeReady) {
    Add-Type -Path $source -ErrorAction Stop
  }
  $roots = @($spec.writableRoots | ForEach-Object { [string]$_ })
  $exitCode = [MiniHarness.NativeSandbox.Runner]::Run(
    [string]$spec.command,
    [string]$spec.capabilityKey,
    [string]$spec.cwd,
    [string[]]$roots,
    [string]$spec.tempDir,
    [int]$spec.pidsLimit,
    [long]$spec.memoryLimitBytes,
    [int]$spec.cpuRate
  )
  exit $exitCode
}
catch {
  $errorToReport = $_.Exception
  while ($null -ne $errorToReport.InnerException) { $errorToReport = $errorToReport.InnerException }
  [Console]::Error.WriteLine("Windows sandbox failed closed: $($errorToReport.Message)")
  exit 126
}

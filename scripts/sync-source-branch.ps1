[CmdletBinding()]
param(
	[Parameter()]
	[ValidateNotNullOrEmpty()]
	[string]$SourceBranch = 'main'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# This script always operates on the repository's real index. A stale override
# makes tracked files appear untracked and produces false overwrite warnings.
if (Test-Path Env:GIT_INDEX_FILE) {
	$indexOverride = $env:GIT_INDEX_FILE
	$displayIndexOverride = if ([string]::IsNullOrWhiteSpace($indexOverride)) { '<empty>' } else { $indexOverride }
	Write-Warning "Ignoring GIT_INDEX_FILE override '$displayIndexOverride'."
	Remove-Item Env:GIT_INDEX_FILE -ErrorAction SilentlyContinue
}

function Invoke-GitCommand {
	param(
		[Parameter(Mandatory = $true)]
		[string[]]$Arguments,

		[switch]$SuppressOutput
	)

	$previousErrorActionPreference = $ErrorActionPreference
	$ErrorActionPreference = 'Continue'
	try {
		$commandOutput = @(& git @Arguments 2>&1)
		$exitCode = $LASTEXITCODE
	} finally {
		$ErrorActionPreference = $previousErrorActionPreference
	}

	if (-not $SuppressOutput) {
		foreach ($line in $commandOutput) {
			Write-Host $line
		}
	}

	return [PSCustomObject]@{
		ExitCode = $exitCode
		Output = [string[]]$commandOutput
	}
}

function Test-PathOverlap {
	param(
		[Parameter(Mandatory = $true)]
		[string]$FirstPath,

		[Parameter(Mandatory = $true)]
		[string]$SecondPath
	)

	return $FirstPath -ieq $SecondPath `
		-or $FirstPath.StartsWith("$SecondPath/", [System.StringComparison]::OrdinalIgnoreCase) `
		-or $SecondPath.StartsWith("$FirstPath/", [System.StringComparison]::OrdinalIgnoreCase)
}

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
	Write-Error 'Git is not installed or is not available on PATH.'
	exit 1
}

$repositoryResult = Invoke-GitCommand -Arguments @('rev-parse', '--show-toplevel') -SuppressOutput
if ($repositoryResult.ExitCode -ne 0) {
	Write-Error 'The current directory is not inside a Git repository.'
	exit 1
}
$repositoryRoot = $repositoryResult.Output[0].Trim()

$branchResult = Invoke-GitCommand -Arguments @('symbolic-ref', '--quiet', '--short', 'HEAD') -SuppressOutput
if ($branchResult.ExitCode -ne 0) {
	Write-Error 'The repository is in a detached HEAD state. Check out a local branch before running this script.'
	exit 1
}

$currentBranch = $branchResult.Output[0].Trim()
$branchNameResult = Invoke-GitCommand -Arguments @('check-ref-format', '--branch', $SourceBranch) -SuppressOutput
if ($branchNameResult.ExitCode -ne 0) {
	Write-Error "'$SourceBranch' is not a valid Git branch name."
	exit 1
}

$remoteResult = Invoke-GitCommand -Arguments @('remote', 'get-url', 'origin') -SuppressOutput
if ($remoteResult.ExitCode -ne 0) {
	Write-Error "Remote 'origin' does not exist. Add it before running this script."
	exit 1
}

Write-Host "Fetching the latest '$SourceBranch' branch from 'origin'..."
$remoteRef = "refs/remotes/origin/$SourceBranch"
$refSpec = "+refs/heads/${SourceBranch}:$remoteRef"
$fetchResult = Invoke-GitCommand -Arguments @('fetch', 'origin', $refSpec)
if ($fetchResult.ExitCode -ne 0) {
	Write-Error "Could not fetch branch '$SourceBranch' from 'origin'."
	exit $fetchResult.ExitCode
}

$ancestorResult = Invoke-GitCommand -Arguments @('merge-base', '--is-ancestor', $remoteRef, 'HEAD') -SuppressOutput
if ($ancestorResult.ExitCode -eq 0) {
	Write-Host "'$currentBranch' is already up to date with 'origin/$SourceBranch'."
	exit 0
}

if ($ancestorResult.ExitCode -ne 1) {
	Write-Error "Could not compare '$currentBranch' with 'origin/$SourceBranch'."
	exit $ancestorResult.ExitCode
}

$commitCountResult = Invoke-GitCommand -Arguments @('rev-list', '--count', "HEAD..$remoteRef") -SuppressOutput
if ($commitCountResult.ExitCode -eq 0) {
	$commitCount = $commitCountResult.Output[0].Trim()
	Write-Host "'$currentBranch' needs $commitCount commit(s) from 'origin/$SourceBranch'. Testing the committed branch merge..."
} else {
	Write-Host "'$currentBranch' is not up to date with 'origin/$SourceBranch'. Testing the committed branch merge..."
}

# First test only committed branch history. This does not read or change the
# working tree or index.
$branchDryRunResult = Invoke-GitCommand -Arguments @('--no-pager', 'merge-tree', '--write-tree', '--messages', '--name-only', 'HEAD', $remoteRef) -SuppressOutput
if ($branchDryRunResult.ExitCode -eq 1) {
	Write-Warning "The committed changes on '$currentBranch' conflict with 'origin/$SourceBranch'. No changes were made."
	foreach ($line in $branchDryRunResult.Output) {
		Write-Host $line
	}
	exit 1
}

if ($branchDryRunResult.ExitCode -ne 0 -or $branchDryRunResult.Output.Count -eq 0) {
	foreach ($line in $branchDryRunResult.Output) {
		Write-Host $line
	}
	Write-Error 'Git could not complete the committed branch merge test. No changes were made.'
	exit 1
}

$mergedTree = $branchDryRunResult.Output[0].Trim()
$incomingPathsResult = Invoke-GitCommand -Arguments @('diff', '--name-only', '--no-renames', 'HEAD', $mergedTree) -SuppressOutput
$localTrackedPathsResult = Invoke-GitCommand -Arguments @('diff', '--name-only', '--no-renames', 'HEAD', '--') -SuppressOutput
$localUntrackedPathsResult = Invoke-GitCommand -Arguments @('ls-files', '--others', '--exclude-standard') -SuppressOutput
if ($incomingPathsResult.ExitCode -ne 0 -or $localTrackedPathsResult.ExitCode -ne 0 -or $localUntrackedPathsResult.ExitCode -ne 0) {
	Write-Error 'Could not compare incoming paths with uncommitted local paths. No changes were made.'
	exit 1
}

$localTrackedPaths = @($localTrackedPathsResult.Output)
$localUntrackedPaths = @($localUntrackedPathsResult.Output)
$overlappingTrackedPaths = @()
foreach ($localPath in $localTrackedPaths) {
	foreach ($incomingPath in $incomingPathsResult.Output) {
		if (Test-PathOverlap -FirstPath $localPath -SecondPath $incomingPath) {
			$overlappingTrackedPaths += $localPath
			break
		}
	}
}
$overlappingTrackedPaths = @($overlappingTrackedPaths | Sort-Object -Unique)

$overlappingUntrackedPaths = @()
foreach ($localPath in $localUntrackedPaths) {
	foreach ($incomingPath in $incomingPathsResult.Output) {
		if (Test-PathOverlap -FirstPath $localPath -SecondPath $incomingPath) {
			$overlappingUntrackedPaths += $localPath
			break
		}
	}
}
$overlappingUntrackedPaths = @($overlappingUntrackedPaths | Sort-Object -Unique)

if ($overlappingUntrackedPaths.Count -gt 0) {
	Write-Warning "These untracked local paths would be overwritten by 'origin/$SourceBranch'. No changes were made:"
	foreach ($path in $overlappingUntrackedPaths) {
		Write-Host "  $path"
	}
	exit 1
}

if ($overlappingTrackedPaths.Count -gt 0) {
	Write-Host 'Some locally modified files also changed upstream. Testing their content for conflicts...'
	$temporaryIndexPath = Join-Path ([System.IO.Path]::GetTempPath()) "sync-source-branch-$PID-$([guid]::NewGuid().ToString('N')).index"
	$previousIndexExists = Test-Path Env:GIT_INDEX_FILE
	$previousIndexPath = if ($previousIndexExists) { $env:GIT_INDEX_FILE } else { $null }
	$localTreeResult = $null
	$snapshotFailure = $null

	try {
		$env:GIT_INDEX_FILE = $temporaryIndexPath
		$readTreeResult = Invoke-GitCommand -Arguments @('read-tree', 'HEAD') -SuppressOutput
		if ($readTreeResult.ExitCode -ne 0) {
			$snapshotFailure = $readTreeResult
		} else {
			$addArguments = @('-C', $repositoryRoot, 'add', '--all', '--') + $localTrackedPaths
			$addResult = Invoke-GitCommand -Arguments $addArguments -SuppressOutput
			if ($addResult.ExitCode -ne 0) {
				$snapshotFailure = $addResult
			} else {
				$localTreeResult = Invoke-GitCommand -Arguments @('write-tree') -SuppressOutput
				if ($localTreeResult.ExitCode -ne 0) {
					$snapshotFailure = $localTreeResult
				}
			}
		}
	} finally {
		if ($previousIndexExists) {
			$env:GIT_INDEX_FILE = $previousIndexPath
		} else {
			Remove-Item Env:GIT_INDEX_FILE -ErrorAction SilentlyContinue
		}
		if ([System.IO.File]::Exists($temporaryIndexPath)) {
			[System.IO.File]::Delete($temporaryIndexPath)
		}
	}

	if ($null -ne $snapshotFailure) {
		Write-Error 'Could not create a temporary snapshot of the locally modified files. No changes were made.'
		exit $snapshotFailure.ExitCode
	}

	$localTree = $localTreeResult.Output[0].Trim()
	$localDryRunResult = Invoke-GitCommand -Arguments @('--no-pager', 'merge-tree', '--write-tree', '--messages', '--name-only', '--merge-base=HEAD', $mergedTree, $localTree) -SuppressOutput
	if ($localDryRunResult.ExitCode -eq 1) {
		$conflictingTrackedPaths = @($overlappingTrackedPaths | Where-Object { $localDryRunResult.Output -contains $_ })
		if ($conflictingTrackedPaths.Count -eq 0) {
			$conflictingTrackedPaths = $overlappingTrackedPaths
		}
		Write-Warning "These locally modified files have content conflicts with 'origin/$SourceBranch'. No changes were made:"
		foreach ($path in $conflictingTrackedPaths) {
			Write-Host "  $path"
		}
		exit 1
	}

	if ($localDryRunResult.ExitCode -ne 0) {
		Write-Error 'Git could not test the locally modified files for conflicts. No changes were made.'
		exit $localDryRunResult.ExitCode
	}

	Write-Host 'The locally modified files can be applied without content conflicts.'
} elseif ($localTrackedPaths.Count + $localUntrackedPaths.Count -gt 0) {
	Write-Host 'The uncommitted local files are not changed upstream and will be left untouched.'
}

$stagedChangesResult = Invoke-GitCommand -Arguments @('diff', '--cached', '--quiet', 'HEAD', '--') -SuppressOutput
if ($stagedChangesResult.ExitCode -eq 0) {
	$hasStagedChanges = $false
} elseif ($stagedChangesResult.ExitCode -eq 1) {
	$hasStagedChanges = $true
} else {
	Write-Error 'Could not inspect staged local changes. No merge was attempted.'
	exit $stagedChangesResult.ExitCode
}

$shouldStashTrackedChanges = $hasStagedChanges -or $overlappingTrackedPaths.Count -gt 0
$stashCommit = $null
if ($shouldStashTrackedChanges) {
	Write-Host 'Temporarily saving tracked local changes before the merge...'
	$stashResult = Invoke-GitCommand -Arguments @('stash', 'push', '--message', 'sync-source-branch.ps1 automatic backup')
	if ($stashResult.ExitCode -ne 0) {
		Write-Error 'Could not save the staged local changes. No merge was attempted.'
		exit $stashResult.ExitCode
	}

	$stashCommitResult = Invoke-GitCommand -Arguments @('rev-parse', '--verify', 'refs/stash') -SuppressOutput
	if ($stashCommitResult.ExitCode -ne 0) {
		Write-Error 'Git did not create the expected backup stash. No merge was attempted.'
		exit 1
	}
	$stashCommit = $stashCommitResult.Output[0].Trim()
}

Write-Host "Merging 'origin/$SourceBranch' into '$currentBranch'..."
$mergeResult = Invoke-GitCommand -Arguments @('merge', '--no-edit', $remoteRef)
if ($mergeResult.ExitCode -ne 0) {
	$mergeHeadResult = Invoke-GitCommand -Arguments @('rev-parse', '--quiet', '--verify', 'MERGE_HEAD') -SuppressOutput
	if ($mergeHeadResult.ExitCode -eq 0) {
		Write-Warning 'The merge failed unexpectedly. Aborting it to restore the branch.'
		[void](Invoke-GitCommand -Arguments @('merge', '--abort'))
	}

	if ($shouldStashTrackedChanges) {
		$restoreResult = Invoke-GitCommand -Arguments @('stash', 'pop', '--index')
		if ($restoreResult.ExitCode -ne 0) {
			Write-Warning "The local changes remain available in stash commit $stashCommit."
		}
	}

	Write-Error "Failed to merge 'origin/$SourceBranch' into '$currentBranch'."
	exit $mergeResult.ExitCode
}

if ($shouldStashTrackedChanges) {
	Write-Host 'Restoring the tracked local changes...'
	$restoreResult = Invoke-GitCommand -Arguments @('stash', 'pop', '--index')
	if ($restoreResult.ExitCode -ne 0) {
		Write-Error "The merge completed, but the local changes could not be restored automatically. They remain available in stash commit $stashCommit."
		exit $restoreResult.ExitCode
	}
}

Write-Host "Successfully merged 'origin/$SourceBranch' into '$currentBranch'."

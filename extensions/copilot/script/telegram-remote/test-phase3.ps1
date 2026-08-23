# Copyright (c) 2026 Sachith H. Liyanagama, Emagin8 UG. All rights reserved.
# Licensed under the MIT License. See License.txt in the project root for license information.

[CmdletBinding()]
param(
	[switch]$SkipTypecheck
)

$ErrorActionPreference = 'Stop'
$extensionRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))

function Assert-LastExitCode {
	param([string]$Operation)

	if ($LASTEXITCODE -ne 0) {
		throw "$Operation failed with exit code $LASTEXITCODE."
	}
}

Push-Location $extensionRoot
try {
	if (-not $SkipTypecheck) {
		& npx tsc --noEmit --project tsconfig.json --pretty false
		Assert-LastExitCode 'TypeScript validation'
	}

	$testFiles = @(
		'src/extension/telegramRemote/node/test/telegramBotClient.spec.ts',
		'src/extension/telegramRemote/node/test/telegramPollerLease.spec.ts',
		'src/extension/telegramRemote/node/test/telegramService.spec.ts',
		'src/extension/telegramRemote/node/test/telegramAuthorization.spec.ts',
		'src/extension/telegramRemote/node/test/telegramPairingService.spec.ts',
		'src/extension/telegramRemote/node/test/telegramCallbackRegistry.spec.ts',
		'src/extension/telegramRemote/vscode-node/test/telegramRemoteContribution.spec.ts',
		'src/extension/telegramRemote/common/test/telegramRemoteCompatibility.spec.ts'
	)
	& npx vitest --run --pool=forks @testFiles
	Assert-LastExitCode 'Phase 3 Vitest suite'
} finally {
	Pop-Location
}

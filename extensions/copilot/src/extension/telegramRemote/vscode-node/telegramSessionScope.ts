/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Sachith H. Liyanagama, Emagin8 UG. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'node:crypto';
import { extUriBiasedIgnorePathCase } from '../../../util/vs/base/common/resources';
import { URI } from '../../../util/vs/base/common/uri';
import type { TelegramAuthorizedSessionScope, TelegramSessionScopeCandidate, TelegramSessionScopePolicy } from '../common/telegramSessionScope';
import { getTelegramRemoteEnvironment, type TelegramRemoteEnvironment } from './telegramRemoteEnvironment';

/** Restricts Telegram to session working directories inside the exact currently consented workspace roots. */
export class CurrentWorkspaceTelegramSessionScopePolicy implements TelegramSessionScopePolicy {
	constructor(
		private readonly consentScopeFingerprint: string,
		private readonly getEnvironment: () => TelegramRemoteEnvironment = getTelegramRemoteEnvironment,
	) { }

	authorizeSession(session: TelegramSessionScopeCandidate): TelegramAuthorizedSessionScope | undefined {
		const environment = this.getEnvironment();
		const workingDirectory = session.workingDirectory;
		if (environment.consentScopeFingerprint !== this.consentScopeFingerprint || !workingDirectory || environment.workspaceRoots.length === 0) {
			return undefined;
		}

		const sessionUri = URI.parse(workingDirectory.toString());
		const authorized = environment.workspaceRoots.some(root =>
			extUriBiasedIgnorePathCase.isEqualOrParent(sessionUri, URI.parse(root.toString()), true));
		if (!authorized) {
			return undefined;
		}

		const normalizedWorkingDirectory = extUriBiasedIgnorePathCase.getComparisonKey(sessionUri, true);
		return {
			fingerprint: createHash('sha256')
				.update(JSON.stringify({ consentScopeFingerprint: this.consentScopeFingerprint, workingDirectory: normalizedWorkingDirectory }))
				.digest('hex')
				.slice(0, 24),
			workingDirectoryLabel: workingDirectory.fsPath || workingDirectory.toString(),
		};
	}
}

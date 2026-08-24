/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Sachith H. Liyanagama, Emagin8 UG. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export type ActivityRoundType =
	| 'reasoning'
	| 'progress'
	| 'answer'
	| 'search'
	| 'read'
	| 'edit'
	| 'command'
	| 'permission'
	| 'question'
	| 'subagent'
	| 'other';

export type ActivityRoundStatus = 'running' | 'completed' | 'failed' | 'waiting';

export interface ActivityRoundDetail {
	readonly label?: string;
	readonly value: string;
	readonly format?: 'text' | 'code' | 'list';
	readonly language?: string;
	/** Compact renders `summary`; detailed/debug additionally render `detailed`. */
	readonly visibility?: 'summary' | 'detailed';
}

/** Transport-neutral semantic unit emitted by the remote agent timeline. */
export interface ActivityRound {
	readonly id: string;
	readonly sessionId: string;
	readonly requestId?: string;
	readonly toolCallId?: string;
	readonly type: ActivityRoundType;
	readonly summary: string;
	readonly status: ActivityRoundStatus;
	readonly details?: readonly ActivityRoundDetail[];
	readonly steerable: boolean;
	readonly startedAt?: number;
	readonly completedAt?: number;
}

export interface ActivityRoundMutation {
	readonly round: ActivityRound;
	readonly isNew: boolean;
}

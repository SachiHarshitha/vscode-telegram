/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Sachith H. Liyanagama, Emagin8 UG. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomInt } from 'node:crypto';
import { ILogService } from '../../../platform/log/common/logService';
import { Disposable, IDisposable } from '../../../util/vs/base/common/lifecycle';
import type { TelegramInputRichMessage, TelegramMessageGenerationStopped, TelegramSendRichMessageDraftOptions } from '../common/telegramTypes';
import { escapeTelegramHtml } from './telegramMarkdown';

export const telegramDraftHeartbeatMs = 10_000;
const minimumSemanticUpdateIntervalMs = 1_000;
const maximumDraftId = 0x7fffffff;

export interface ActiveDraft {
	chatId: number;
	threadId?: number;
	draftId: number;
	runId: string;
	status: string;
	canStop: boolean;
	active: boolean;
	lastRefresh: number;
}

export interface TelegramActivityDraftHost {
	sendRichMessageDraft(chatId: number, draftId: number, richMessage: TelegramInputRichMessage, options?: TelegramSendRichMessageDraftOptions): Promise<true>;
}

export interface TelegramActivityDraftScheduler {
	now(): number;
	schedule(callback: () => Promise<void>, delayMs: number): IDisposable;
}

/** Owns one ephemeral Bot API live draft and its bounded refresh lifecycle. */
export class TelegramActivityDraftController extends Disposable {
	readonly draft: ActiveDraft;
	private heartbeatTimer: IDisposable | undefined;
	private semanticUpdateTimer: IDisposable | undefined;
	private refreshQueue = Promise.resolve();

	constructor(
		private readonly host: TelegramActivityDraftHost,
		private readonly scheduler: TelegramActivityDraftScheduler,
		chatId: number,
		threadId: number | undefined,
		runId: string,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this.draft = {
			chatId,
			threadId,
			draftId: randomInt(1, maximumDraftId),
			runId,
			status: '',
			canStop: true,
			active: false,
			lastRefresh: 0,
		};
	}

	async start(status: string): Promise<void> {
		if (this.draft.active) {
			await this.update(status);
			return;
		}
		this.draft.active = true;
		this.draft.status = status;
		this.draft.canStop = true;
		await this.enqueueRefresh();
	}

	async update(status: string): Promise<void> {
		if (!this.draft.active || !status) {
			return;
		}
		const changed = this.draft.status !== status;
		this.draft.status = status;
		if (!changed) {
			return;
		}
		const delay = Math.max(0, this.draft.lastRefresh + minimumSemanticUpdateIntervalMs - this.scheduler.now());
		if (delay === 0) {
			await this.enqueueRefresh();
			return;
		}
		this.semanticUpdateTimer?.dispose();
		this.semanticUpdateTimer = this.scheduler.schedule(async () => {
			this.semanticUpdateTimer = undefined;
			await this.enqueueRefresh();
		}, delay);
	}

	async updateImmediately(status: string, canStop = this.draft.canStop): Promise<void> {
		if (!this.draft.active || !status) {
			return;
		}
		const changed = this.draft.status !== status || this.draft.canStop !== canStop;
		this.draft.status = status;
		this.draft.canStop = canStop;
		this.semanticUpdateTimer?.dispose();
		this.semanticUpdateTimer = undefined;
		if (changed) {
			await this.enqueueRefresh();
		}
	}

	refreshImmediately(): Promise<void> {
		if (!this.draft.active) {
			return Promise.resolve();
		}
		this.semanticUpdateTimer?.dispose();
		this.semanticUpdateTimer = undefined;
		return this.enqueueRefresh();
	}

	matches(stopped: TelegramMessageGenerationStopped): boolean {
		return this.draft.active
			&& stopped.chat.id === this.draft.chatId
			&& stopped.message_thread_id === this.draft.threadId
			&& stopped.draft_id === this.draft.draftId;
	}

	stop(): void {
		this.draft.active = false;
		this.heartbeatTimer?.dispose();
		this.heartbeatTimer = undefined;
		this.semanticUpdateTimer?.dispose();
		this.semanticUpdateTimer = undefined;
	}

	private enqueueRefresh(): Promise<void> {
		const result = this.refreshQueue.then(() => this.sendCurrentDraft());
		this.refreshQueue = result.catch(() => { });
		return result;
	}

	private async sendCurrentDraft(): Promise<void> {
		if (!this.draft.active) {
			return;
		}
		try {
			await this.host.sendRichMessageDraft(this.draft.chatId, this.draft.draftId, renderDraft(this.draft.status), {
				messageThreadId: this.draft.threadId,
				canStop: this.draft.canStop,
				keepOnStop: true,
			});
			this.draft.lastRefresh = this.scheduler.now();
		} catch {
			this.logService.warn('[TelegramRemote] Live activity draft refresh failed; details were suppressed.');
		} finally {
			this.scheduleHeartbeat();
		}
	}

	private scheduleHeartbeat(): void {
		this.heartbeatTimer?.dispose();
		this.heartbeatTimer = undefined;
		if (!this.draft.active) {
			return;
		}
		this.heartbeatTimer = this.scheduler.schedule(async () => {
			this.heartbeatTimer = undefined;
			await this.enqueueRefresh();
		}, telegramDraftHeartbeatMs);
	}

	public override dispose(): void {
		this.stop();
		super.dispose();
	}
}

function renderDraft(status: string): TelegramInputRichMessage {
	return { html: `<tg-thinking>${escapeTelegramHtml(status)}</tg-thinking>` };
}

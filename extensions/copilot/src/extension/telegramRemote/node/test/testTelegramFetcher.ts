/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Sachith H. Liyanagama, Emagin8 UG. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { FetchOptions, HeadersImpl, IFetcherService, Response } from '../../../../platform/networking/common/fetcherService';
import { mock } from '../../../../util/common/test/simpleMock';

/** IFetcherService test adapter that preserves the production client's HTTP boundary. */
export class TestTelegramFetcher extends mock<IFetcherService>() {
	override async fetch(url: string, options: FetchOptions): Promise<Response> {
		const controller = new AbortController();
		const onAbort = () => controller.abort();
		options.signal?.addEventListener('abort', onAbort);
		const timeout = options.timeout ? setTimeout(() => controller.abort(), options.timeout) : undefined;
		try {
			const nativeResponse = await globalThis.fetch(url, {
				method: options.method,
				headers: { 'content-type': 'application/json', ...options.headers },
				body: options.json === undefined ? options.body : JSON.stringify(options.json),
				signal: controller.signal,
			});
			return Response.fromText(nativeResponse.status, nativeResponse.statusText, new HeadersImpl(Object.fromEntries(nativeResponse.headers.entries())), await nativeResponse.text(), 'test-stub');
		} finally {
			if (timeout) {
				clearTimeout(timeout);
			}
			options.signal?.removeEventListener('abort', onAbort);
		}
	}

	override makeAbortController(): AbortController {
		return new AbortController();
	}

	override isAbortError(error: unknown): boolean {
		return !!error && typeof error === 'object' && 'name' in error && error.name === 'AbortError';
	}
}

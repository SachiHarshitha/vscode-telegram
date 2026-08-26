/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Sachith H. Liyanagama, Emagin8 UG. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { FileType } from '../../../platform/filesystem/common/fileTypes';
import { IFileSystemService } from '../../../platform/filesystem/common/fileSystemService';
import { URI } from '../../../util/vs/base/common/uri';
import type { TelegramWorkspaceDirectory, TelegramWorkspaceFileBrowser, TelegramWorkspaceFileContent, TelegramWorkspaceFileEntry } from '../common/telegramFileBrowser';

const maximumRelativePathLength = 768;
const maximumDirectoryEntries = 500;
const maximumFileBytes = 32_000;

/** Read-only VS Code filesystem adapter behind Telegram's abstract file browser seam. */
export class TelegramWorkspaceFileBrowserImpl implements TelegramWorkspaceFileBrowser {
	constructor(
		@IFileSystemService private readonly fileSystemService: IFileSystemService,
	) { }

	async listDirectory(workspaceRoot: string, relativePath: string): Promise<TelegramWorkspaceDirectory> {
		const normalizedPath = normalizeRelativePath(relativePath, true);
		const directory = resolveWorkspaceResource(workspaceRoot, normalizedPath);
		const rawEntries = await this.fileSystemService.readDirectory(directory);
		const entries: TelegramWorkspaceFileEntry[] = rawEntries
			.filter((entry): entry is [string, FileType.File | FileType.Directory] => entry[1] === FileType.File || entry[1] === FileType.Directory)
			.map(([name, type]) => {
				const id = appendRelativePath(normalizedPath, name);
				return { id, label: name, kind: type === FileType.Directory ? 'directory' as const : 'file' as const };
			})
			.sort((left, right) => left.kind === right.kind ? left.label.localeCompare(right.label) : left.kind === 'directory' ? -1 : 1)
			.slice(0, maximumDirectoryEntries);
		return { relativePath: normalizedPath, entries };
	}

	async readFile(workspaceRoot: string, relativePath: string): Promise<TelegramWorkspaceFileContent> {
		const normalizedPath = normalizeRelativePath(relativePath, false);
		const resource = resolveWorkspaceResource(workspaceRoot, normalizedPath);
		const bytes = await this.fileSystemService.readFile(resource);
		const bounded = truncateUtf8Prefix(bytes, maximumFileBytes);
		if (bounded.some(value => value === 0)) {
			throw new Error('Binary workspace files cannot be displayed in Telegram.');
		}
		let text: string;
		try {
			text = new TextDecoder('utf-8', { fatal: true }).decode(bounded);
		} catch {
			throw new Error('Binary workspace files cannot be displayed in Telegram.');
		}
		if ([...text].some(character => {
			const codePoint = character.codePointAt(0);
			return codePoint !== undefined
				&& ((codePoint < 0x20 && codePoint !== 0x09 && codePoint !== 0x0A && codePoint !== 0x0D)
					|| (codePoint >= 0x7F && codePoint <= 0x9F));
		})) {
			throw new Error('Binary workspace files cannot be displayed in Telegram.');
		}
		return {
			relativePath: normalizedPath,
			text,
			truncated: bytes.length > bounded.length,
		};
	}
}

function truncateUtf8Prefix(bytes: Uint8Array, maximumBytes: number): Uint8Array {
	if (bytes.length <= maximumBytes) {
		return bytes;
	}
	let end = maximumBytes;
	while (end > 0 && (bytes[end] & 0xC0) === 0x80) {
		end--;
	}
	return bytes.slice(0, end);
}

function resolveWorkspaceResource(workspaceRoot: string, relativePath: string): URI {
	if (!workspaceRoot || workspaceRoot.length > 4_096) {
		throw new Error('The workspace root is invalid.');
	}
	const root = URI.parse(workspaceRoot);
	const segments = relativePath ? relativePath.split('/') : [];
	return URI.joinPath(root, ...segments);
}

function normalizeRelativePath(value: string, allowEmpty: boolean): string {
	if (typeof value !== 'string' || value.length > maximumRelativePathLength || value.includes('\\') || value.startsWith('/')) {
		throw new Error('The workspace-relative path is invalid.');
	}
	if (!value) {
		if (allowEmpty) {
			return '';
		}
		throw new Error('A workspace-relative file path is required.');
	}
	const segments = value.split('/');
	if (segments.some(segment => !segment || segment === '.' || segment === '..' || segment.includes('\0'))) {
		throw new Error('The workspace-relative path is invalid.');
	}
	return segments.join('/');
}

function appendRelativePath(parent: string, name: string): string {
	if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\') || name.includes('\0')) {
		throw new Error('The workspace entry name is invalid.');
	}
	return normalizeRelativePath(parent ? `${parent}/${name}` : name, false);
}
